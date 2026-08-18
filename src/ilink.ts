/**
 * iLink（ilinkai.weixin.qq.com）协议客户端。
 * 协议细节移植自 AMClaw src/chat_adapter/ilink_client.rs：
 * - 响应字段全部多候选 fallback（qrcode/cursor/msgs/message_id 多命名）
 * - 错误判定是 ret!=0 || errcode!=0，不是 HTTP status
 * - 登录 confirmed 后服务端可下发新 baseurl，运行时切换
 */

export const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

export interface ILinkCredentials {
  botToken: string
  botId: string
  userId: string
}

export interface InboundMessage {
  messageId: string
  fromUserId: string
  contextToken?: string
  text: string
  createTimeMs?: number
}

export interface UpdatesPage {
  cursor: string
  messages: InboundMessage[]
}

/** get_qrcode_status 的返回（ret==1 是正常等待，不是错误） */
export type QRStatus =
  | { kind: 'wait' }
  | { kind: 'expired' }
  | { kind: 'confirmed'; credentials: ILinkCredentials; baseUrl?: string }

type Json = Record<string, unknown>

function pick(obj: Json, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

function pickStr(obj: Json, ...keys: string[]): string | undefined {
  const v = pick(obj, ...keys)
  return typeof v === 'string' ? v : v === undefined ? undefined : String(v)
}

/** message_id/msg_id 可能是 string/number/float/object，宽松归一化（AMClaw FlexibleId） */
export function normalizeId(v: unknown): string | undefined {
  if (typeof v === 'string') return v || undefined
  if (typeof v === 'number' && Number.isFinite(v)) return String(Math.trunc(v))
  if (v && typeof v === 'object') {
    const inner = pick(v as Json, 'id', 'value', 'str')
    if (inner !== undefined) return normalizeId(inner)
  }
  return undefined
}

/** 单条消息宽松解析；不是文本消息或无法解析返回 null（调用方跳过，不炸整个轮询） */
export function parseInbound(raw: unknown): InboundMessage | null {
  if (!raw || typeof raw !== 'object') return null
  let m = raw as Json
  // 支持嵌套一层 message
  if (m.message && typeof m.message === 'object') m = { ...m, ...(m.message as Json) }
  if (m.message_type !== undefined && Number(m.message_type) !== 1) return null
  const fromUserId = pickStr(m, 'from_user_id', 'from_user')
  if (!fromUserId) return null
  const parts: string[] = []
  if (typeof m.text === 'string') parts.push(m.text)
  if (Array.isArray(m.item_list)) {
    for (const item of m.item_list) {
      const t = (item as Json)?.text_item as Json | undefined
      if (t && typeof t.text === 'string') parts.push(t.text)
    }
  }
  const text = parts.join('').trim()
  if (!text) return null
  const messageId =
    normalizeId(m.message_id) ??
    normalizeId(m.msg_id) ??
    normalizeId(m.client_id) ??
    `${fromUserId}:${Number(m.create_time_ms ?? m.create_time ?? 0)}`
  const createTimeMs = Number(m.create_time_ms ?? m.create_time ?? 0) || undefined
  const contextToken = pickStr(m, 'context_token')
  return { messageId, fromUserId, contextToken, text, createTimeMs }
}

export class ILinkError extends Error {}

export class ILinkClient {
  baseUrl = ILINK_DEFAULT_BASE_URL
  /** 登录后才有 */
  botToken = ''
  private readonly uin: string

  constructor(randomUin?: string) {
    // X-WECHAT-UIN: base64(随机 u32 字符串)，每进程一个
    const u32 = randomUin ?? String(Math.floor(Math.random() * 0xffffffff))
    this.uin = Buffer.from(u32, 'utf8').toString('base64')
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'iLink-App-ClientVersion': '1',
      'X-WECHAT-UIN': this.uin,
    }
    if (this.botToken) {
      h['Authorization'] = `Bearer ${this.botToken}`
      h['AuthorizationType'] = 'ilink_bot_token'
    }
    return h
  }

  /**
   * 通用请求。ret!=0 || errcode!=0 抛 ILinkError。
   * tolerateRet1: get_qrcode_status 专用——ret==1 表示"等待中"，原样返回交给调用方判断。
   */
  private async request(
    path: string,
    init: { method?: string; body?: unknown; timeoutMs: number; tolerateRet1?: boolean },
  ): Promise<Json> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: this.headers(),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs),
    })
    if (!res.ok) throw new ILinkError(`${path} http ${res.status}`)
    const data = (await res.json()) as Json
    const ret = Number(data.ret ?? 0)
    const errcode = Number(data.errcode ?? 0)
    if (init.tolerateRet1 && ret === 1 && errcode === 0) return data
    if (ret !== 0 || errcode !== 0) {
      throw new ILinkError(`${path} ret=${ret} errcode=${errcode} errmsg=${String(data.errmsg ?? data.err_msg ?? '')}`)
    }
    return data
  }

  /** 取扫码二维码 */
  async getQRCode(timeoutMs = 15_000): Promise<{ qrcodeId: string; qrUrl: string }> {
    const data = await this.request('/ilink/bot/get_bot_qrcode?bot_type=3', { timeoutMs })
    const qrcodeId = pickStr(data, 'qrcode', 'qrcode_id')
    const qrUrl = pickStr(data, 'qrcode_img_content', 'qrcode_url', 'url')
    if (!qrcodeId || !qrUrl) throw new ILinkError('get_bot_qrcode: missing qrcode/url fields')
    return { qrcodeId, qrUrl }
  }

  /** 查一次扫码状态。该端点是长轮询（服务端挂起到状态变化或 ~35s），超时是常态，调用方静默重试 */
  async checkQRStatus(qrcodeId: string, timeoutMs = 40_000): Promise<QRStatus> {
    const data = await this.request(`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`, {
      timeoutMs,
      tolerateRet1: true,
    })
    const status = String(data.status ?? '')
    if (Number(data.ret ?? 0) === 0 && status === 'confirmed') {
      const botToken = pickStr(data, 'bot_token')
      const botId = pickStr(data, 'ilink_bot_id')
      const userId = pickStr(data, 'ilink_user_id')
      if (!botToken || !userId) throw new ILinkError('get_qrcode_status confirmed but missing token/user')
      const baseUrl = pickStr(data, 'baseurl', 'base_url')
      return { kind: 'confirmed', credentials: { botToken, botId: botId ?? '', userId }, baseUrl }
    }
    if (status === 'expired') return { kind: 'expired' }
    return { kind: 'wait' }
  }

  /** 长轮询收消息（调用方传超时，一般 70s） */
  async getUpdates(cursor: string, timeoutSecs: number): Promise<UpdatesPage> {
    const data = await this.request('/ilink/bot/getupdates', {
      body: { get_updates_buf: cursor, base_info: { channel_version: '1.0.0' } },
      timeoutMs: timeoutSecs * 1000 + 5_000,
    })
    const rawList = pick(data, 'msgs', 'messages', 'updates')
    const messages: InboundMessage[] = []
    if (Array.isArray(rawList)) {
      for (const raw of rawList) {
        try {
          const msg = parseInbound(raw)
          if (msg) messages.push(msg)
        } catch {
          // 单条解析失败跳过（AMClaw ingest.rs 同策略）
        }
      }
    }
    const next = pickStr(data, 'get_updates_buf', 'cursor', 'sync_buf') ?? cursor
    return { cursor: next, messages }
  }

  /** 发文本消息；context_token 必须为该用户最近一次入站消息带的 token */
  async sendMessage(toUserId: string, text: string, contextToken: string, clientId: string): Promise<void> {
    await this.request('/ilink/bot/sendmessage', {
      body: {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text } }],
        },
        base_info: { channel_version: '1.0.0' },
      },
      timeoutMs: 15_000,
    })
  }
}
