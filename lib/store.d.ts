/**
 * 桥插件持久化状态：单个 JSON 文件，原子写（tmp + rename）。
 * 移植自 AMClaw 的 SQLite 表设计，TS 版用 JSON 即可：
 * - dedup：消息去重（跨重启有效；cursor 不落盘，重启全靠它防重复回复）
 * - contextTokens：每用户最近的 context_token（没有它无法回复）
 * - allowedUserId / boundSessionId：白名单与会话绑定
 */
/** 内存去重上限（AMClaw MAX_SEEN_IDS / TRIM_SEEN_IDS_TO） */
export declare const MAX_SEEN_IDS = 1000;
export declare const TRIM_SEEN_IDS_TO = 500;
export declare class BridgeStore {
    private readonly path;
    private state;
    private readonly seenSet;
    private flushTimer;
    private dirty;
    constructor(path: string);
    private load;
    /** 去重判定 + 记录。已见过返回 true。 */
    checkAndMark(messageId: string): boolean;
    updateContextToken(userId: string, token: string): void;
    contextToken(userId: string): string | undefined;
    get allowedUserId(): string;
    setAllowedUserId(userId: string): void;
    get boundSessionId(): string;
    setBoundSessionId(sessionId: string): void;
    /** 合并窗口缓冲快照；空数组 = 删除 */
    setMergeBuffer(userId: string, buffer: string[]): void;
    mergeBuffers(): Record<string, string[]>;
    /** 防抖落盘（去重表高频写，500ms 合并一次） */
    private saveSoon;
    flush(): void;
}
