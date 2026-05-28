import type { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import { classifyMeituanError } from '../services/meituan/errors'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

const requireAdmin = (req: any, reply: any) => {
  const role = req.user?.role
  if (!['SUPER_ADMIN', 'ADMIN', 'BOSS'].includes(role)) {
    return reply.status(403).send({ error: '需要管理员权限' })
  }
}

const requireView = (req: any, reply: any) => {
  const role = req.user?.role
  if (!['SUPER_ADMIN', 'ADMIN', 'BOSS', 'MANAGER', 'FINANCE'].includes(role)) {
    return reply.status(403).send({ error: '无权查看美团数据' })
  }
}

/**
 * 美团工单 markdown 生成器 — 输出可直接粘贴到美团 TT 工单的 4-字段 markdown
 */
function generateTicketTemplate(call: any): string {
  const meta = classifyMeituanError(call.responseCode)
  const publicStr = Object.entries(call.requestPublic as Record<string, string>)
    .map(([k, v]) => `${k}=${v}`).join('\n')
  const signStr = call.signature ? `\nsign=${call.signature}` : ''

  return `## 1. 具体接口名称

${call.apiTitle}
POST ${call.apiPath}

## 2. 请求参数

**公共参数：**
\`\`\`
${publicStr}${signStr}
\`\`\`

**biz：**
\`\`\`json
${JSON.stringify(call.requestBiz, null, 2)}
\`\`\`

## 3. 响应结果

HTTP ${call.httpStatus ?? '(no response)'}, 耗时 ${call.httpDurationMs ?? '?'}ms
traceId: \`${call.traceId ?? '(no traceId)'}\`
错误码: \`${call.responseCode ?? 'TRANSPORT_ERROR'}\`
错误信息: ${call.responseMsg ?? '(transport error / 无响应)'}
错误分级: ${meta.severity} - ${meta.desc}

**完整响应：**
\`\`\`json
${call.responseRaw ?? '(no body)'}
\`\`\`

## 4. 问题描述

${call.note ?? '[请人工补充: 你想问美团技术什么]'}

---
**调用上下文 (自动生成, 请勿删):**
- callId: ${call.id}
- 调用模式: ${call.mode}
- 发生时间: ${call.createdAt.toISOString()}
- correlationId: ${call.correlationId}
- 开发者 ID: ${process.env.MEITUAN_DEVELOPER_ID || '<未配置>'}
- 商家主体: dianjie 滇界
`
}

export const meituanAdminRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/admin/meituan/calls ──
  app.get('/calls', auth(app), async (req: any, reply) => {
    const denied = requireAdmin(req, reply)
    if (denied) return denied

    const q = z.object({
      since: z.string().optional(),
      until: z.string().optional(),
      severity: z.string().optional(),
      responseCode: z.string().optional(),
      apiPath: z.string().optional(),
      correlationId: z.string().optional(),
      hasNote: z.enum(['true', 'false']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query)

    const where: any = {}
    if (q.since) where.createdAt = { ...(where.createdAt || {}), gte: new Date(q.since) }
    if (q.until) where.createdAt = { ...(where.createdAt || {}), lte: new Date(q.until) }
    if (q.severity) where.errorSeverity = { in: q.severity.split(',') }
    if (q.responseCode) where.responseCode = q.responseCode
    if (q.apiPath) where.apiPath = q.apiPath
    if (q.correlationId) where.correlationId = q.correlationId
    if (q.hasNote === 'true') where.note = { not: null }
    if (q.hasNote === 'false') where.note = null

    const [items, total] = await Promise.all([
      prisma.meituanApiCallLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: q.limit,
        skip: q.offset,
        select: {
          id: true, createdAt: true, apiPath: true, apiTitle: true, mode: true,
          httpStatus: true, httpDurationMs: true, responseCode: true, responseMsg: true,
          traceId: true, errorSeverity: true, correlationId: true,
          note: true,
        },
      }),
      prisma.meituanApiCallLog.count({ where }),
    ])

    return {
      items: items.map(c => ({
        ...c,
        hasNote: !!c.note,
        note: undefined,
        severityZh: c.errorSeverity ? ({ P0: '严重', P1: '一般', P2: '可恢复' } as Record<string,string>)[c.errorSeverity] || c.errorSeverity : null,
      })),
      total, limit: q.limit, offset: q.offset,
    }
  })

  // ── GET /api/admin/meituan/calls/export ──
  // 注意: 必须放在 /calls/:id 之前, 否则被参数路由捕获
  app.get('/calls/export', auth(app), async (req: any, reply) => {
    const denied = requireAdmin(req, reply)
    if (denied) return denied

    const q = z.object({
      since: z.string().optional(),
      until: z.string().optional(),
      severity: z.string().default('P0,P1,P2'),
    }).parse(req.query)

    const where: any = { errorSeverity: { in: q.severity.split(',') } }
    if (q.since) where.createdAt = { ...(where.createdAt || {}), gte: new Date(q.since) }
    if (q.until) where.createdAt = { ...(where.createdAt || {}), lte: new Date(q.until) }

    const calls = await prisma.meituanApiCallLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 5000,
      select: {
        id: true, createdAt: true, apiPath: true, apiTitle: true, mode: true,
        httpStatus: true, httpDurationMs: true, responseCode: true, responseMsg: true,
        traceId: true, errorSeverity: true, correlationId: true,
      },
    })

    const escape = (v: any): string => {
      if (v == null) return ''
      const s = String(v).replace(/"/g, '""')
      return /[",\n]/.test(s) ? `"${s}"` : s
    }
    const header = ['id','createdAt','apiPath','apiTitle','mode','httpStatus','httpDurationMs','responseCode','responseMsg','traceId','errorSeverity','correlationId']
    const lines = [header.join(',')]
    for (const c of calls) {
      lines.push(header.map(k => escape((c as any)[k])).join(','))
    }
    const csv = '\uFEFF' + lines.join('\n')

    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="meituan-calls-${Date.now()}.csv"`)
    return csv
  })

  // ── GET /api/admin/meituan/calls/:id ──
  app.get('/calls/:id', auth(app), async (req: any, reply) => {
    const denied = requireAdmin(req, reply)
    if (denied) return denied

    const call = await prisma.meituanApiCallLog.findUnique({
      where: { id: req.params.id },
    })
    if (!call) return reply.status(404).send({ error: 'callLog not found' })

    const meta = classifyMeituanError(call.responseCode)
    return { ...call, severityMeta: meta }
  })

  // ── GET /api/admin/meituan/calls/:id/ticket-template ──
  app.get('/calls/:id/ticket-template', auth(app), async (req: any, reply) => {
    const denied = requireAdmin(req, reply)
    if (denied) return denied

    const call = await prisma.meituanApiCallLog.findUnique({
      where: { id: req.params.id },
    })
    if (!call) return reply.status(404).send({ error: 'callLog not found' })

    const md = generateTicketTemplate(call)
    reply.header('Content-Type', 'text/markdown; charset=utf-8')
    return md
  })

  // ── PATCH /api/admin/meituan/calls/:id/note ──
  app.patch('/calls/:id/note', auth(app), async (req: any, reply) => {
    const denied = requireAdmin(req, reply)
    if (denied) return denied

    const body = z.object({ note: z.string().max(5000) }).parse(req.body)
    const updated = await prisma.meituanApiCallLog.update({
      where: { id: req.params.id },
      data: { note: body.note },
    })
    return { ok: true, id: updated.id }
  })

  // ── POST /api/admin/meituan/calls/:id/replay ──
  app.post('/calls/:id/replay', auth(app), async (req: any, reply) => {
    const denied = requireAdmin(req, reply)
    if (denied) return denied

    const original = await prisma.meituanApiCallLog.findUnique({
      where: { id: req.params.id },
    })
    if (!original) return reply.status(404).send({ error: 'callLog not found' })
    if (original.mode !== 'real') {
      return reply.status(400).send({ error: 'mock mode call 不能 replay' })
    }

    const { createId } = await import('@paralleldrive/cuid2')
    const { createMeituanClient } = await import('../services/meituan/client')
    const client = createMeituanClient()
    const biz = original.requestBiz as any

    setImmediate(async () => {
      try {
        if (original.apiPath.endsWith('/instore/query')) {
          await client.fetchInstoreOrders({
            orgId: biz.orgId, req: biz.req, correlationId: createId(),
          })
        } else if (original.apiPath.endsWith('/reverse/orders/search')) {
          await client.fetchReverseOrders({
            orgId: biz.orgId, req: biz.req, correlationId: createId(),
          })
        }
      } catch (e) {
        req.log.error({ err: e, callId: original.id }, '[admin/meituan/replay] failed')
      }
    })
    return { ok: true, replayedFrom: original.id, message: '已重放, 新 callLog 会以新 correlationId 落库' }
  })

  // ── GET /api/admin/meituan/health ──
  app.get('/health', auth(app), async (req: any, reply) => {
    const denied = requireView(req, reply)
    if (denied) return denied

    const orgId = Number(process.env.MEITUAN_ORG_ID || 0)
    const apiPath = '/rms/pos/api/v2/poi/orders/instore/query'

    const [cursor, latest, last24h, topErrors, unprocessed, token] = await Promise.all([
      orgId ? prisma.meituanSyncCursor.findUnique({
        where: { apiPath_orgId: { apiPath, orgId } },
      }) : null,
      prisma.meituanApiCallLog.findFirst({
        where: { errorSeverity: null },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, apiPath: true, httpDurationMs: true, correlationId: true },
      }),
      prisma.meituanApiCallLog.groupBy({
        by: ['errorSeverity'],
        where: { createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
        _count: { _all: true },
      }),
      prisma.meituanApiCallLog.groupBy({
        by: ['responseCode'],
        where: {
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) },
          errorSeverity: { not: null },
        },
        _count: { _all: true },
        orderBy: { _count: { responseCode: 'desc' } },
        take: 5,
      }),
      prisma.mtOrder.count({ where: { processed: false } }),
      orgId ? prisma.meituanAuthToken.findUnique({
        where: { orgId },
        select: { lastRefreshedAt: true, expiresAt: true, refreshAttempts: true },
      }) : null,
    ])

    const total24 = last24h.reduce((s, r) => s + r._count._all, 0)
    const failed24 = last24h.filter(r => r.errorSeverity != null).reduce((s, r) => s + r._count._all, 0)
    const successByOk = last24h.find(r => r.errorSeverity === null)?._count._all ?? 0

    return {
      enabled: process.env.MEITUAN_ENABLED === 'true',
      mode: process.env.MEITUAN_MODE || 'mock',
      orgId,
      lastSync: latest,
      cursor: cursor ? {
        lastSyncedAt: cursor.lastSyncedAt,
        lastSuccessAt: cursor.lastSuccessAt,
        lastErrorAt: cursor.lastErrorAt,
        lastErrorCode: cursor.lastErrorCode,
        consecutiveFailures: cursor.consecutiveFailures,
      } : null,
      stats24h: {
        totalCalls: total24,
        successCalls: successByOk,
        failedCalls: failed24,
        errorRate: total24 ? Number((failed24 / total24).toFixed(4)) : 0,
      },
      topErrors7d: topErrors.map(t => ({ code: t.responseCode, count: t._count._all })),
      unprocessedOrders: unprocessed,
      tokenStatus: !token ? 'not-seeded'
        : token.expiresAt && token.expiresAt < new Date() ? 'expired'
        : token.expiresAt && token.expiresAt < new Date(Date.now() + 24 * 3600_000) ? 'expiring'
        : 'valid',
    }
  })

  // ── POST /api/admin/meituan/sync ──
  app.post('/sync', auth(app), async (req: any, reply) => {
    const denied = requireAdmin(req, reply)
    if (denied) return denied

    setImmediate(async () => {
      try {
        const { runMeituanHourlySync } = await import('../services/meituan/cron')
        await runMeituanHourlySync()
      } catch (e) {
        req.log.error({ err: e }, '[admin/meituan/sync] failed')
      }
    })
    return { ok: true, message: '已触发同步, 看 /health 或 /calls 跟进结果' }
  })

  // ── POST /api/admin/meituan/backfill ──
  app.post('/backfill', auth(app), async (req: any, reply) => {
    const denied = requireAdmin(req, reply)
    if (denied) return denied

    const body = z.object({
      since: z.string(),
      until: z.string(),
    }).parse(req.body)

    const since = new Date(body.since)
    const until = new Date(body.until)
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
      return reply.status(400).send({ error: 'since/until 格式错' })
    }
    if (since >= until) {
      return reply.status(400).send({ error: 'since 必须早于 until' })
    }

    const MAX_LOOKBACK_DAYS = 365
    const MAX_FUTURE_HOURS = 24
    const now = new Date()
    if (since < new Date(now.getTime() - MAX_LOOKBACK_DAYS * 24 * 3600_000)) {
      return reply.status(400).send({ error: `since 不能早于 ${MAX_LOOKBACK_DAYS} 天前 (避免误传)` })
    }
    if (until > new Date(now.getTime() + MAX_FUTURE_HOURS * 3600_000)) {
      return reply.status(400).send({ error: `until 不能晚于现在 +${MAX_FUTURE_HOURS} 小时` })
    }
    const spanDays = (until.getTime() - since.getTime()) / (24 * 3600_000)
    if (spanDays > 90) {
      return reply.status(400).send({ error: `单次 backfill 跨度 ${spanDays.toFixed(1)} 天 > 90 天上限 (分批跑)` })
    }

    setImmediate(async () => {
      try {
        const { backfillMeituan } = await import('../services/meituan/cron')
        await backfillMeituan({ since, until })
      } catch (e) {
        req.log.error({ err: e }, '[admin/meituan/backfill] failed')
      }
    })
    return { ok: true, since, until, message: '已触发 backfill, 内部按 31 天切片' }
  })

}
