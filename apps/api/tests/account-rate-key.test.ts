import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { accountRateKey, refreshRateKey } from '../src/lib/account-rate-key'

describe('rate limits behind the local reverse proxy', () => {
  it('isolates signed accounts without exposing account identifiers in limiter keys', () => {
    const a = accountRateKey({ ip: '127.0.0.1', user: { typ: 'access', tenantId: 't', userId: 'a' } })
    expect(a).toBe(accountRateKey({ ip: '198.51.100.1', user: { typ: 'access', tenantId: 't', userId: 'a' } }))
    expect(a).not.toBe(accountRateKey({ ip: '127.0.0.1', user: { typ: 'access', tenantId: 't', userId: 'b' } }))
    expect(a).not.toContain('account:a')
  })

  it('gives each account its own allowance even through one proxy', async () => {
    const app = Fastify({ trustProxy: '127.0.0.1' })
    await app.register(rateLimit, { max: 2, timeWindow: '1 minute', hook: 'preHandler', keyGenerator: accountRateKey })
    app.get('/private', { preHandler: async (request: any) => {
      request.user = { typ: 'access', tenantId: 't', userId: request.headers['x-test-user'] }
    } }, async () => ({ ok: true }))
    try {
      const call = (user: string) => app.inject({ url: '/private', headers: { 'x-test-user': user, 'x-forwarded-for': '198.51.100.10' } })
      expect((await call('a')).statusCode).toBe(200)
      expect((await call('a')).statusCode).toBe(200)
      expect((await call('a')).statusCode).toBe(429)
      expect((await call('b')).statusCode).toBe(200)
    } finally { await app.close() }
  })

  it('keeps a route-specific quota separate for each authenticated account', async () => {
    const app = Fastify({ trustProxy: '127.0.0.1' })
    await app.register(rateLimit, { max: 200, timeWindow: '1 minute', hook: 'preHandler', keyGenerator: accountRateKey })
    app.post('/messages', {
      preHandler: async (request: any) => { request.user = { typ: 'access', tenantId: 't', userId: request.headers['x-test-user'] } },
      config: { rateLimit: { max: 1, timeWindow: '1 hour' } },
    }, async () => ({ ok: true }))
    try {
      const call = (user: string) => app.inject({ method: 'POST', url: '/messages', headers: { 'x-test-user': user, 'x-forwarded-for': '198.51.100.10' } })
      expect((await call('a')).statusCode).toBe(200)
      expect((await call('a')).statusCode).toBe(429)
      expect((await call('b')).statusCode).toBe(200)
    } finally { await app.close() }
  })

  it('sustains simultaneous account traffic at the 200/minute boundary', async () => {
    const app = Fastify({ trustProxy: '127.0.0.1' })
    await app.register(rateLimit, { max: 200, timeWindow: '1 minute', hook: 'preHandler', keyGenerator: accountRateKey })
    app.get('/private', { preHandler: async (request: any) => {
      request.user = { typ: 'access', tenantId: 't', userId: request.headers['x-test-user'] }
    } }, async () => ({ ok: true }))
    app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok' }))
    try {
      const requests = Array.from({ length: 200 }, (_, i) => ['a', 'b'].map((user) =>
        app.inject({ url: '/private', headers: { 'x-test-user': user, 'x-forwarded-for': `198.51.100.${i % 2 + 1}` } })
      )).flat()
      const results = await Promise.all(requests)
      expect(results.every((result) => result.statusCode === 200)).toBe(true)
      expect((await app.inject({ url: '/private', headers: { 'x-test-user': 'a' } })).statusCode).toBe(429)
      expect((await app.inject({ url: '/private', headers: { 'x-test-user': 'b' } })).statusCode).toBe(429)
      expect((await app.inject('/health')).statusCode).toBe(200)
    } finally { await app.close() }
  })

  it('does not share one quota across five roles behind the same proxy', async () => {
    const app = Fastify({ trustProxy: '127.0.0.1' })
    await app.register(rateLimit, { max: 200, timeWindow: '1 minute', hook: 'preHandler', keyGenerator: accountRateKey })
    app.get('/private', { preHandler: async (request: any) => {
      request.user = { typ: 'access', tenantId: 't', userId: request.headers['x-test-user'] }
    } }, async () => ({ ok: true }))
    try {
      const roles = ['supply-chain', 'manager', 'kitchen-lead', 'boss', 'supplier']
      const requests = roles.flatMap(user => Array.from({ length: 50 }, () => app.inject({
        url: '/private', remoteAddress: '127.0.0.1', headers: { 'x-test-user': user, 'x-forwarded-for': '198.51.100.10' },
      })))
      const responses = await Promise.all(requests)
      expect(responses).toHaveLength(250)
      expect(responses.every(response => response.statusCode === 200)).toBe(true)
    } finally { await app.close() }
  })

  it('keeps health checks available when a client exhausts its request quota', async () => {
    const app = Fastify({ trustProxy: '127.0.0.1' })
    await app.register(rateLimit, { max: 1, timeWindow: '1 minute', hook: 'preHandler', keyGenerator: accountRateKey })
    app.get('/normal', async () => ({ ok: true }))
    app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok' }))
    try {
      expect((await app.inject('/normal')).statusCode).toBe(200)
      expect((await app.inject('/normal')).statusCode).toBe(429)
      expect((await app.inject('/health')).statusCode).toBe(200)
    } finally { await app.close() }
  })

  it('uses the real client address for public requests, ignoring a spoofed leftmost hop', async () => {
    const app = Fastify({ trustProxy: '127.0.0.1' })
    await app.register(rateLimit, { max: 1, timeWindow: '1 minute', hook: 'preHandler', keyGenerator: accountRateKey })
    app.get('/public', async () => ({ ok: true }))
    try {
      const call = (forwarded: string) => app.inject({ url: '/public', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': forwarded } })
      expect((await call('198.51.100.1')).statusCode).toBe(200)
      expect((await call('203.0.113.3, 198.51.100.1')).statusCode).toBe(429)
      expect((await call('198.51.100.2')).statusCode).toBe(200)
    } finally { await app.close() }
  })

  it('limits valid refresh tokens by account, and invalid tokens by client address', () => {
    const verify = (token: string) => {
      if (token === 'invalid') throw new Error('invalid')
      return { typ: 'refresh', tenantId: 't', userId: token.split(':')[0] }
    }
    const a1 = refreshRateKey({ ip: '198.51.100.1', body: { token: 'a:session1' } }, verify)
    const a2 = refreshRateKey({ ip: '198.51.100.2', body: { token: 'a:session2' } }, verify)
    const b = refreshRateKey({ ip: '198.51.100.1', body: { token: 'b:session1' } }, verify)
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
    expect(refreshRateKey({ ip: '198.51.100.1', body: { token: 'invalid' } }, verify)).toBe('client:198.51.100.1')
    expect(refreshRateKey({ ip: '198.51.100.1' }, verify, () => 'a:session1')).toBe(a1)
    expect(refreshRateKey({ ip: '198.51.100.1', body: { token: 'b:session1' } }, verify, () => 'a:session1')).toBe(a1)
  })
})
