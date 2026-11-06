import crypto from 'node:crypto'

export const ACCESS_TTL = '2h'
export const REFRESH_TTL = '30d'
export const ACCESS_TTL_MS = 2 * 60 * 60 * 1000
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000

type JwtSigner = {
  sign(payload: Record<string, unknown>, options: { expiresIn?: string }): string
}

type SessionUser = {
  id: string
  tenantId: string
  role: string
  storeId?: string | null
  storeIds?: string[] | null
  supplierId?: string | null
  authVersion?: number
}

export function issueAccessToken(jwt: JwtSigner, user: SessionUser, sessionId?: string) {
  return jwt.sign({
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    storeId: user.storeId || null,
    // 多店数据范围入 token；空数组回退单店，老 token 无此字段时由 auth-scope 回退 storeId
    storeIds: (user.storeIds && user.storeIds.length > 0)
      ? user.storeIds
      : (user.storeId ? [user.storeId] : []),
    supplierId: user.supplierId || null,
    jti: crypto.randomUUID(),
    ...(sessionId ? {sid:sessionId} : {}),
    typ: 'access',
    ver: user.authVersion ?? 0,
  }, { expiresIn: ACCESS_TTL })
}

export function issueSessionTokens(jwt: JwtSigner, user: SessionUser, browserSessionOrder?: string, browserIntentAtMs?: number) {
  const sid=crypto.randomUUID()
  const token = issueAccessToken(jwt, user, sid)
  const refreshToken = jwt.sign({
    userId: user.id,
    tenantId: user.tenantId,
    jti: sid,
    sid,
    ...(browserSessionOrder ? { bso: browserSessionOrder } : {}),
    ...(browserIntentAtMs === undefined ? {} : { bia: String(browserIntentAtMs), iat: Math.floor(browserIntentAtMs / 1000), exp: Math.floor((browserIntentAtMs + REFRESH_TTL_MS) / 1000) }),
    typ: 'refresh',
    ver: user.authVersion ?? 0,
  }, browserIntentAtMs === undefined ? { expiresIn: REFRESH_TTL } : {})
  return { token, refreshToken, expiresInMs: ACCESS_TTL_MS }
}
