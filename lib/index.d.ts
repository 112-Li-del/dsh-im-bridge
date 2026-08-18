import type { Context } from '@deepseek-ai/cordis';
declare module '@deepseek-ai/dsh-jobs' {
    interface JobKindMap {
        'im-bridge': 'im-bridge';
    }
}
export declare const name = "dsh-im-bridge";
export interface Config {
    /** 白名单微信用户 id（ilink_user_id）。空 = 首个扫码确认的用户自动绑定 */
    allowedUserId?: string;
    /** 消息合并窗口（秒），对应 AMClaw 的 merge_timeout */
    mergeTimeoutSecs?: number;
    /** 长回复分段长度（Unicode 码点） */
    chunkMaxChars?: number;
    /** iLink 长轮询超时（秒） */
    pollTimeoutSecs?: number;
    /** 批准请求等待微信答复的超时（秒），超时后委托下游 answerer（如 web UI） */
    approvalTimeoutSecs?: number;
    /** 状态文件路径（去重表/context_token/白名单/绑定会话/合并缓冲） */
    statePath?: string;
}
export declare const inject: string[];
export declare function apply(ctx: Context, config?: Config): void;
