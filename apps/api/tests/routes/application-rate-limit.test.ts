import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@dianjie/db', () => ({ prisma: {} }))
vi.mock('../../src/services/notify', () => ({ fireAndForget: vi.fn() }))
import { publicApplyRoute } from '../../src/routes/applications'

describe('public application rate-limit exemption', () => {
  it('keeps application validation available after both former quotas, without exempting other endpoints', async () => {
    const app = Fastify()
    await app.register(rateLimit, { max: 200, timeWindow: '1 minute' })
    await app.register(publicApplyRoute, { prefix: '/api/auth' })
    app.get('/protected', { config: { rateLimit: { max: 2, timeWindow: '1 hour' } } }, async () => ({ ok: true }))
    try {
      // Invalid requests exercise the actual route without creating accounts or using a database.
      for (let i = 0; i < 210; i++) {
        const res = await app.inject({ method: 'POST', url: '/api/auth/apply', payload: {}, remoteAddress: '127.0.0.1' })
        expect(res.statusCode).toBe(400)
        expect(res.json().error).toBeTruthy()
        expect(res.headers['retry-after']).toBeUndefined()
      }
      expect((await app.inject('/protected')).statusCode).toBe(200)
      expect((await app.inject('/protected')).statusCode).toBe(200)
      expect((await app.inject('/protected')).statusCode).toBe(429)
    } finally { await app.close() }
  })
})
