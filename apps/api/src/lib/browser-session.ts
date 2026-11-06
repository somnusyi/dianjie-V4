import { timingSafeEqual } from 'node:crypto'
const refused = () => Object.assign(new Error('浏览器会话来源或安全配置不正确'), { statusCode: 403, code: 'BROWSER_SESSION_REFUSED' })
export function isBrowserSession(req: any) { return req.headers['x-dianjie-session'] === 'cookie-v1' }
export function sessionPolicy(origin: unknown) {
  if (typeof origin !== 'string') throw refused()
  let url: URL
  try { url = new URL(origin) } catch { throw refused() }
  if (url.origin !== origin || url.username || url.password) throw refused()
  const environment = process.env.BROWSER_SESSION_ENV
  if (!environment || !/^[a-z][a-z0-9_-]{0,20}$/.test(environment)) throw refused()
  const allowed = (process.env.BROWSER_SESSION_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!allowed.includes(origin)) throw refused()
  const secure = url.protocol === 'https:'
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (!secure && !(url.protocol === 'http:' && local && process.env.NODE_ENV !== 'production' && process.env.BROWSER_SESSION_ALLOW_LOCAL_HTTP === 'true')) throw refused()
  return { origin, secure, refreshName: `${secure ? '__Host-' : ''}dj_${environment}_refresh`, oauthName: `${secure ? '__Host-' : ''}dj_${environment}_oauth` }
}
export function checkBrowserSession(req: any) {
  const suppliedOrigin = req.headers.origin || (req.method === 'GET' && req.headers.referer ? new URL(req.headers.referer).origin : null)
  const policy = sessionPolicy(suppliedOrigin)
  const site = req.headers['sec-fetch-site']
  if (site && !['same-origin', 'same-site', 'none'].includes(site)) throw refused()
  return policy
}
export function readCookie(req: any, name: string) {
  const pairs = String(req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(name + '='))
  if (pairs.length !== 1) return null
  try { return decodeURIComponent(pairs[0].slice(name.length + 1)) } catch { return null }
}
export function writeBrowserCookie(reply: any, origin: string, name: 'refreshName' | 'oauthName', value: string, maxAge: number) {
  const policy = sessionPolicy(origin)
  if (!Number.isFinite(maxAge)) throw refused()
  const cookie = `${policy[name]}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}${policy.secure ? '; Secure' : ''}`
  const previous = reply.getHeader?.('set-cookie')
  reply.header('set-cookie', previous ? [...(Array.isArray(previous) ? previous : [previous]), cookie] : cookie)
  reply.header('cache-control', 'no-store')
}
type SessionVerifier = { verify(token: string, options?: any): any }
const MAX_SESSION_COOKIES = 16
const MAX_SESSION_COOKIE_BYTES = 16384
function orderOf(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw refused()
  return BigInt(value)
}
function sessionCookies(req: any, prefix: string): Array<{ name: string; value: string }> {
  const pairs = String(req.headers.cookie || '').split(';').map(s => s.trim()).filter(Boolean)
    .map(s => { const at = s.indexOf('='); return { name: s.slice(0, at), value: s.slice(at + 1) } })
    .filter(p => p.name === prefix || p.name.startsWith(prefix + '_s_'))
  if (pairs.length > MAX_SESSION_COOKIES || pairs.some(p => p.value.length > 4096) || pairs.reduce((sum, p) => sum + p.name.length + p.value.length, 0) > MAX_SESSION_COOKIE_BYTES) throw refused()
  if (new Set(pairs.map(p => p.name)).size !== pairs.length) throw refused()
  return pairs.map(p => { try { return { ...p, value: decodeURIComponent(p.value) } } catch { throw refused() } })
}
function refreshClaim(jwt: SessionVerifier, value: string) {
  try {
    // Signature remains checked even for an expired newest session. Never fall back to an older session.
    const claim = jwt.verify(value, { ignoreExpiration: true })
    if (claim.typ !== 'refresh' || !claim.jti || !claim.userId) return null
    const sid = claim.sid || claim.jti
    if (typeof sid !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(sid)) return null
    return { claim, sid, order: orderOf(claim.bso ?? '0') }
  } catch { return null }
}
export function readBrowserRefresh(req: any, jwt: SessionVerifier) {
  const policy = checkBrowserSession(req)
  const candidates = sessionCookies(req, policy.refreshName).flatMap(cookie => {
    const verified = refreshClaim(jwt, cookie.value)
    if (!verified || (cookie.name !== policy.refreshName && cookie.name !== policy.refreshName + '_s_' + verified.sid)) return []
    return [{ ...cookie, ...verified }]
  })
  candidates.sort((a,b) => a.order !== b.order ? (a.order > b.order ? -1 : 1)
    : (Number(b.claim.iat || 0) - Number(a.claim.iat || 0)) || b.sid.localeCompare(a.sid))
  return candidates[0]?.value || null
}
function writeNamedCookie(reply: any, policy: ReturnType<typeof sessionPolicy>, name: string, value: string, maxAge: number) {
  const cookie = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}${policy.secure ? '; Secure' : ''}`
  const previous = reply.getHeader?.('set-cookie')
  reply.header('set-cookie', previous ? [...(Array.isArray(previous) ? previous : [previous]), cookie] : cookie)
  reply.header('cache-control', 'no-store')
}
export function writeBrowserRefresh(req: any, reply: any, origin: string, token: string, jwt: SessionVerifier, maxAge: number) {
  const policy = sessionPolicy(origin), next = refreshClaim(jwt, token)
  if (!next || !Number.isFinite(maxAge) || token.length > 4096) throw refused()
  for (const cookie of sessionCookies(req, policy.refreshName)) {
    const old = refreshClaim(jwt, cookie.value)
    // Only delete names visible in THIS request and older than this signed intent.
    // A late OAuth/legacy response must never delete a newer password-login cookie.
    if ((!old || old.order < next.order || (old.order === next.order && old.sid !== next.sid)) && cookie.name !== policy.refreshName + '_s_' + next.sid)
      writeNamedCookie(reply, policy, cookie.name, '', 0)
  }
  writeNamedCookie(reply, policy, policy.refreshName + '_s_' + next.sid, token, maxAge)
}
export function writeBrowserOAuthIntent(req: any, reply: any, origin: string, value: string, nonce: string, jwt: SessionVerifier) {
  const policy = sessionPolicy(origin), next = jwt.verify(value)
  for (const cookie of sessionCookies(req, policy.oauthName)) {
    try { const old = jwt.verify(cookie.value, { ignoreExpiration: true }); if (old.typ === 'browser-oauth' && orderOf(old.bso) < orderOf(next.bso)) writeNamedCookie(reply, policy, cookie.name, '', 0) } catch {}
  }
  writeNamedCookie(reply, policy, policy.oauthName + '_s_' + nonce, value, 600)
}
export function readBrowserOAuthIntent(req: any, origin: string, nonce: string, jwt: SessionVerifier): any {
  const policy = sessionPolicy(origin)
  sessionCookies(req, policy.oauthName) // bound count/size and reject duplicate names
  const raw = readCookie(req, policy.oauthName + '_s_' + nonce)
  if (!raw) return null
  try { const claim = jwt.verify(raw); return claim.typ === 'browser-oauth' && claim.nonce === nonce && orderOf(claim.bso) >= 0n ? claim : null } catch { return null }
}
export function clearBrowserOAuthIntent(reply: any, origin: string, nonce: string) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(nonce)) throw refused()
  const policy = sessionPolicy(origin)
  writeNamedCookie(reply, policy, policy.oauthName + '_s_' + nonce, '', 0)
}

export function constantEqual(a: string | null, b: string | null) {
  if (!a || !b) return false
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function safeRedirectTarget(value: string | undefined, origin: string) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  try { return new URL(value, origin).origin === origin ? value : '/' } catch { return '/' }
}
