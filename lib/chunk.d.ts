/**
 * 微信长回复分段（移植自 AMClaw src/chat_adapter/delivery.rs）。
 * - 按 Unicode 码点计数（不是字节、不是 UTF-16 单元）
 * - 分段前缀是全角括号 `（i/n）`，前缀长度参与段数递归收敛（最多 5 次）
 * - 无法收敛时退化为无前缀硬切；硬切点是任意码点边界，不智能断词
 */
/**
 * 把 text 拆成带 `（i/n）` 前缀的段，每段总长（含前缀）<= maxChars 码点。
 * 单段能放下时不加前缀。
 */
export declare function splitReply(text: string, maxChars: number): string[];
