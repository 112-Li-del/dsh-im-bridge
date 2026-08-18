/**
 * 消息合并窗口（移植自 AMClaw src/session_router.rs + command_router 的聊天控制）。
 * - `<text>..` 后缀：还有后续，入缓冲不触发（ChatContinue）
 * - `<text>!!` 后缀：说完了，入缓冲并立即 flush（ChatCommit）
 * - 裸文本：入缓冲，mergeTimeoutMs 超时后整体 flush
 * - 裸 `..` / `!!`（去掉后缀为空）：忽略
 * 缓冲内容用 "\n" join。实现用每用户一个 timer（TS 侧比 AMClaw 的主循环扫描更直接）。
 */
/** 剥后缀判定：`..`/`!!` 后缀（在 trim 之后判断） */
export function chatControl(text) {
    const t = text.trim();
    if (t.endsWith('..')) {
        const body = t.slice(0, -2).trim();
        return body ? { kind: 'continue', body } : { kind: 'ignore', body: '' };
    }
    if (t.endsWith('!!')) {
        const body = t.slice(0, -2).trim();
        return body ? { kind: 'commit', body } : { kind: 'ignore', body: '' };
    }
    return { kind: 'pending', body: t };
}
export class SessionMerger {
    opts;
    buffers = new Map();
    timers = new Map();
    constructor(opts) {
        this.opts = opts;
    }
    /**
     * 入队一条文本。返回 flush 时同步给出合并文本（`!!` 立即）；
     * 超时 flush 走 onTimeoutFlush 回调异步给出。
     */
    ingest(userId, text) {
        const ctl = chatControl(text);
        if (ctl.kind === 'ignore')
            return { kind: 'ignored' };
        const buf = this.buffers.get(userId) ?? [];
        buf.push(ctl.body);
        this.buffers.set(userId, buf);
        this.opts.onSnapshot(userId, [...buf]);
        if (ctl.kind === 'commit') {
            return { kind: 'flush', text: this.drain(userId) };
        }
        this.rearm(userId);
        return { kind: 'buffered' };
    }
    /** 恢复崩溃前快照（启动时调用）：last_update=now，超时后会被 flush */
    restore(userId, buffer) {
        if (buffer.length === 0)
            return;
        this.buffers.set(userId, [...buffer]);
        this.rearm(userId);
    }
    rearm(userId) {
        const old = this.timers.get(userId);
        if (old)
            clearTimeout(old);
        const t = setTimeout(() => {
            const text = this.drain(userId);
            if (text)
                this.opts.onTimeoutFlush(userId, text);
        }, this.opts.mergeTimeoutMs);
        t.unref?.();
        this.timers.set(userId, t);
    }
    drain(userId) {
        const t = this.timers.get(userId);
        if (t)
            clearTimeout(t);
        this.timers.delete(userId);
        const buf = this.buffers.get(userId) ?? [];
        this.buffers.delete(userId);
        if (buf.length > 0)
            this.opts.onSnapshot(userId, []);
        return buf.join('\n');
    }
    dispose() {
        for (const t of this.timers.values())
            clearTimeout(t);
        this.timers.clear();
        this.buffers.clear();
    }
}
