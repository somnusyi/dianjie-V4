import { FastifyPluginAsync } from 'fastify'

export const opsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/updater-error', async (req, reply) => {
    // 不鉴权 — 设备可能还没登录；只记日志，不写 DB
    req.log.warn(
      { body: req.body, ua: req.headers['user-agent'] },
      'updater error from client'
    )
    return reply.status(204).send()
  })
}
