/**
 * iLink（ilinkai.weixin.qq.com）协议客户端。
 * 协议细节移植自 AMClaw src/chat_adapter/ilink_client.rs：
 * - 响应字段全部多候选 fallback（qrcode/cursor/msgs/message_id 多命名）
 * - 错误判定是 ret!=0 || errcode!=0，不是 HTTP status
 * - 登录 confirmed 后服务端可下发新 baseurl，运行时切换
 */
export declare const ILINK_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export interface ILinkCredentials {
    botToken: string;
    botId: string;
    userId: string;
}
export interface InboundMessage {
    messageId: string;
    fromUserId: string;
    contextToken?: string;
    text: string;
    createTimeMs?: number;
}
export interface UpdatesPage {
    cursor: string;
    messages: InboundMessage[];
}
/** get_qrcode_status 的返回（ret==1 是正常等待，不是错误） */
export type QRStatus = {
    kind: 'wait';
} | {
    kind: 'expired';
} | {
    kind: 'confirmed';
    credentials: ILinkCredentials;
    baseUrl?: string;
};
/** message_id/msg_id 可能是 string/number/float/object，宽松归一化（AMClaw FlexibleId） */
export declare function normalizeId(v: unknown): string | undefined;
/** 单条消息宽松解析；不是文本消息或无法解析返回 null（调用方跳过，不炸整个轮询） */
export declare function parseInbound(raw: unknown): InboundMessage | null;
export declare class ILinkError extends Error {
}
export declare class ILinkClient {
    baseUrl: string;
    /** 登录后才有 */
    botToken: string;
    private readonly uin;
    constructor(randomUin?: string);
    private headers;
    /**
     * 通用请求。ret!=0 || errcode!=0 抛 ILinkError。
     * tolerateRet1: get_qrcode_status 专用——ret==1 表示"等待中"，原样返回交给调用方判断。
     */
    private request;
    /** 取扫码二维码 */
    getQRCode(timeoutMs?: number): Promise<{
        qrcodeId: string;
        qrUrl: string;
    }>;
    /** 查一次扫码状态。该端点是长轮询（服务端挂起到状态变化或 ~35s），超时是常态，调用方静默重试 */
    checkQRStatus(qrcodeId: string, timeoutMs?: number): Promise<QRStatus>;
    /** 长轮询收消息（调用方传超时，一般 70s） */
    getUpdates(cursor: string, timeoutSecs: number): Promise<UpdatesPage>;
    /** 发文本消息；context_token 必须为该用户最近一次入站消息带的 token */
    sendMessage(toUserId: string, text: string, contextToken: string, clientId: string): Promise<void>;
}
