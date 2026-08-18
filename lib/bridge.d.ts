/**
 * 桥主循环：iLink 扫码登录 + 长轮询收消息 + 回复发送。
 * 移植自 AMClaw src/chat_adapter/mod.rs：
 * - 登录：取二维码 → 2s 轮询状态 → confirmed 后切换 baseurl（如下发）
 * - 轮询错误：超时静默 continue，其他错误记日志 + 固定 5s 重试（无指数退避）
 * - 去重：持久去重表（cursor 不落盘，重启靠它兜底）
 * - 回复：没有 context_token 不回复；长文本按 1200 码点分段，某段失败即停（防乱序）
 */
import { ILinkClient, type InboundMessage } from './ilink.js';
import type { BridgeStore } from './store.js';
export interface BridgeLogger {
    debug(msg: string, ...args: unknown[]): void;
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
}
export interface BridgeOptions {
    client: ILinkClient;
    store: BridgeStore;
    log: BridgeLogger;
    pollTimeoutSecs: number;
    chunkMaxChars: number;
    /** 收到白名单用户消息后的处理器，返回回复文本；undefined = 不回复 */
    onMessage: (msg: InboundMessage) => Promise<string | undefined>;
    /** 每次取到新二维码时回调（用于把登录链接落到用户可见处） */
    onQRCode?: (qrUrl: string) => void;
}
/** 登录直到 confirmed 或 signal 中止；二维码过期自动重取。返回是否成功登录 */
export declare function login(opts: BridgeOptions, signal: AbortSignal): Promise<boolean>;
/** 回复一个用户：分段按序发送，某段失败即停（剩余丢弃并告警；M 后续可接补发队列） */
export declare function reply(opts: BridgeOptions, toUserId: string, text: string, contextToken: string | undefined): Promise<void>;
/** 主循环：登录 → 长轮询 → 分发给 onMessage → 回复。signal 中止时返回 */
export declare function runBridgeLoop(opts: BridgeOptions, signal: AbortSignal): Promise<void>;
