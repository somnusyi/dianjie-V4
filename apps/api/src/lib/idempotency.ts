/**
 * 幂等中间件 —— 防止店员快速双击"提交订单"产生重复记录。
 *
 * 约定：前端对写请求附带 `Idempotency-Key: <uuid>` header；10 分钟内同一 key
 * 的重放请求直接返回首次的响应，不再落库。
 *
 * 注意：
 *   - 只处理已登录的 POST / PATCH / PUT / DELETE
 *   - 不带 header 的请求不走幂等（兼容旧代码）
 *   - 必须在读取缓存前验证 access JWT，不能让过期或 refresh token 绕过认证命中缓存
 *   - key 维度 = tenant + user + method + url + clientKey，并校验请求体 hash
 *   - Redis 不可用时降级为"无幂等"，业务不阻断
 *   - 只缓存 2xx 响应；4xx/5xx 让客户端重试
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import Redis from 'ioredis'
import crypto from 'crypto'

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
})
redis.on('error', () => {})

const TTL_SECONDS = 600 // 10 分钟
const METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])
const MAX_CACHE_BYTES = 64 * 1024 // 响应 > 64KB 的不缓存（避免 Redis 压力）

interface CachedResponse {
  status: number
  body: string
  bodyHash: string
  requestHash: string
}

export function registerIdempotency(app: FastifyInstance) {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!METHODS.has(req.method)) return
    const clientKey = req.headers['idempotency-key'] as string | undefined
    if (!clientKey) return // 无 key 不走幂等
    if (clientKey.length < 8 || clientKey.length > 200) {
      return reply.status(400).send({ error: 'Idempotency-Key 长度必须为 8-200 字符' })
    }
    if (!req.headers.authorization?.startsWith('Bearer ')) return

    // Global preHandler runs before route-level authenticate. Verify here so a
    // cached response can never bypass token expiry/revocation checks.
    await (req as any).jwtVerify()
    const user = (req as any).user || {}
    if (user.typ !== 'access') {
      return reply.status(401).send({ error: '未授权，请先登录' })
    }
    if (!user.tenantId || !user.userId) return
    const requestHash = hashRequestBody(req.body, req.headers['content-type'])

    const fullKey = buildKey({
      tenantId: user.tenantId,
      userId: user.userId,
      method: req.method,
      url: req.url.split('?')[0],
      clientKey,
    })

    try {
      const hit = await redis.get(fullKey)
      if (hit) {
        const cached: CachedResponse = JSON.parse(hit)
        if (cached.requestHash !== requestHash) {
          return reply.status(409).send({ error: '同一 Idempotency-Key 不能用于不同请求内容' })
        }
        reply.header('Idempotent-Replay', 'true')
        reply.header('Idempotent-Replay-Hash', cached.bodyHash)
        reply.code(cached.status).type('application/json').send(cached.body)
        return reply
      }
    } catch {
      // Redis 不可用 → 降级为"无幂等"，业务继续
      return
    }

    ;(req as any)._idemFullKey = fullKey
    ;(req as any)._idemRequestHash = requestHash
  })

  // onSend：响应即将发出时把 2xx 的 body 缓存
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: any) => {
    const fullKey = (req as any)._idemFullKey as string | undefined
    const requestHash = (req as any)._idemRequestHash as string | undefined
    if (!fullKey || !requestHash) return payload
    if (reply.statusCode < 200 || reply.statusCode >= 300) return payload

    const body = typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : null
    if (body === null || body.length > MAX_CACHE_BYTES) return payload

    try {
      const entry: CachedResponse = {
        status: reply.statusCode,
        body,
        bodyHash: crypto.createHash('sha256').update(body).digest('hex').slice(0, 12),
        requestHash,
      }
      await redis.setex(fullKey, TTL_SECONDS, JSON.stringify(entry))
    } catch { /* 缓存失败不阻断响应 */ }

    return payload
  })
}

export function buildIdempotencyKey(args: {
  tenantId: string
  userId: string
  method: string
  url: string
  clientKey: string
}): string {
  const h = crypto.createHash('sha256')
    .update(`${args.tenantId}|${args.userId}|${args.method}|${args.url}|${args.clientKey}`)
    .digest('hex')
    .slice(0, 32)
  return `idem:${h}`
}

function buildKey(args: Parameters<typeof buildIdempotencyKey>[0]) {
  return buildIdempotencyKey(args)
}

export function hashRequestBody(body: unknown, contentType: unknown): string {
  let serialized = 'null'
  try {
    serialized = JSON.stringify(body ?? null)
  } catch {
    serialized = String(body ?? '')
  }
  return crypto.createHash('sha256')
    .update(`${String(contentType || '')}|${serialized}`)
    .digest('hex')
}
