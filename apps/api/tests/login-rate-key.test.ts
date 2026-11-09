import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { loginRateKey, loginRateLimitConfig } from '../src/lib/login-rate-key'

describe('shared-proxy login rate limit', () => {
  it('uses the same key for a normalized account without exposing its identifier', () => {
    const a = loginRateKey({ body: { identifier: ' 13970000001 ', tenantSlug: 'Dianjie' } })
    const b = loginRateKey({ body: { email: '13970000001', tenantSlug: 'dianjie' } })
    expect(a).toBe(b)
    expect(a).not.toContain('13970000001')
    expect(loginRateKey({ body: { identifier: '13970000002' } })).not.toBe(a)
  })

  it('lets another store login after one account reaches its limit', async () => {
    const app = Fastify()
    await app.register(rateLimit, { max: 200, timeWindow: '1 minute' })
    app.post('/login', { config: { rateLimit: loginRateLimitConfig(false) } }, async () => ({ ok: true }))
    try {
      for (let i = 0; i < 20; i++) {
        const res = await app.inject({ method: 'POST', url: '/login', payload: { identifier: '13970000001' } })
        expect(res.statusCode).toBe(200)
      }
      const blocked = await app.inject({ method: 'POST', url: '/login', payload: { identifier: '13970000001' } })
      expect(blocked.statusCode).toBe(429)
      const other = await app.inject({ method: 'POST', url: '/login', payload: { identifier: '13970000002' } })
      expect(other.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })
})
