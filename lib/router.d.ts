/**
 * 微信入站文本的命令路由（先 trim 再匹配；命令均为精确/前缀匹配，正文不误判）。
 * `..`/`!!` 后缀与超时合并不在这里——那是 SessionMerger 的职责（chat 分支原样透传）。
 */
export type RouteResult = {
    kind: 'approve';
} | {
    kind: 'reject';
} | {
    kind: 'bind';
    sessionId: string;
} | {
    kind: 'unbind';
} | {
    kind: 'status';
} | {
    kind: 'help';
} | {
    kind: 'chat';
    text: string;
};
export declare function routeText(raw: string): RouteResult;
