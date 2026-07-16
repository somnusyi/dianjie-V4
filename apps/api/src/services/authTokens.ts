import crypto from 'node:crypto'

export const ACCESS_TTL = '2h'
export const REFRESH_TTL = '30d'
export const ACCESS_TTL_MS = 2 * 60 * 60 * 1000
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000

type JwtSigner = {
  sign(payload: Record<string, unknown>, options: { expiresIn: string }): string
}

type SessionUser = {
  id: string
  tenantId: string
  role: string
  storeId?: string | null
  supplierId?: string | null
}

export function issueAccessToken(jwt: JwtSigner, user: SessionUser) {
  return jwt.sign({
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    storeId: user.storeId || null,
    supplierId: user.supplierId || null,
    jti: crypto.randomUUID(),
    typ: 'access',
  }, { expiresIn: ACCESS_TTL })
}

export function issueSessionTokens(jwt: JwtSigner, user: SessionUser) {
  const token = issueAccessToken(jwt, user)
  const refreshToken = jwt.sign({
    userId: user.id,
    tenantId: user.tenantId,
    jti: crypto.randomUUID(),
    typ: 'refresh',
  }, { expiresIn: REFRESH_TTL })
  return { token, refreshToken, expiresInMs: ACCESS_TTL_MS }
}
