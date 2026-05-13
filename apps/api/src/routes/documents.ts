/**
 * v2 通用审批文档 API
 *
 * GET  /api/documents/inbox            按当前角色返回待我审批的步骤
 * GET  /api/documents/:id              单据详情（含 steps + decisions + 上下文）
 * POST /api/documents                  发起一张单据（管理员/店长/任何角色都可，按 type）
 * POST /api/documents/:id/decisions    审批：APPROVE / REJECT / FORWARD
 * GET  /api/documents/:id/cmb-logs     兼容老前端：返回空数组
 */
import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { routeFor, DocumentType, Role } from '../services/documentRouting'
import { invalidatePattern } from '../lib/cache'
import { isSupplierRole } from '../lib/auth-scope'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

/** 把当前用户的角色映射到能批的 step.role 集合（处理 BOSS/ADMIN/CHEF 别名）*/
function approverRolesFor(role: string): Set<string> {
  const set = new Set<string>([role])
  if (role === 'ADMIN' || role === 'SUPER_ADMIN') set.add('BOSS')
  if (role === 'BOSS') { set.add('ADMIN'); set.add('SUPER_ADMIN') }
  if (role === 'CHEF') set.add('CHEF_DIRECTOR')
  if (role === 'CHEF_DIRECTOR') set.add('CHEF')
  return set
}

