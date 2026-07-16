import { describe, expect, it } from 'vitest'
import { ACCESS_TTL, ACCESS_TTL_MS, REFRESH_TTL, issueAccessToken, issueSessionTokens } from '../../src/services/authTokens'

describe('authentication token issuance', () => {
  const user = {
    id: 'user-1', tenantId: 'tenant-1', role: 'FINANCE', storeId: null, supplierId: null, authVersion: 5,
  }

  it('issues typed short access and long refresh tokens from one policy', () => {
    const calls: Array<{ payload: Record<string, unknown>; expiresIn: string }> = []
    const jwt = {
      sign(payload: Record<string, unknown>, options: { expiresIn: string }) {
        calls.push({ payload, expiresIn: options.expiresIn })
        return `token-${calls.length}`
      },
    }
    const result = issueSessionTokens(jwt, user)
    expect(result).toEqual({ token: 'token-1', refreshToken: 'token-2', expiresInMs: ACCESS_TTL_MS })
    expect(calls[0].payload).toMatchObject({ userId: user.id, tenantId: user.tenantId, role: 'FINANCE', typ: 'access', ver: 5 })
    expect(calls[0].expiresIn).toBe(ACCESS_TTL)
    expect(calls[1].payload).toMatchObject({ userId: user.id, tenantId: user.tenantId, typ: 'refresh', ver: 5 })
    expect(calls[1].payload).not.toHaveProperty('role')
    expect(calls[1].expiresIn).toBe(REFRESH_TTL)
    expect(calls[0].payload.jti).not.toBe(calls[1].payload.jti)
  })

  it('always marks refreshed access tokens as access', () => {
    let payload: Record<string, unknown> = {}
    const token = issueAccessToken({
      sign(value) { payload = value; return 'access-token' },
    }, user)
    expect(token).toBe('access-token')
    expect(payload).toMatchObject({ typ: 'access', role: 'FINANCE' })
  })
})
