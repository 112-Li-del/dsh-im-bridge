/**
 * 待批准请求的应答经纪：微信回复「批准/拒绝」→ waterfall 监听器的等待结果。
 * v0.1 单 pending（批准本来就是串行的）；超时/撤销返回 undefined，由调用方 next() 委托下游。
 */
export declare class ApprovalBroker {
    private pending;
    get hasPending(): boolean;
    /**
     * 挂起一个批准请求，等待微信答复。
     * 已有 pending 时立即返回 undefined（不排队，直接委托下游 answerer）。
     * signal 中止（提问方撤回）也返回 undefined。
     */
    wait(timeoutMs: number, signal?: AbortSignal): Promise<'allow' | 'reject' | undefined>;
    /** 微信侧答复。没有 pending 返回 false。 */
    answer(allow: boolean): boolean;
}
