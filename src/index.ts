import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import QRCode from 'qrcode'
// 事件/服务类型声明合并（session/event、approval/request、ctx.jobs/agents/sessions）
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'
import { ApprovalBroker } from './approval.js'
import { reply, runBridgeLoop, type BridgeLogger, type BridgeOptions } from './bridge.js'
import { ILinkClient } from './ilink.js'
import { SessionMerger } from './merge.js'
import { routeText } from './router.js'
import { BridgeStore } from './store.js'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'im-bridge': 'im-bridge'
  }
}

export const name = 'dsh-im-bridge'

export interface Config {
  /** 白名单微信用户 id（ilink_user_id）。空 = 首个扫码确认的用户自动绑定 */
  allowedUserId?: string
  /** 消息合并窗口（秒），对应 AMClaw 的 merge_timeout */
  mergeTimeoutSecs?: number
  /** 长回复分段长度（Unicode 码点） */
  chunkMaxChars?: number
  /** iLink 长轮询超时（秒） */
  pollTimeoutSecs?: number
  /** 批准请求等待微信答复的超时（秒），超时后委托下游 answerer（如 web UI） */
  approvalTimeoutSecs?: number
  /** 状态文件路径（去重表/context_token/白名单/绑定会话/合并缓冲） */
  statePath?: string
}

export const inject = ['agents', 'jobs', 'sessions']

/** 推送会附带最后一条 assistant 文本时的截断长度（码点） */
const LAST_TEXT_SNIPPET_CHARS = 600
/** 合并后文本达到该长度时先回"收到，处理中"（AMClaw LONG_INPUT_ACK_CHARS） */
const LONG_INPUT_ACK_CHARS = 180

