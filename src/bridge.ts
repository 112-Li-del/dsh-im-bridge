/**
 * 桥主循环：iLink 扫码登录 + 长轮询收消息 + 回复发送。
 * 移植自 AMClaw src/chat_adapter/mod.rs：
 * - 登录：取二维码 → 2s 轮询状态 → confirmed 后切换 baseurl（如下发）
 * - 轮询错误：超时静默 continue，其他错误记日志 + 固定 5s 重试（无指数退避）
 * - 去重：持久去重表（cursor 不落盘，重启靠它兜底）
 * - 回复：没有 context_token 不回复；长文本按 1200 码点分段，某段失败即停（防乱序）
 */

import { randomUUID } from 'node:crypto'
import { splitReply } from './chunk.js'
import { ILinkClient, type InboundMessage } from './ilink.js'
import type { BridgeStore } from './store.js'

export interface BridgeLogger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
}

export interface BridgeOptions {
  client: ILinkClient
  store: BridgeStore
  log: BridgeLogger
  pollTimeoutSecs: number
  chunkMaxChars: number
  /** 收到白名单用户消息后的处理器，返回回复文本；undefined = 不回复 */
  onMessage: (msg: InboundMessage) => Promise<string | undefined>
  /** 每次取到新二维码时回调（用于把登录链接落到用户可见处） */
  onQRCode?: (qrUrl: string) => void
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(t)
      resolve()
    }
    if (signal.aborted) {
      clearTimeout(t)
      resolve()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 登录直到 confirmed 或 signal 中止；二维码过期自动重取。返回是否成功登录 */
export async function login(opts: BridgeOptions, signal: AbortSignal): Promise<boolean> {
  const { client, store, log } = opts
  while (!signal.aborted) {
    let qr
    try {
      qr = await client.getQRCode()
    } catch (err) {
      log.warn('ilink 获取二维码失败，5s 后重试:', err)
      await sleep(5_000, signal)
      continue
    }
    log.warn(`dsh-im-bridge: 请用微信扫码登录（2s 轮询等待确认）: ${qr.qrUrl}`)
    opts.onQRCode?.(qr.qrUrl)
    while (!signal.aborted) {
      let st
      try {
        st = await client.checkQRStatus(qr.qrcodeId)
      } catch (err) {
        // 长轮询端点：超时是常态，静默重试；其他错误记日志后 2s 重试
        if (!isTimeout(err)) log.warn('ilink 查询扫码状态失败，2s 后重试:', err)
        await sleep(2_000, signal)
        continue
      }
      if (st.kind === 'wait') {
        await sleep(2_000, signal)
        continue
      }
      if (st.kind === 'expired') {
        log.warn('dsh-im-bridge: 二维码已过期，重新获取')
        break
      }
      // confirmed
      client.botToken = st.credentials.botToken
      if (st.baseUrl) {
        log.info(`ilink 服务端下发新 baseurl: ${st.baseUrl}`)
        client.baseUrl = st.baseUrl
      }
      const userId = st.credentials.userId
      if (!store.allowedUserId) {
        store.setAllowedUserId(userId)
        store.flush()
        log.warn(`dsh-im-bridge: 已绑定白名单用户 ${userId}（仅该用户可驱动）`)
      } else if (store.allowedUserId !== userId) {
        log.warn(`dsh-im-bridge: 扫码用户 ${userId} 不在白名单（白名单=${store.allowedUserId}），消息将被忽略`)
      }
      return true
    }
  }
  return false
}

/** 回复一个用户：分段按序发送，某段失败即停（剩余丢弃并告警；M 后续可接补发队列） */
export async function reply(
  opts: BridgeOptions,
  toUserId: string,
  text: string,
  contextToken: string | undefined,
): Promise<void> {
  const { client, store, log, chunkMaxChars } = opts
  const token = contextToken ?? store.contextToken(toUserId)
  if (!token) {
    log.warn(`ilink 回复跳过：没有 ${toUserId} 的 context_token`)
    return
  }
  for (const part of splitReply(text, chunkMaxChars)) {
    try {
      await client.sendMessage(toUserId, part, token, `dsh-im-bridge:${randomUUID()}`)
    } catch (err) {
      log.warn(`ilink 分段发送失败（剩余段停止，防乱序）:`, err)
      return
    }
  }
}

/** 主循环：登录 → 长轮询 → 分发给 onMessage → 回复。signal 中止时返回 */
export async function runBridgeLoop(opts: BridgeOptions, signal: AbortSignal): Promise<void> {
  const { client, store, log, pollTimeoutSecs } = opts
  // 外层循环：登录成功后轮询；连接失效（连续错误）时自动重新进入扫码登录（自愈）
  while (!signal.aborted) {
    if (!(await login(opts, signal))) return
    log.info('dsh-im-bridge: 登录完成，开始长轮询')

    let cursor = ''
    let consecutiveErrors = 0
    let connectionLost = false
    while (!signal.aborted) {
      let page
      try {
        page = await client.getUpdates(cursor, pollTimeoutSecs)
      } catch (err) {
        if (signal.aborted) return
        if (isTimeout(err)) continue // 长轮询超时静默继续
        consecutiveErrors += 1
        // 令牌过期/会话失效会让 getUpdates 持续报错：连续失败达到阈值即重新扫码
        if (consecutiveErrors >= 5) {
          log.warn('dsh-im-bridge: 长轮询连续失败，连接可能已失效，重新进入扫码登录流程（新二维码已生成，请重新扫码）')
          connectionLost = true
          break
        }
        log.warn('ilink 长轮询失败，5s 后重试:', err)
        await sleep(5_000, signal)
        continue
      }
      consecutiveErrors = 0
      cursor = page.cursor
      for (const msg of page.messages) {
        if (signal.aborted) return
        try {
          if (store.checkAndMark(msg.messageId)) continue
          if (msg.contextToken) store.updateContextToken(msg.fromUserId, msg.contextToken)
          if (msg.fromUserId !== store.allowedUserId) {
            log.warn(`ilink 忽略非白名单用户消息: ${msg.fromUserId}`)
            continue
          }
          const out = await opts.onMessage(msg)
          if (out !== undefined) await reply(opts, msg.fromUserId, out, msg.contextToken)
        } catch (err) {
          log.warn('ilink 消息处理失败（跳过该条）:', err)
        }
      }
    }
    if (signal.aborted) return
    if (!connectionLost) break
    // connectionLost → 回到外层循环重新 login()（login 内部会重新取二维码并写 login-qr.png）
  }
}
