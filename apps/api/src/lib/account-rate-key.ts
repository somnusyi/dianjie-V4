import { createHash } from 'node:crypto'

type RatePrincipal = { tenantId?: unknown; userId?: unknown; typ?: unknown }
type RateRequest = { user?: unknown; ip: string; body?: unknown }

function accountKey(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const principal = value as RatePrincipal
  if (principal?.typ !== 'access' && principal?.typ !== 'refresh') return null
  if (typeof principal.tenantId !== 'string' || !principal.tenantId) return null
  if (typeof principal.userId !== 'string' || !principal.userId) return null
  return `account:${createHash('sha256').update(`${principal.tenantId}\0${principal.userId}`).digest('hex')}`
}

/** Runs after a route's authenticate preHandler. Anonymous routes use the real client IP. */
export function accountRateKey(request: RateRequest): string {
  return accountKey(request.user) || `client:${request.ip}`
}

/** Refresh has no access-token preHandler; a signed refresh token identifies its account. */
export function refreshRateKey(
  request: RateRequest,
  verify: (token: string) => RatePrincipal,
  browserRefreshToken?: () => string | null,
): string {
  const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {}
  // Browser refresh uses only the cookie; a supplied body token must not
  // select a different account's quota than the session being refreshed.
  let token: string | null = browserRefreshToken ? null : typeof body.token === 'string' ? body.token : null
  if (browserRefreshToken) {
    try { token = browserRefreshToken() } catch { /* the route returns its normal session error */ }
  }
  if (token) {
    try {
      const principal = verify(token)
      if (principal.typ === 'refresh') {
        const key = accountKey(principal)
        if (key) return key
      }
    } catch { /* invalid tokens stay subject to the client-IP limit */ }
  }
  return `client:${request.ip}`
}
