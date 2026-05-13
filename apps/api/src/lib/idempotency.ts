/**
 * 幂等中间件 —— 防止店员快速双击"提交订单"产生重复记录。
 *
 * 约定：前端对写请求附带 `Idempotency-Key: <uuid>` header；10 分钟内同一 key
 * 的重放请求直接返回首次的响应，不再落库。
 *
 * 注意：
 *   - 只处理 POST / PATCH / PUT / DELETE
 *   - 不带 header 的请求不走幂等（兼容旧代码）
 *   - 用 onRequest 阶段（在 authenticate 之前），所以不依赖 req.user；
 *     key 维度 = method + url + clientKey（UUID）。客户端生成的 UUID 本身
 *     就足以唯一，不需要 userId 维度
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
}

export function registerIdempotency(app: FastifyInstance) {
  // onRequest：在 authenticate preHandler 之前跑。此时还没 req.user，但 clientKey
  // 就够唯一（UUID），不需要 tenant/user 维度
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!METHODS.has(req.method)) return
    const clientKey = req.headers['idempotency-key'] as string | undefined
    if (!clientKey) return // 无 key 不走幂等

    const fullKey = buildKey({
      method: req.method,
      url: req.url.split('?')[0],
      clientKey,
    })

    try {
      const hit = await redis.get(fullKey)
      if (hit) {
        const cached: CachedResponse = JSON.parse(hit)
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
  })

  // onSend：响应即将发出时把 2xx 的 body 缓存
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: any) => {
    const fullKey = (req as any)._idemFullKey as string | undefined
    if (!fullKey) return payload
    if (reply.statusCode < 200 || reply.statusCode >= 300) return payload

    const body = typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : null
    if (body === null || body.length > MAX_CACHE_BYTES) return payload

    try {
      const entry: CachedResponse = {
        status: reply.statusCode,
        body,
        bodyHash: crypto.createHash('sha256').update(body).digest('hex').slice(0, 12),
      }
      await redis.setex(fullKey, TTL_SECONDS, JSON.stringify(entry))
    } catch { /* 缓存失败不阻断响应 */ }

    return payload
  })
}

function buildKey(args: { method: string; url: string; clientKey: string }): string {
  const h = crypto.createHash('sha256')
    .update(`${args.method}|${args.url}|${args.clientKey}`)
    .digest('hex')
    .slice(0, 32)
  return `idem:${h}`
}
