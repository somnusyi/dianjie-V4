import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'

const updaterErrorSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  code: z.string().trim().max(100).optional(),
  version: z.string().trim().max(60).optional(),
  platform: z.string().trim().max(60).optional(),
  stack: z.string().max(4000).optional(),
}).strict()

export const opsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/updater-error', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    // 不鉴权 — 设备可能还没登录；只记日志，不写 DB
    const parsed = updaterErrorSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    req.log.warn(
      { updater: parsed.data, ua: String(req.headers['user-agent'] || '').slice(0, 500) },
      'updater error from client'
    )
    return reply.status(204).send()
  })
}
