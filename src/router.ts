/**
 * 微信入站文本的命令路由（先 trim 再匹配；命令均为精确/前缀匹配，正文不误判）。
 * `..`/`!!` 后缀与超时合并不在这里——那是 SessionMerger 的职责（chat 分支原样透传）。
 */

export type RouteResult =
  | { kind: 'approve' }
  | { kind: 'reject' }
  | { kind: 'bind'; sessionId: string }
  | { kind: 'unbind' }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'chat'; text: string }

const APPROVE_WORDS = new Set(['批准', '同意', '允许', 'approve', 'yes', 'y', '/yes'])
const REJECT_WORDS = new Set(['拒绝', '不同意', 'reject', 'no', 'n', '/no'])

export function routeText(raw: string): RouteResult {
  const text = raw.trim()
  const lower = text.toLowerCase()
  if (APPROVE_WORDS.has(lower)) return { kind: 'approve' }
  if (REJECT_WORDS.has(lower)) return { kind: 'reject' }
  if (text === '/bind') return { kind: 'status' }
  if (text.startsWith('/bind ')) {
    const sessionId = text.slice('/bind '.length).trim()
    if (sessionId) return { kind: 'bind', sessionId }
    return { kind: 'status' }
  }
  if (text === '/unbind') return { kind: 'unbind' }
  if (text === '/status' || text === '状态') return { kind: 'status' }
  if (text === '/help' || text === '帮助') return { kind: 'help' }
  return { kind: 'chat', text }
}
