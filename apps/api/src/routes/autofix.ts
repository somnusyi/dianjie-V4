import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'
import { executeApprovedRun, executeManualRollback } from '../services/autofix/deployment'
import { isAutoDeploymentEnabled } from '../services/autofix/policy'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const STATUSES = [
  'RECEIVED', 'ANALYZING', 'PLAN_READY', 'AWAITING_APPROVAL', 'PATCHING',
  'VERIFYING', 'DEPLOYING', 'VERIFY_PROD', 'RESOLVED', 'FAILED_ROLLBACK',
  'ROLLED_BACK', 'ESCALATED', 'REJECTED',
] as const
const statusSchema = z.enum(STATUSES)
const listQuerySchema = z.object({
  status: statusSchema.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict()
const detailQuerySchema = z.object({
  diffOffset: z.coerce.number().int().min(0).default(0),
  diffLimit: z.coerce.number().int().min(1).max(50_000).default(20_000),
}).strict()
const rejectSchema = z.object({
  note: z.string().trim().min(1, '请填写驳回理由').max(500),
}).strict()

function isSuperAdmin(actor: any): boolean {
  return actor?.role === 'SUPER_ADMIN'
}

function deploymentReady(): boolean {
  return isAutoDeploymentEnabled()
}

export const autoFixRoutes: FastifyPluginAsync = async (app) => {
  app.get('/runs', auth(app), async (req: any, reply: any) => {
    const actor = req.user
    if (!isSuperAdmin(actor)) return reply.status(403).send({ error: '无权限' })
    const parsed = listQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { status, page, pageSize } = parsed.data
    const where = { tenantId: actor.tenantId, ...(status ? { status: status as any } : {}) }
    const [total, items] = await prisma.$transaction([
      prisma.autoFixRun.count({ where }),
      prisma.autoFixRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          status: true,
          planSummary: true,
          diffFiles: true,
          error: true,
          commitSha: true,
          createdAt: true,
          updatedAt: true,
          feedback: {
            select: { id: true, title: true, summary: true, status: true },
          },
        },
      }),
    ])
    return { items, total, page, pageSize }
  })

  app.get('/runs/:id', auth(app), async (req: any, reply: any) => {
    const actor = req.user
    if (!isSuperAdmin(actor)) return reply.status(403).send({ error: '无权限' })
    const parsed = detailQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const run = await prisma.autoFixRun.findFirst({
      where: { id: String(req.params.id), tenantId: actor.tenantId },
      include: {
        feedback: {
          select: {
            id: true, title: true, summary: true, status: true, context: true,
            reporter: { select: { id: true, name: true } },
          },
        },
        decidedBy: { select: { id: true, name: true } },
      },
    })
    if (!run) return reply.status(404).send({ error: '自动修复记录不存在' })
    const patch = run.diffPatch || ''
    const { diffOffset, diffLimit } = parsed.data
    return {
      ...run,
      diffPatch: patch.slice(diffOffset, diffOffset + diffLimit),
      diffOffset,
      diffLimit,
      diffTotal: patch.length,
      mode: process.env.AUTO_FIX_MODE || 'off',
      deploymentReady: deploymentReady(),
    }
  })

  app.post('/runs/:id/approve', auth(app), async (req: any, reply: any) => {
    const actor = req.user
    if (!isSuperAdmin(actor)) return reply.status(403).send({ error: '无权限' })
    if (!deploymentReady()) {
      return reply.status(409).send({ error: '自动修复部署环境未启用，请先完成服务器源码副本和部署开关配置' })
    }
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`autofix:${String(req.params.id)}`}))::text AS locked`
      const run = await tx.autoFixRun.findFirst({
        where: { id: String(req.params.id), tenantId: actor.tenantId },
      })
      if (!run) return { status: 404, error: '自动修复记录不存在' }
      if (run.status !== ('AWAITING_APPROVAL' as any)) return { status: 400, error: '当前状态不可批准' }
      if (!run.diffPatch || !run.baseCommitSha) return { status: 400, error: '补丁或源码基线不完整' }
      await tx.autoFixRun.update({
        where: { id: run.id },
        data: {
          status: 'DEPLOYING' as any,
          decidedById: actor.userId,
          decidedAt: new Date(),
          error: null,
        },
      })
      await tx.opLog.create({
        data: {
          tenantId: actor.tenantId,
          userId: actor.userId,
          role: actor.role,
          action: `批准 AI 自动修复 ${run.id}`,
          entityType: 'AutoFixRun',
          targetId: run.id,
          metadata: { decision: 'approve' } as any,
        },
      })
      return { status: 202, id: run.id }
    })
    if ('error' in result) return reply.status(result.status).send({ error: result.error })
    setImmediate(() => void executeApprovedRun(result.id))
    return reply.status(202).send({ ok: true, status: 'DEPLOYING' })
  })

  app.post('/runs/:id/reject', auth(app), async (req: any, reply: any) => {
    const actor = req.user
    if (!isSuperAdmin(actor)) return reply.status(403).send({ error: '无权限' })
    const parsed = rejectSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`autofix:${String(req.params.id)}`}))::text AS locked`
      const run = await tx.autoFixRun.findFirst({
        where: { id: String(req.params.id), tenantId: actor.tenantId },
      })
      if (!run) return { status: 404, error: '自动修复记录不存在' }
      if (run.status !== ('AWAITING_APPROVAL' as any)) return { status: 400, error: '当前状态不可驳回' }
      await tx.autoFixRun.update({
        where: { id: run.id },
        data: {
          status: 'REJECTED' as any,
          decidedById: actor.userId,
          decidedAt: new Date(),
          error: parsed.data.note,
        },
      })
      await tx.opLog.create({
        data: {
          tenantId: actor.tenantId,
          userId: actor.userId,
          role: actor.role,
          action: `驳回 AI 自动修复 ${run.id}: ${parsed.data.note}`,
          entityType: 'AutoFixRun',
          targetId: run.id,
          metadata: { decision: 'reject' } as any,
        },
      })
      return { status: 200 }
    })
    if ('error' in result) return reply.status(result.status).send({ error: result.error })
    return { ok: true, status: 'REJECTED' }
  })

  app.post('/runs/:id/rollback', auth(app), async (req: any, reply: any) => {
    const actor = req.user
    if (!isSuperAdmin(actor)) return reply.status(403).send({ error: '无权限' })
    if (!deploymentReady()) return reply.status(409).send({ error: '自动修复部署环境未启用' })
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`autofix:${String(req.params.id)}`}))::text AS locked`
      const run = await tx.autoFixRun.findFirst({
        where: { id: String(req.params.id), tenantId: actor.tenantId },
      })
      if (!run) return { status: 404, error: '自动修复记录不存在' }
      if (run.status !== ('RESOLVED' as any) || !run.commitSha) {
        return { status: 400, error: '当前记录没有可回滚的已部署提交' }
      }
      await tx.autoFixRun.update({
        where: { id: run.id },
        data: { status: 'DEPLOYING' as any, decidedById: actor.userId, decidedAt: new Date() },
      })
      await tx.opLog.create({
        data: {
          tenantId: actor.tenantId,
          userId: actor.userId,
          role: actor.role,
          action: `发起 AI 自动修复回滚 ${run.id}`,
          entityType: 'AutoFixRun',
          targetId: run.id,
          metadata: { decision: 'rollback' } as any,
        },
      })
      return { status: 202, id: run.id }
    })
    if ('error' in result) return reply.status(result.status).send({ error: result.error })
    setImmediate(() => void executeManualRollback(result.id))
    return reply.status(202).send({ ok: true, status: 'DEPLOYING' })
  })
}
