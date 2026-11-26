import { expect, it } from 'vitest'
import Fastify from 'fastify'
import { Writable } from 'node:stream'
import { safeRequestLog, sensitiveLogPaths } from '../../src/lib/safe-request-log'

it('removes query tokens and download/invitation credentials while preserving route diagnostics', () => {
  expect(safeRequestLog({ method: 'GET', url: '/api/wecom/oauth/callback?code=private-code&token=private-token' })).toMatchObject({ method: 'GET', url: '/api/wecom/oauth/callback' })
  expect(safeRequestLog({ url: '/api/invite-accept/fake-invite-token/accept' }).url).toBe('/api/invite-accept/[REDACTED]/accept')
  expect(safeRequestLog({ url: '/api/cmb/receipt/fake-download-token' }).url).toBe('/api/cmb/receipt/[REDACTED]')
})

it('actual request logging does not contain credentials in headers, query or explicitly logged fields', async () => {
  let output = ''
  const stream = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback() } })
  const app = Fastify({ logger: { stream, serializers: { req: safeRequestLog }, redact: { paths: sensitiveLogPaths, censor: '[REDACTED]' } } })
  app.get('/health', async req => {
    req.log.info({ password: 'fake-log-password', nested: { appSecret: 'fake-log-secret' } })
    return { ok: true }
  })
  try {
    expect((await app.inject({ url: '/health?code=fake-log-code', headers: { authorization: 'Bearer fake-log-bearer', cookie: 'fake-log-cookie' } })).statusCode).toBe(200)
    for (const value of ['fake-log-password', 'fake-log-secret', 'fake-log-code', 'fake-log-bearer', 'fake-log-cookie']) expect(output).not.toContain(value)
    expect(output).toContain('/health')
    expect(output).toContain('[REDACTED]')
  } finally { await app.close() }
})
