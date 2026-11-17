import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { feedbackRoutes } from '../../src/routes/feedback'

describe('feedback submission without approval routes', () => {
  it('does not expose the former inbox, decision or resolution endpoints', async () => {
    const app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = { tenantId: 'tenant', userId: 'admin', role: 'SUPER_ADMIN' }
    })
    await app.register(feedbackRoutes, { prefix: '/api/feedback' })
    try {
      expect((await app.inject('/api/feedback/admin/inbox')).statusCode).toBe(404)
      expect((await app.inject({ method: 'POST', url: '/api/feedback/id/decision', payload: { action: 'approve' } })).statusCode).toBe(404)
      expect((await app.inject({ method: 'POST', url: '/api/feedback/id/resolve', payload: {} })).statusCode).toBe(404)
      expect(app.hasRoute({ method: 'POST', url: '/api/feedback' })).toBe(true)
      expect(app.hasRoute({ method: 'GET', url: '/api/feedback/mine' })).toBe(true)
    } finally { await app.close() }
  })
})