export const documentRoutes: FastifyPluginAsync = async (app) => {

  // ── inbox: 待当前角色审批的步骤 + 单据 ─────────────────────
  app.get('/inbox', auth(app), async (req: any) => {
    const { tenantId, role, userId } = req.user
    const roles = [...approverRolesFor(role)]
    const steps = await prisma.documentStep.findMany({
      where: {
        status: 'PENDING',
        approverRole: { in: roles },
        document: { tenantId, status: 'PENDING' },
      },
      include: {
        document: {
          include: {
            store: { select: { id: true, name: true, no: true } },
            initiator: { select: { id: true, name: true, role: true } },
          },
        },
      },
      orderBy: [{ document: { createdAt: 'desc' } }, { seq: 'asc' }],
    })
    // 只返回真正轮到当前 step 的（前面 seq 都已 APPROVED）
    const result: any[] = []
    for (const s of steps) {
      const earlier = await prisma.documentStep.count({
        where: {
          documentId: s.documentId,
          seq: { lt: s.seq },
          status: { not: 'APPROVED' },
        },
      })
      if (earlier === 0) {
        result.push({ stepId: s.id, seq: s.seq, document: s.document })
      }
    }
    return result
  })

  // ── 单据详情 ────────────────────────────────────────────
  app.get('/:id', auth(app), async (req: any, reply) => {
    const { tenantId, role, userId, storeId, supplierId } = req.user
    const doc = await prisma.document.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        store: { select: { id: true, name: true, no: true } },
        initiator: { select: { id: true, name: true, role: true } },
        steps: {
          include: { approver: { select: { id: true, name: true, role: true } } },
          orderBy: { seq: 'asc' },
        },
        decisions: {
          include: { user: { select: { id: true, name: true, role: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!doc) return reply.status(404).send({ error: '单据不存在' })
    // 集团角色 (BOSS/ADMIN/SUPER_ADMIN/FINANCE/CHEF_DIRECTOR) 全可见
    const groupRoles = new Set(['BOSS', 'ADMIN', 'SUPER_ADMIN', 'FINANCE', 'CHEF_DIRECTOR', 'CHEF', 'ENGINEERING'])
    if (groupRoles.has(role)) return { ...doc, attachments: [] }
    // 发起人/审批人始终可见
    if (doc.initiatorId === userId) return { ...doc, attachments: [] }
    if (doc.steps.some(s => s.approverId === userId)) return { ...doc, attachments: [] }
    // 店长只看自己店
    if (role === 'MANAGER' || role === 'KITCHEN_LEAD') {
      if (doc.storeId && doc.storeId !== storeId) {
        return reply.status(403).send({ error: '无权查看其他门店单据' })
      }
      return { ...doc, attachments: [] }
    }
    // 供应商: 只看 payload 里 supplierId/supplierName 跟自己关联的
    if (isSupplierRole(role)) {
      const pl = (doc.payload as any) || {}
      if (pl.supplierId && pl.supplierId !== supplierId) {
        return reply.status(403).send({ error: '无权查看其他供应商单据' })
      }
      // 没有明确 supplierId 关联的单据 (人事/合同等), 供应商不可见
      if (!pl.supplierId && !pl.supplierName) {
        return reply.status(403).send({ error: '无权查看此单据' })
      }
      return { ...doc, attachments: [] }
    }
    return { ...doc, attachments: [] }
  })

  // 老前端兼容：cmb-logs 返回空（招行付款流水尚未关联到 documents）
  app.get('/:id/cmb-logs', auth(app), async () => [])

  /** GET /api/documents/:id/preview — 按 type/payload 自动解析出审批所需的业务上下文
   *  PRICE_ADJUSTMENT: 商品 + 旧价 + 新价 + 涨跌幅
   *  NEW_DISH (CREATE): 新增商品全部字段
   *  NEW_DISH (BATCH):  批次内所有商品列表 (前 50 + 总数)
   *  NEW_DISH (DISABLE):停售商品基础信息 + 历史售出/库存
   */
  app.get('/:id/preview', auth(app), async (req: any, reply) => {
    const { tenantId } = req.user
    const doc = await prisma.document.findFirst({ where: { id: req.params.id, tenantId } })
    if (!doc) return reply.status(404).send({ error: '单据不存在' })
    const p = (doc.payload as any) || {}

    if (doc.type === 'PRICE_ADJUSTMENT' && p.productId) {
      const pr = await prisma.product.findUnique({
        where: { id: p.productId },
        select: { id: true, code: true, name: true, spec: true, unit: true, category: true, price: true, supplier: { select: { name: true } } },
      })
      return {
        kind: 'PRICE_ADJUSTMENT',
        product: pr,
        oldPrice: p.oldPrice, newPrice: p.newPrice,
        delta: p.delta, pct: p.pct,
      }
    }

    if (doc.type === 'NEW_DISH') {
      if (p.action === 'CREATE' && p.productId) {
        const pr = await prisma.product.findUnique({
          where: { id: p.productId },
          select: { id: true, code: true, name: true, spec: true, unit: true, category: true, price: true, shelfDays: true, status: true, supplier: { select: { name: true } } },
        })
        return { kind: 'NEW_DISH_CREATE', product: pr }
      }
      if (p.action === 'BATCH' && Array.isArray(p.productIds)) {
        const total = p.productIds.length
        // 支持 ?full=1 拿全量, 否则只回前 50 条作摘要
        const wantFull = (req.query as any)?.full === '1' || (req.query as any)?.full === 'true'
        const limit = wantFull ? total : 50
        const sample = await prisma.product.findMany({
          where: { id: { in: p.productIds.slice(0, limit) } },
          select: { id: true, code: true, name: true, spec: true, unit: true, category: true, price: true, status: true },
          orderBy: { name: 'asc' },
        })
        // 统计有价/无价
        const withPrice = await prisma.product.count({ where: { id: { in: p.productIds }, price: { gt: 0 } } })
        const noPrice = total - withPrice
        const byCategory: Record<string, number> = {}
        const cats = await prisma.product.findMany({ where: { id: { in: p.productIds } }, select: { category: true } })
        cats.forEach(c => { byCategory[c.category || '其他'] = (byCategory[c.category || '其他'] || 0) + 1 })
        return {
          kind: 'NEW_DISH_BATCH',
          total, withPrice, noPrice, byCategory,
          sample,
          filename: p.filename || null,
          supplierName: p.supplierName || null,
        }
      }
      if (p.action === 'DISABLE' && p.productId) {
        const pr = await prisma.product.findUnique({
          where: { id: p.productId },
          select: { id: true, code: true, name: true, spec: true, unit: true, price: true, stock: true, supplier: { select: { name: true } } },
        })
        // 历史 28 天有没有被订过
        const used = await prisma.purchaseOrderItem.count({
          where: { productId: p.productId, purchaseOrder: { createdAt: { gte: new Date(Date.now() - 28 * 86400000) } } },
        })
        return { kind: 'NEW_DISH_DISABLE', product: pr, recentOrders: used }
      }
    }

    return { kind: 'UNKNOWN', payload: p }
  })

  // ── 创建单据 ────────────────────────────────────────────
  app.post('/', auth(app), async (req: any, reply) => {
    const { tenantId, userId, storeId } = req.user
    const { type, title, amount, payload, storeId: bodyStoreId } = req.body as any
    if (!type || !title) return reply.status(400).send({ error: 'type 和 title 必填' })

    const ym = dayjs().format('YYYYMM')
    const count = await prisma.document.count({ where: { tenantId, no: { startsWith: `DOC${ym}` } } })
    const no = `DOC${ym}${String(count + 1).padStart(6, '0')}`

    const plan = routeFor(type as DocumentType, Number(amount || 0))

    const doc = await prisma.document.create({
      data: {
        tenantId, no,
        type, title,
        amount: amount ? Number(amount) : null,
        isOverThreshold: plan.isOverThreshold,
        thresholdRule: plan.thresholdRule || null,
        payload: payload || {},
        storeId: bodyStoreId || storeId || null,
        initiatorId: userId,
        status: plan.autoApprove ? 'AUTO_APPROVED' : 'PENDING',
        finalizedAt: plan.autoApprove ? new Date() : null,
        steps: {
          create: plan.steps.map((r, i) => ({
            seq: i + 1,
            approverRole: r,
            status: 'PENDING' as const,
          })),
        },
      },
      include: { steps: true },
    })

    await prisma.opLog.create({
      data: {
        tenantId, userId,
        action: plan.autoApprove
          ? `提交单据 ${no} (${type}) ¥${amount || 0} → 阈值内自动通过`
          : `提交单据 ${no} (${type}) ¥${amount || 0} → ${plan.steps.join(' → ')}`,
        target: no, entityType: 'Document', targetId: doc.id,
      },
    })

    return reply.status(201).send(doc)
  })

  // ── 审批决策 ────────────────────────────────────────────
  app.post('/:id/decisions', auth(app), async (req: any, reply) => {
    const { tenantId, userId, role } = req.user
    const { id } = req.params as any
    const { decision, comment } = req.body as any
    if (!['APPROVE', 'REJECT'].includes(decision)) {
      return reply.status(400).send({ error: 'decision 必须是 APPROVE 或 REJECT' })
    }
    if (decision === 'REJECT' && !comment?.trim()) {
      return reply.status(400).send({ error: '驳回必须填原因' })
    }

    const doc = await prisma.document.findFirst({
      where: { id, tenantId, status: 'PENDING' },
      include: { steps: { orderBy: { seq: 'asc' } } },
    })
    if (!doc) return reply.status(404).send({ error: '单据不存在或已终结' })

    // 找当前轮到的 step
    const current = doc.steps.find(s => s.status === 'PENDING')
    if (!current) return reply.status(400).send({ error: '无待审步骤' })
    const allowedRoles = approverRolesFor(role)
    if (!allowedRoles.has(current.approverRole)) {
      return reply.status(403).send({ error: `当前轮到 ${current.approverRole} 审批, 你的角色 ${role} 无权处理` })
    }

    if (decision === 'REJECT') {
      await prisma.$transaction([
        prisma.documentStep.update({
          where: { id: current.id },
          data: { status: 'REJECTED', approverId: userId, decidedAt: new Date(), comment: comment || null },
        }),
        prisma.document.update({
          where: { id: doc.id },
          data: { status: 'REJECTED', finalizedAt: new Date() },
        }),
        prisma.documentDecision.create({
          data: { documentId: doc.id, stepId: current.id, userId, decision: 'REJECT', comment },
        }),
      ])
    } else {
      // APPROVE
      const isLast = doc.steps[doc.steps.length - 1].id === current.id
      const ops: any[] = [
        prisma.documentStep.update({
          where: { id: current.id },
          data: { status: 'APPROVED', approverId: userId, decidedAt: new Date(), comment: comment || null },
        }),
        prisma.documentDecision.create({
          data: { documentId: doc.id, stepId: current.id, userId, decision: 'APPROVE', comment: comment || null },
        }),
      ]
      if (isLast) {
        ops.push(prisma.document.update({
          where: { id: doc.id },
          data: { status: 'APPROVED', finalizedAt: new Date() },
        }))
      }
      await prisma.$transaction(ops)

      // ── 终态回调: 审批通过后, 按 type 应用业务变更 ─────────
      if (isLast) {
        const payload = (doc.payload as any) || {}
        let touchedProducts = false
        if (doc.type === 'PRICE_ADJUSTMENT' && payload.productId && payload.newPrice != null) {
          await prisma.product.update({
            where: { id: payload.productId },
            data: { price: Number(payload.newPrice) },
          }).catch(e => req.log?.error({ err: e }, '调价回调失败'))
          touchedProducts = true
        } else if (doc.type === 'NEW_DISH') {
          if (payload.action === 'CREATE' && payload.productId) {
            await prisma.product.update({
              where: { id: payload.productId }, data: { status: 'ENABLED' },
            }).catch(e => req.log?.error({ err: e }, '新品上架回调失败'))
            touchedProducts = true
          } else if (payload.action === 'BATCH' && Array.isArray(payload.productIds)) {
            await prisma.product.updateMany({
              where: { id: { in: payload.productIds } }, data: { status: 'ENABLED' },
            }).catch(e => req.log?.error({ err: e }, '批量上架回调失败'))
            touchedProducts = true
          } else if (payload.action === 'DISABLE' && payload.productId) {
            await prisma.product.update({
              where: { id: payload.productId }, data: { status: 'DISABLED' },
            }).catch(e => req.log?.error({ err: e }, '停售回调失败'))
            touchedProducts = true
          }
        }
        // 关键修复: 任何 product 变更后必须刷缓存, 否则 GET /api/products 还返回 600s 旧数据
        if (touchedProducts) void invalidatePattern(`products:full:${tenantId}:*`)
      }
    }
    // REJECT 回滚 + 同样要刷缓存
    if (decision === 'REJECT') {
      const payload = (doc.payload as any) || {}
      let touchedProducts = false
      if (doc.type === 'NEW_DISH') {
        if ((payload.action === 'CREATE') && payload.productId) {
          await prisma.product.deleteMany({ where: { id: payload.productId, status: 'PENDING_APPROVAL' as any } })
            .catch(e => req.log?.error({ err: e }, '新品拒绝-删除失败'))
          touchedProducts = true
        } else if (payload.action === 'BATCH' && Array.isArray(payload.productIds)) {
          await prisma.product.deleteMany({ where: { id: { in: payload.productIds }, status: 'PENDING_APPROVAL' as any } })
            .catch(e => req.log?.error({ err: e }, '批量拒绝-删除失败'))
          touchedProducts = true
        } else if (payload.action === 'DISABLE' && payload.productId) {
          await prisma.product.updateMany({ where: { id: payload.productId, status: 'PENDING_DISABLE' as any }, data: { status: 'ENABLED' } })
            .catch(e => req.log?.error({ err: e }, '停售拒绝-恢复失败'))
          touchedProducts = true
        }
      }
      if (touchedProducts) void invalidatePattern(`products:full:${tenantId}:*`)
    }

    await prisma.opLog.create({
      data: {
        tenantId, userId,
        action: `${decision === 'APPROVE' ? '批准' : '驳回'}单据 ${doc.no} 步骤 ${current.seq}`,
        target: doc.no, entityType: 'Document', targetId: doc.id,
      },
    })

    return { success: true, decision, finalized: doc.steps[doc.steps.length - 1].id === current.id || decision === 'REJECT' }
  })

  // ── 撤回（发起人）────────────────────────────────────────
  app.patch('/:id/cancel', auth(app), async (req: any, reply) => {
    const { tenantId, userId } = req.user
    const doc = await prisma.document.findFirst({
      where: { id: req.params.id, tenantId, status: 'PENDING', initiatorId: userId },
    })
    if (!doc) return reply.status(404).send({ error: '单据不存在或不可撤回' })
    await prisma.document.update({
      where: { id: doc.id },
      data: { status: 'CANCELED', finalizedAt: new Date() },
    })
    await prisma.opLog.create({
      data: { tenantId, userId, action: `撤回单据 ${doc.no}`, target: doc.no, entityType: 'Document', targetId: doc.id },
    })
    return { success: true }
  })
}