export function apply(ctx: Context, config: Config = {}): void {
  const cfg = {
    allowedUserId: config.allowedUserId ?? '',
    mergeTimeoutSecs: config.mergeTimeoutSecs ?? 5,
    chunkMaxChars: config.chunkMaxChars ?? 1200,
    pollTimeoutSecs: config.pollTimeoutSecs ?? 70,
    approvalTimeoutSecs: config.approvalTimeoutSecs ?? 120,
    statePath:
      config.statePath ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-im-bridge', 'state.json'),
  }

  // 根作用域挂 controller，jobs.start 的 preflight 要求（"no job controller serves this agent"）
  ctx.effect(() => ctx.jobs.attachController(name))

  // 状态行环形缓冲：web 里 ctx.logger 不上 stdout，靠 job readOutput 暴露 QR/登录状态
  const recent: string[] = []
  const rawLog = ctx.logger(name)
  const pushLine = (line: string) => {
    recent.push(`${new Date().toISOString()} ${line}`)
    if (recent.length > 200) recent.splice(0, recent.length - 200)
  }
  const log: BridgeLogger = {
    debug: (m, ...a) => rawLog.debug(m, ...a),
    info: (m, ...a) => {
      pushLine(`INFO ${m}`)
      rawLog.info(m, ...a)
    },
    warn: (m, ...a) => {
      pushLine(`WARN ${m} ${a.map(String).join(' ')}`)
      rawLog.warn(m, ...a)
    },
  }

  const store = new BridgeStore(cfg.statePath)
  if (cfg.allowedUserId && store.allowedUserId !== cfg.allowedUserId) {
    store.setAllowedUserId(cfg.allowedUserId)
    store.flush()
  }

  // HTTP 路由：给 web UI（侧边栏二维码按钮）提供登录二维码图片与状态。
  // 用 ctx.inject(['webServer']) 确保服务就绪后再注册（headless 等无 webServer 的组合则跳过）
  const stateDir = dirname(cfg.statePath)
  ctx.inject(['webServer'], (wsCtx) => {
    const webServer = wsCtx.webServer
    const qrRoute: WebRoute = {
      kind: 'exact',
      path: '/dsh-im-bridge/qr.png',
      handler: async (_req, res) => {
        try {
          const data = readFileSync(join(stateDir, 'login-qr.png'))
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
          res.end(data)
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('login QR not ready yet')
        }
      },
    }
    webServer.register(qrRoute)
    const statusRoute: WebRoute = {
      kind: 'exact',
      path: '/dsh-im-bridge/status.json',
      handler: async (_req, res) => {
        const qrPath = join(stateDir, 'login-qr.png')
        let qrUpdatedAt: number | null = null
        try {
          qrUpdatedAt = statSync(qrPath).mtimeMs
        } catch { /* 二维码还没生成 */ }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({
          loggedIn: store.allowedUserId !== '',
          qrReady: qrUpdatedAt !== null,
          qrUpdatedAt,
          allowedUserId: store.allowedUserId || null,
        }))
      },
    }
    webServer.register(statusRoute)
    // 诊断标记：确认路由注册成功
    try {
      writeFileSync(join(stateDir, 'routes-registered.txt'), String(Date.now()))
    } catch { /* 忽略 */ }
  })

  const broker = new ApprovalBroker()
  const client = new ILinkClient()
  const bridgeOpts: BridgeOptions = {
    client,
    store,
    log,
    pollTimeoutSecs: cfg.pollTimeoutSecs,
    chunkMaxChars: cfg.chunkMaxChars,
    onMessage: async () => undefined, // 真正处理器在下方赋值（闭环依赖 pushToWechat）
    // 登录链接落盘：web 里 logger 不上 stdout，用户 cat 这个文件拿二维码
    onQRCode: (qrUrl) => {
      try {
        mkdirSync(dirname(cfg.statePath), { recursive: true })
        writeFileSync(join(dirname(cfg.statePath), 'login-url.txt'), `${qrUrl}\n`)
        // 同时生成二维码图片（微信「扫一扫」直接扫；每次刷新自动更新）
        QRCode.toFile(join(dirname(cfg.statePath), 'login-qr.png'), qrUrl, { width: 400, margin: 2 })
          .then(() => log.info('已生成登录二维码图片: login-qr.png（微信扫一扫即可登录）'))
          .catch((err) => log.warn('login-qr.png 生成失败:', err))
      } catch (err) {
        log.warn('login 文件写入失败:', err)
      }
    },
  }

  /** 当前绑定会话：显式 /bind 优先，否则跟随最近活跃会话 */
  let lastActiveSessionId = ''
  const boundSessionId = (): string => store.boundSessionId || lastActiveSessionId

  /** 推送到微信（只能发给白名单用户；没有 context_token 时只能记日志） */
  const pushToWechat = async (text: string): Promise<void> => {
    const userId = store.allowedUserId
    if (!userId) {
      log.warn('推送跳过：尚未绑定白名单用户')
      return
    }
    await reply(bridgeOpts, userId, text, undefined)
  }

  /** 从会话日志取最后一条 assistant 文本（截断） */
  const lastAssistantText = (session: Session): string => {
    for (const ev of [...session.events].reverse()) {
      if (ev.type !== 'assistant/message') continue
      const text = ev.data.message.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('')
        .trim()
      if (text) return [...text].slice(0, LAST_TEXT_SNIPPET_CHARS).join('')
    }
    return ''
  }

  const TURN_END_LABEL: Record<string, string> = {
    completed: '✅ 完成',
    error: '❌ 出错',
    aborted: '⏹ 已中止',
    blocked: '🚫 被阻塞',
    'max-tokens': '↯ 达到 token 上限',
    interrupted: '⏸ 被打断',
  }

  // DSH → 微信：turn/end 推送（只推绑定会话，免打扰）
  ctx.on(
    'session/event',
    (session, event) => {
      lastActiveSessionId = String(session.id)
      if (event.type !== 'turn/end') return
      if (String(session.id) !== boundSessionId()) return
      const label = TURN_END_LABEL[event.data.reason.kind] ?? event.data.reason.kind
      const snippet = lastAssistantText(session)
      void pushToWechat(
        `[${label}] 会话 ${String(session.id)} 第 ${event.data.turn} 轮结束` + (snippet ? `\n${snippet}` : ''),
      ).catch((err) => log.warn('turn/end 推送失败:', err))
    },
    { global: true },
  )

  // DSH → 微信：批准请求推送 + 等待微信答复（waterfall，必须委托 next()）
  ctx.on(
    'approval/request',
    async (req, next) => {
      // 未绑定白名单用户（没扫码）时不拦截，直接回本机批准体系——否则 headless 会被 120s 等待卡住
      if (!store.allowedUserId) return next()
      if (String(req.agent.session.id) !== boundSessionId()) return next()
      await pushToWechat(
        `⚠️ 批准请求\n工具：${req.toolName}\n原因：${req.reason ?? '（未给出）'}\n回复「批准」或「拒绝」（${cfg.approvalTimeoutSecs}s 内有效，超时转回本机批准体系）`,
      ).catch((err) => log.warn('approval 推送失败:', err))
      const verdict = await broker.wait(cfg.approvalTimeoutSecs * 1000, req.signal)
      if (verdict === 'allow') return 'allowed-once'
      if (verdict === 'reject') return 'rejected'
      return next() // 超时/撤销/并发：委托下游 answerer
    },
    { global: true },
  )

  /** 微信文本注入绑定会话，返回给用户的回执文本 */
  const injectToSession = async (text: string): Promise<string> => {
    const sid = boundSessionId()
    if (!sid) return '还没有活跃会话。请先在 DSH 里开始一个任务，或用 /bind <session-id> 绑定。'
    const agent = ctx.agents.get(sid as SessionId)
    if (!agent) return `会话 ${sid} 当前没有运行中的 agent，无法注入。`
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: name, form: 'relay' },
      }),
    )
    log.info(`微信消息已注入会话 ${sid}`)
    return text.length >= LONG_INPUT_ACK_CHARS ? '收到，处理中，稍后给你完整回复。' : ''
  }

  const merger = new SessionMerger({
    mergeTimeoutMs: cfg.mergeTimeoutSecs * 1000,
    onSnapshot: (userId, buf) => store.setMergeBuffer(userId, buf),
    onTimeoutFlush: (userId, text) => {
      void injectToSession(text).then(async (ack) => {
        if (ack) await pushToWechat(ack)
      })
    },
  })
  // 崩溃恢复：重启后把未 flush 的缓冲恢复（last_update=now，超时后即注入）
  for (const [userId, buf] of Object.entries(store.mergeBuffers())) merger.restore(userId, buf)

  const HELP = [
    '可用命令：',
    '/bind <session-id> 绑定会话；/unbind 解绑（跟随最近活跃）',
    '/status 查看状态；/help 本帮助',
    '批准 / 拒绝 —— 应答待批准请求',
    '普通文本直接注入绑定会话；结尾 .. 表示还有后续，!! 表示立即提交',
  ].join('\n')

  bridgeOpts.onMessage = async (msg) => {
    const r = routeText(msg.text)
    switch (r.kind) {
      case 'approve':
        return broker.answer(true) ? '已批准 ✅' : '当前没有待批准的请求。'
      case 'reject':
        return broker.answer(false) ? '已拒绝 ❌' : '当前没有待批准的请求。'
      case 'bind': {
        const s = ctx.sessions.get(r.sessionId as SessionId)
        if (!s) return `会话 ${r.sessionId} 不存在（当前活跃：${lastActiveSessionId || '无'}）。`
        store.setBoundSessionId(r.sessionId)
        store.flush()
        return `已绑定会话 ${r.sessionId}。`
      }
      case 'unbind':
        store.setBoundSessionId('')
        store.flush()
        return '已解绑，将跟随最近活跃会话。'
      case 'status':
        return [
          `绑定会话：${boundSessionId() || '（无）'}`,
          `最近活跃：${lastActiveSessionId || '（无）'}`,
          `待批准：${broker.hasPending ? '有' : '无'}`,
          `白名单用户：${store.allowedUserId}`,
        ].join('\n')
      case 'help':
        return HELP
      case 'chat': {
        const action = merger.ingest(msg.fromUserId, r.text)
        if (action.kind === 'flush') return injectToSession(action.text)
        return undefined // buffered / ignored：无回执
      }
    }
  }

  ctx.jobs.start({
    kind: 'im-bridge',
    label: 'iLink 微信长轮询',
    run: () => {
      const abort = new AbortController()
      const done = runBridgeLoop(bridgeOpts, abort.signal).then(
        (): { status: 'completed' } => ({ status: 'completed' }),
        (err): { status: 'failed'; detail: string } => ({ status: 'failed', detail: String(err) }),
      )
      return {
        cancel: () => {
          abort.abort()
          merger.dispose()
        },
        done,
        readOutput: () => recent.splice(0).join('\n'),
      }
    },
  })

  log.info('dsh-im-bridge loaded', cfg)
}
