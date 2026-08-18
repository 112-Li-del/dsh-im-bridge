/**
 * 待批准请求的应答经纪：微信回复「批准/拒绝」→ waterfall 监听器的等待结果。
 * v0.1 单 pending（批准本来就是串行的）；超时/撤销返回 undefined，由调用方 next() 委托下游。
 */
export class ApprovalBroker {
  private pending:
    | {
        resolve: (v: 'allow' | 'reject' | undefined) => void
        timer: NodeJS.Timeout
      }
    | undefined

  get hasPending(): boolean {
    return this.pending !== undefined
  }

  /**
   * 挂起一个批准请求，等待微信答复。
   * 已有 pending 时立即返回 undefined（不排队，直接委托下游 answerer）。
   * signal 中止（提问方撤回）也返回 undefined。
   */
  wait(timeoutMs: number, signal?: AbortSignal): Promise<'allow' | 'reject' | undefined> {
    if (this.pending) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const settle = (v: 'allow' | 'reject' | undefined) => {
        if (!this.pending) return
        clearTimeout(this.pending.timer)
        this.pending = undefined
        resolve(v)
      }
      const timer = setTimeout(() => settle(undefined), timeoutMs)
      timer.unref?.()
      this.pending = { resolve: settle, timer }
      signal?.addEventListener('abort', () => settle(undefined), { once: true })
    })
  }

  /** 微信侧答复。没有 pending 返回 false。 */
  answer(allow: boolean): boolean {
    if (!this.pending) return false
    this.pending.resolve(allow ? 'allow' : 'reject')
    return true
  }
}
