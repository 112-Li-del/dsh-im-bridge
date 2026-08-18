/**
 * 桥插件持久化状态：单个 JSON 文件，原子写（tmp + rename）。
 * 移植自 AMClaw 的 SQLite 表设计，TS 版用 JSON 即可：
 * - dedup：消息去重（跨重启有效；cursor 不落盘，重启全靠它防重复回复）
 * - contextTokens：每用户最近的 context_token（没有它无法回复）
 * - allowedUserId / boundSessionId：白名单与会话绑定
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 内存去重上限（AMClaw MAX_SEEN_IDS / TRIM_SEEN_IDS_TO） */
export const MAX_SEEN_IDS = 1000
export const TRIM_SEEN_IDS_TO = 500

interface StateShape {
  /** 已见消息 id，按插入序；持久化保序 */
  seenIds: string[]
  /** userId -> context_token */
  contextTokens: Record<string, { token: string; updatedAt: number }>
  /** 白名单用户（空 = 未绑定，首个扫码确认用户自动填入） */
  allowedUserId: string
  /** /bind 绑定的 DSH session id（空 = 最近活跃会话） */
  boundSessionId: string
  /** 合并窗口缓冲快照（崩溃恢复；flush 后删除） */
  mergeBuffers: Record<string, string[]>
}

const emptyState = (): StateShape => ({
  seenIds: [],
  contextTokens: {},
  allowedUserId: '',
  boundSessionId: '',
  mergeBuffers: {},
})

export class BridgeStore {
  private state: StateShape
  private readonly seenSet: Set<string>
  private flushTimer: NodeJS.Timeout | undefined
  private dirty = false

  constructor(private readonly path: string) {
    this.state = this.load()
    this.seenSet = new Set(this.state.seenIds)
  }

  private load(): StateShape {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StateShape>
      // 逐字段回退，不能共享引用（空数组/对象被多实例共享会互相污染）
      const base = emptyState()
      if (Array.isArray(raw.seenIds)) base.seenIds = raw.seenIds
      if (raw.contextTokens && typeof raw.contextTokens === 'object') base.contextTokens = raw.contextTokens
      if (typeof raw.allowedUserId === 'string') base.allowedUserId = raw.allowedUserId
      if (typeof raw.boundSessionId === 'string') base.boundSessionId = raw.boundSessionId
      if (raw.mergeBuffers && typeof raw.mergeBuffers === 'object') base.mergeBuffers = raw.mergeBuffers
      return base
    } catch {
      // 文件不存在或损坏：从空状态开始（损坏时宁可重来也不崩）
      return emptyState()
    }
  }

  /** 去重判定 + 记录。已见过返回 true。 */
  checkAndMark(messageId: string): boolean {
    if (this.seenSet.has(messageId)) return true
    this.seenSet.add(messageId)
    this.state.seenIds.push(messageId)
    if (this.state.seenIds.length > MAX_SEEN_IDS) {
      const drop = this.state.seenIds.splice(0, this.state.seenIds.length - TRIM_SEEN_IDS_TO)
      for (const id of drop) this.seenSet.delete(id)
    }
    this.saveSoon()
    return false
  }

  updateContextToken(userId: string, token: string): void {
    this.state.contextTokens[userId] = { token, updatedAt: Date.now() }
    this.saveSoon()
  }

  contextToken(userId: string): string | undefined {
    return this.state.contextTokens[userId]?.token
  }

  get allowedUserId(): string {
    return this.state.allowedUserId
  }

  setAllowedUserId(userId: string): void {
    this.state.allowedUserId = userId
    this.saveSoon()
  }

  get boundSessionId(): string {
    return this.state.boundSessionId
  }

  setBoundSessionId(sessionId: string): void {
    this.state.boundSessionId = sessionId
    this.saveSoon()
  }

  /** 合并窗口缓冲快照；空数组 = 删除 */
  setMergeBuffer(userId: string, buffer: string[]): void {
    if (buffer.length === 0) delete this.state.mergeBuffers[userId]
    else this.state.mergeBuffers[userId] = buffer
    this.saveSoon()
  }

  mergeBuffers(): Record<string, string[]> {
    return { ...this.state.mergeBuffers }
  }

  /** 防抖落盘（去重表高频写，500ms 合并一次） */
  private saveSoon(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flush(), 500)
    this.flushTimer.unref?.()
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    if (!this.dirty) return
    this.dirty = false
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state))
    renameSync(tmp, this.path)
  }
}
