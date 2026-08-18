/**
 * 消息合并窗口（移植自 AMClaw src/session_router.rs + command_router 的聊天控制）。
 * - `<text>..` 后缀：还有后续，入缓冲不触发（ChatContinue）
 * - `<text>!!` 后缀：说完了，入缓冲并立即 flush（ChatCommit）
 * - 裸文本：入缓冲，mergeTimeoutMs 超时后整体 flush
 * - 裸 `..` / `!!`（去掉后缀为空）：忽略
 * 缓冲内容用 "\n" join。实现用每用户一个 timer（TS 侧比 AMClaw 的主循环扫描更直接）。
 */
export type MergeAction = {
    kind: 'buffered';
} | {
    kind: 'ignored';
} | {
    kind: 'flush';
    text: string;
};
export interface MergerOptions {
    mergeTimeoutMs: number;
    /** flush 回调（超时触发）；立即 flush 由 ingest 同步返回 */
    onTimeoutFlush: (userId: string, text: string) => void;
    /** 缓冲快照持久化（崩溃恢复）；flush 后传空数组表示删除 */
    onSnapshot: (userId: string, buffer: string[]) => void;
}
/** 剥后缀判定：`..`/`!!` 后缀（在 trim 之后判断） */
export declare function chatControl(text: string): {
    kind: 'continue' | 'commit' | 'pending' | 'ignore';
    body: string;
};
export declare class SessionMerger {
    private readonly opts;
    private buffers;
    private timers;
    constructor(opts: MergerOptions);
    /**
     * 入队一条文本。返回 flush 时同步给出合并文本（`!!` 立即）；
     * 超时 flush 走 onTimeoutFlush 回调异步给出。
     */
    ingest(userId: string, text: string): MergeAction;
    /** 恢复崩溃前快照（启动时调用）：last_update=now，超时后会被 flush */
    restore(userId: string, buffer: string[]): void;
    private rearm;
    private drain;
    dispose(): void;
}
