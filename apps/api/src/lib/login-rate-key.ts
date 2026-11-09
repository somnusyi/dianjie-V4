import { createHash } from 'node:crypto'

/** The public login is reached through one shared reverse proxy for many stores. */
export function loginRateKey(request: { body?: unknown }) {
  const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {}
  const identifier = String(body.identifier || body.email || '').trim().toLowerCase()
  const tenant = String(body.tenantSlug || 'dianjie').trim().toLowerCase()
  // Keep phone/email out of the limiter's in-memory keys and diagnostics.
  return `login-account:${createHash('sha256').update(`${tenant}\0${identifier || '[missing]'}`).digest('hex')}`
}

export function loginRateLimitConfig(testMode = process.env.NODE_ENV === 'test') {
  return {
    max: testMode ? 2_000 : 20,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    keyGenerator: loginRateKey,
  }
}
