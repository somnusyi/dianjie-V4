/**
 * 页面批注层（UAT 灰度专用）— 图钉 + 涂鸦
 *
 * 设计约束：
 * - 批注跟页面(pageKey)走，同一页所有白名单账号共享一层；没有"我的/你的"分开概念
 * - 与业务表完全隔离：独立 page_annotations 表，无外键，不写任何业务数据
 * - 白名单外账号一律 404，功能对其完全无感知
 * - 不做实时同步：各自刷新后看到彼此的批注
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'

const auth = (app: any) => ({ preHandler: [(app as any).authenticate] })

const pointSchema = z.tuple([z.number().finite().min(0).max(100000), z.number().finite().min(0).max(100000)])
const pinPayloadSchema = z.object({
  text: z.string().trim().min(1, '批注内容不能为空').max(500, '批注内容最多 500 字'),
  x: z.number().finite().min(0).max(100000),
  y: z.number().finite().min(0).max(100000),
}).strict()
const strokePayloadSchema = z.object({
  points: z.array(pointSchema).min(2, '笔迹至少 2 个点').max(4000, '单笔笔迹点数过多'),
  width: z.number().finite().min(1).max(12).default(3),
}).strict()
const rectPayloadSchema = z.object({
  x: z.number().finite().min(0).max(100000),
  y: z.number().finite().min(0).max(100000),
  w: z.number().finite().min(1).max(100000),
  h: z.number().finite().min(1).max(100000),
  width: z.number().finite().min(1).max(12).default(3),
}).strict()

const pageKeySchema = z.string().trim().min(1).max(200).regex(/^\/[A-Za-z0-9\-_/.%]*$/, '页面路径格式不正确')
const createSchema = z.object({
  pageKey: pageKeySchema,
  kind: z.enum(['PIN', 'STROKE', 'RECT']),
  payload: z.unknown(),
}).strict()
const patchSchema = z.object({ payload: z.unknown() }).strict()

function phoneList(envValue: string | undefined): string[] {
  return (envValue || '').split(',').map(item => item.trim()).filter(Boolean)
}

function annotationsEnabled(): boolean {
  return process.env.ANNOTATIONS_ENABLED === 'true'
}

type Actor = {
  userId: string
  tenantId: string
  phone: string
  name: string
}

async function loadActor(request: any): Promise<Actor | null> {
  if (!annotationsEnabled()) return null
  const { userId, tenantId } = request.user || {}
  if (!userId || !tenantId) return null
  const allowed = phoneList(process.env.ANNOTATION_ALLOWED_PHONES)
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId, status: 'ACTIVE' },
    select: { id: true, name: true, phone: true },
  })
  if (!user || !user.phone || !allowed.includes(user.phone)) return null
  return { userId, tenantId, phone: user.phone, name: user.name || '' }
}

function notFound(reply: any) {
  return reply.status(404).send({ error: '不存在' })
}

export const pageAnnotationRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/page-annotations/config — 前端探测自己能否使用批注（所有白名单账号行为一致，无管理员概念）
  app.get('/config', {
    ...auth(app),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request: any, reply) => {
    const actor = await loadActor(request)
    if (!actor) return notFound(reply)
    return { enabled: true }
  })

  // GET /api/page-annotations?pageKey=/v2/xxx — 取该页共享批注层
  app.get('/', {
    ...auth(app),
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request: any, reply) => {
    const actor = await loadActor(request)
    if (!actor) return notFound(reply)
    const pageKey = String(request.query?.pageKey || '')
    if (!pageKeySchema.safeParse(pageKey).success) {
      return reply.status(400).send({ error: '页面路径格式不正确' })
    }
    const rows = await prisma.pageAnnotation.findMany({
      where: { tenantId: actor.tenantId, pageKey },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, pageKey: true, kind: true, payload: true,
        authorId: true, authorName: true, authorPhone: true, createdAt: true,
      },
    })
    return rows.map(row => ({ ...row, mine: row.authorId === actor.userId, deletable: row.authorId === actor.userId }))
  })

  // POST /api/page-annotations — 加一条（图钉或一笔涂鸦）
  app.post('/', {
    ...auth(app),
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request: any, reply) => {
    const actor = await loadActor(request)
    if (!actor) return notFound(reply)
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { pageKey, kind } = parsed.data
    const payload = kind === 'PIN'
      ? pinPayloadSchema.safeParse(parsed.data.payload)
      : kind === 'RECT'
        ? rectPayloadSchema.safeParse(parsed.data.payload)
        : strokePayloadSchema.safeParse(parsed.data.payload)
    if (!payload.success) return reply.status(400).send({ error: payload.error.issues[0].message })
    const row = await prisma.pageAnnotation.create({
      data: {
        tenantId: actor.tenantId,
        pageKey,
        kind,
        payload: payload.data as object,
        authorId: actor.userId,
        authorName: actor.name,
        authorPhone: actor.phone,
      },
    })
    return reply.status(201).send({ ...row, mine: true, deletable: true })
  })

  // PATCH /api/page-annotations/:id — 仅作者可改图钉文字/位置
  app.patch('/:id', {
    ...auth(app),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request: any, reply) => {
    const actor = await loadActor(request)
    if (!actor) return notFound(reply)
    const id = String(request.params?.id || '')
    const parsed = patchSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: '参数格式不正确' })
    const existing = await prisma.pageAnnotation.findFirst({ where: { id, tenantId: actor.tenantId } })
    if (!existing) return notFound(reply)
    if (existing.authorId !== actor.userId) return reply.status(403).send({ error: '只能修改自己写的批注' })
    if (existing.kind !== 'PIN') return reply.status(400).send({ error: '只有图钉可编辑，涂鸦请撤销重画' })
    const payload = pinPayloadSchema.safeParse(parsed.data.payload)
    if (!payload.success) return reply.status(400).send({ error: payload.error.issues[0].message })
    const row = await prisma.pageAnnotation.update({
      where: { id },
      data: { payload: payload.data as object },
    })
    return { ...row, mine: true, deletable: true }
  })

  // DELETE /api/page-annotations/:id — 所有人规则一致：只能删自己写的
  app.delete('/:id', {
    ...auth(app),
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (request: any, reply) => {
    const actor = await loadActor(request)
    if (!actor) return notFound(reply)
    const id = String(request.params?.id || '')
    const existing = await prisma.pageAnnotation.findFirst({ where: { id, tenantId: actor.tenantId } })
    if (!existing) return notFound(reply)
    if (existing.authorId !== actor.userId) {
      return reply.status(403).send({ error: '只能删除自己写的批注' })
    }
    await prisma.pageAnnotation.delete({ where: { id } })
    return { success: true }
  })
}
