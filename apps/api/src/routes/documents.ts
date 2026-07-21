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
import { routeFor, DocumentType, Role } from '../services/documentRouting'
import { nextDocumentNo } from '../services/documentNo'
import { invalidatePattern } from '../lib/cache'
import { isSupplierRole, requireStoreBinding } from '../lib/auth-scope'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const GROUP_DOCUMENT_ROLES = new Set(['BOSS', 'ADMIN', 'SUPER_ADMIN', 'FINANCE', 'CHEF_DIRECTOR', 'CHEF', 'ENGINEERING'])
const SUPPLIER_OFFER_DOCUMENT_TYPES = new Set(['NEW_DISH', 'SUPPLIER_OFFER_CREATE', 'SUPPLIER_OFFER_DISABLE'])

/** 把当前用户的角色映射到能批的 step.role 集合（处理 BOSS/ADMIN/CHEF 别名）*/
function approverRolesFor(role: string): Set<string> {
  const set = new Set<string>([role])
  if (role === 'ADMIN' || role === 'SUPER_ADMIN') set.add('BOSS')
  if (role === 'BOSS') { set.add('ADMIN'); set.add('SUPER_ADMIN') }
  if (role === 'CHEF') set.add('CHEF_DIRECTOR')
  if (role === 'CHEF_DIRECTOR') set.add('CHEF')
  return set
}

async function supplierCanViewPayload(
  tenantId: string,
  supplierId: string | null | undefined,
  payload: unknown,
): Promise<boolean> {
  if (!supplierId) return false
  const value = (payload as any) || {}
  if (value.supplierId) return value.supplierId === supplierId
  if (value.batchId) {
    const batch = await prisma.productBatch.findFirst({
      where: { id: value.batchId, tenantId }, select: { supplierId: true },
    })
    if (batch) return batch.supplierId === supplierId
  }
  if (value.productId) {
    const product = await prisma.product.findFirst({
      where: { id: value.productId, tenantId }, select: { supplierId: true },
    })
    if (product) return product.supplierId === supplierId
  }
  if (Array.isArray(value.productIds) && value.productIds.length > 0) {
    const productCount = await prisma.product.count({
      where: { id: { in: value.productIds }, tenantId, supplierId },
    })
    if (productCount > 0) return productCount === new Set(value.productIds).size
  }
  if (!value.supplierName) return false
  const matchingSuppliers = await prisma.supplier.findMany({
    where: { tenantId, name: value.supplierName }, select: { id: true }, take: 2,
  })
  return matchingSuppliers.length === 1 && matchingSuppliers[0].id === supplierId
}

async function applyProductDecision(
  tx: any,
  doc: { type: string; payload: unknown },
  tenantId: string,
  decision: 'APPROVE' | 'REJECT',
): Promise<boolean> {
  const payload = (doc.payload as any) || {}
  if (decision === 'APPROVE' && doc.type === 'PRICE_ADJUSTMENT' && payload.productId && payload.newPrice != null) {
    await tx.product.updateMany({
      where: { id: payload.productId, tenantId },
      data: { price: Number(payload.newPrice) },
    })
    return true
  }
  if (!SUPPLIER_OFFER_DOCUMENT_TYPES.has(doc.type)) return false

  if (decision === 'APPROVE') {
    if (payload.action === 'CREATE' && payload.productId) {
      await tx.product.updateMany({
        where: { id: payload.productId, tenantId, status: 'PENDING_APPROVAL' },
        data: { status: 'ENABLED' },
      })
      return true
    }
    if (payload.action === 'BATCH' && Array.isArray(payload.productIds)) {
      if (payload.batchId) {
        const batch = await tx.productBatch.findFirst({
          where: { id: payload.batchId, tenantId }, select: { revokedAt: true },
        })
        if (!batch || batch.revokedAt) {
          throw Object.assign(new Error('商品批次已撤回，不能再批准'), { statusCode: 409 })
        }
      }
      await tx.product.updateMany({
        where: { id: { in: payload.productIds }, tenantId, status: 'PENDING_APPROVAL' },
        data: { status: 'ENABLED' },
      })
      return true
    }
    if (payload.action === 'DISABLE' && payload.productId) {
      await tx.product.updateMany({
        where: { id: payload.productId, tenantId, status: 'PENDING_DISABLE' },
        data: { status: 'DISABLED' },
      })
      return true
    }
    if (payload.action === 'BATCH_DISABLE' && Array.isArray(payload.productIds)) {
      await tx.product.updateMany({
        where: { id: { in: payload.productIds }, tenantId, status: 'PENDING_DISABLE' },
        data: { status: 'DISABLED' },
      })
      return true
    }
    return false
  }

  if (payload.action === 'CREATE' && payload.productId) {
    await tx.product.updateMany({
      where: { id: payload.productId, tenantId, status: 'PENDING_APPROVAL' },
      data: { status: 'DISABLED' },
    })
    return true
  }
  if (payload.action === 'BATCH' && Array.isArray(payload.productIds)) {
    await tx.product.updateMany({
      where: { id: { in: payload.productIds }, tenantId, status: 'PENDING_APPROVAL' },
      data: { status: 'DISABLED' },
    })
    return true
  }
  if (payload.action === 'DISABLE' && payload.productId) {
    await tx.product.updateMany({
      where: { id: payload.productId, tenantId, status: 'PENDING_DISABLE' },
      data: { status: 'ENABLED' },
    })
    return true
  }
  if (payload.action === 'BATCH_DISABLE' && Array.isArray(payload.productIds)) {
    await tx.product.updateMany({
      where: { id: { in: payload.productIds }, tenantId, status: 'PENDING_DISABLE' },
      data: { status: 'ENABLED' },
    })
    return true
  }
  return false
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
    if (GROUP_DOCUMENT_ROLES.has(role)) return { ...doc, attachments: [] }
    // 发起人/审批人始终可见
    if (doc.initiatorId === userId) return { ...doc, attachments: [] }
    if (doc.steps.some(s => s.approverId === userId)) return { ...doc, attachments: [] }
    // 店长只看自己店
    if (role === 'MANAGER' || role === 'KITCHEN_LEAD') {
      if (doc.storeId && doc.storeId === storeId) return { ...doc, attachments: [] }
      return reply.status(403).send({ error: '无权查看其他门店或集团单据' })
    }
    // 供应商: 优先按 supplierId；兼容历史单时严格比对当前租户供应商名称。
    if (isSupplierRole(role)) {
      if (await supplierCanViewPayload(tenantId, supplierId, doc.payload)) return { ...doc, attachments: [] }
      return reply.status(403).send({ error: '无权查看其他供应商单据' })
    }
    return { ...doc, attachments: [] }
  })

  // 老前端兼容：cmb-logs 返回空（招行付款流水尚未关联到 documents）
  app.get('/:id/cmb-logs', auth(app), async () => [])

  /** GET /api/documents/:id/preview — 按 type/payload 自动解析出审批所需的业务上下文
   *  PRICE_ADJUSTMENT: 商品 + 旧价 + 新价 + 涨跌幅
   *  SUPPLIER_OFFER_CREATE: 新增供应商商品（单个/批量）
   *  SUPPLIER_OFFER_DISABLE: 停售供应商商品（单个/批量）
   *  NEW_DISH: 仅兼容历史供应商商品审批单和真正的菜品审批
  */
  app.get('/:id/preview', auth(app), async (req: any, reply) => {
    const { tenantId, role, userId, storeId, supplierId } = req.user
    const doc = await prisma.document.findFirst({ where: { id: req.params.id, tenantId } })
    if (!doc) return reply.status(404).send({ error: '单据不存在' })
    if (!GROUP_DOCUMENT_ROLES.has(role) && doc.initiatorId !== userId) {
      const approvedByUser = await prisma.documentStep.count({
        where: { documentId: doc.id, approverId: userId },
      })
      if (approvedByUser === 0 && (role === 'MANAGER' || role === 'KITCHEN_LEAD')) {
        if (!doc.storeId || doc.storeId !== storeId) {
          return reply.status(403).send({ error: '无权预览其他门店或集团单据' })
        }
      } else if (approvedByUser === 0 && isSupplierRole(role)) {
        if (!await supplierCanViewPayload(tenantId, supplierId, doc.payload)) {
          return reply.status(403).send({ error: '无权预览其他供应商单据' })
        }
      }
    }
    const p = (doc.payload as any) || {}

    if (doc.type === 'PRICE_ADJUSTMENT' && p.productId) {
      const pr = await prisma.product.findFirst({
        where: { id: p.productId, tenantId },
        select: { id: true, code: true, name: true, spec: true, unit: true, category: true, price: true, supplier: { select: { name: true } } },
      })
      return {
        kind: 'PRICE_ADJUSTMENT',
        product: pr,
        oldPrice: p.oldPrice, newPrice: p.newPrice,
        delta: p.delta, pct: p.pct,
      }
    }

    if (SUPPLIER_OFFER_DOCUMENT_TYPES.has(doc.type)) {
      if (p.action === 'CREATE' && p.productId) {
        const pr = await prisma.product.findFirst({
          where: { id: p.productId, tenantId },
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
          where: { id: { in: p.productIds.slice(0, limit) }, tenantId },
          select: { id: true, code: true, name: true, spec: true, unit: true, category: true, price: true, status: true },
          orderBy: { name: 'asc' },
        })
        // 统计有价/无价
        const withPrice = await prisma.product.count({ where: { id: { in: p.productIds }, tenantId, price: { gt: 0 } } })
        const noPrice = total - withPrice
        const byCategory: Record<string, number> = {}
        const cats = await prisma.product.findMany({ where: { id: { in: p.productIds }, tenantId }, select: { category: true } })
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
        const pr = await prisma.product.findFirst({
          where: { id: p.productId, tenantId },
          select: { id: true, code: true, name: true, spec: true, unit: true, price: true, stock: true, supplier: { select: { name: true } } },
        })
        // 历史 28 天有没有被订过
        const used = await prisma.purchaseOrderItem.count({
          where: {
            productId: p.productId,
            product: { tenantId },
            purchaseOrder: { tenantId, createdAt: { gte: new Date(Date.now() - 28 * 86400000) } },
          },
        })
        return { kind: 'NEW_DISH_DISABLE', product: pr, recentOrders: used }
      }
      if (p.action === 'BATCH_DISABLE' && Array.isArray(p.productIds)) {
        const products = await prisma.product.findMany({
          where: { id: { in: p.productIds }, tenantId },
          select: { id: true, code: true, name: true, spec: true, unit: true, price: true, stock: true, status: true },
          orderBy: { name: 'asc' },
        })
        return {
          kind: 'NEW_DISH_BATCH_DISABLE',
          total: products.length,
          sample: products.slice(0, 50),
          supplierName: p.supplierName || null,
        }
      }
    }

    return { kind: 'UNKNOWN', payload: p }
  })

  // ── 创建单据 ────────────────────────────────────────────
  app.post('/', auth(app), async (req: any, reply) => {
    const { tenantId, userId, role, storeId } = req.user
    const { type, title, amount, payload, storeId: bodyStoreId } = req.body as any
    if (!type || !title) return reply.status(400).send({ error: 'type 和 title 必填' })

    const scopedStoreId = requireStoreBinding(role, storeId)
    if (scopedStoreId && bodyStoreId && bodyStoreId !== scopedStoreId) {
      return reply.status(403).send({ error: '只能为当前账号绑定的门店发起单据' })
    }
    const documentStoreId = scopedStoreId || bodyStoreId || storeId || null
    if (documentStoreId) {
      const store = await prisma.store.findFirst({ where: { id: documentStoreId, tenantId }, select: { id: true } })
      if (!store) return reply.status(404).send({ error: '门店不存在或不属于当前租户' })
    }

    const plan = routeFor(type as DocumentType, Number(amount || 0))

    const doc = await prisma.$transaction(async tx => {
      const no = await nextDocumentNo(tx, tenantId)
      const created = await tx.document.create({
        data: {
          tenantId, no,
          type, title,
          amount: amount ? Number(amount) : null,
          isOverThreshold: plan.isOverThreshold,
          thresholdRule: plan.thresholdRule || null,
          payload: payload || {},
          storeId: documentStoreId,
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
      await tx.opLog.create({
        data: {
          tenantId, userId,
          action: plan.autoApprove
            ? `提交单据 ${no} (${type}) ¥${amount || 0} → 阈值内自动通过`
            : `提交单据 ${no} (${type}) ¥${amount || 0} → ${plan.steps.join(' → ')}`,
          target: no, entityType: 'Document', targetId: created.id,
        },
      })
      return created
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

    try {
      const result = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`document:${id}`}))`
        const doc = await tx.document.findFirst({
          where: { id, tenantId, status: 'PENDING' },
          include: { steps: { orderBy: { seq: 'asc' } } },
        })
        if (!doc) throw Object.assign(new Error('单据不存在或已终结'), { statusCode: 404 })

        const current = doc.steps.find(step => step.status === 'PENDING')
        if (!current) throw Object.assign(new Error('无待审步骤'), { statusCode: 400 })
        const allowedRoles = approverRolesFor(role)
        if (!allowedRoles.has(current.approverRole)) {
          throw Object.assign(
            new Error(`当前轮到 ${current.approverRole} 审批, 你的角色 ${role} 无权处理`),
            { statusCode: 403 },
          )
        }

        const isLast = doc.steps[doc.steps.length - 1].id === current.id
        await tx.documentStep.update({
          where: { id: current.id },
          data: {
            status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
            approverId: userId, decidedAt: new Date(), comment: comment || null,
          },
        })
        await tx.documentDecision.create({
          data: { documentId: doc.id, stepId: current.id, userId, decision, comment: comment || null },
        })

        let touchedProducts = false
        if (decision === 'REJECT') {
          await tx.document.update({
            where: { id: doc.id }, data: { status: 'REJECTED', finalizedAt: new Date() },
          })
          touchedProducts = await applyProductDecision(tx, doc, tenantId, 'REJECT')
        } else if (isLast) {
          touchedProducts = await applyProductDecision(tx, doc, tenantId, 'APPROVE')
          await tx.document.update({
            where: { id: doc.id }, data: { status: 'APPROVED', finalizedAt: new Date() },
          })
        }

        await tx.opLog.create({
          data: {
            tenantId, userId,
            action: `${decision === 'APPROVE' ? '批准' : '驳回'}单据 ${doc.no} 步骤 ${current.seq}`,
            target: doc.no, entityType: 'Document', targetId: doc.id,
          },
        })
        return { touchedProducts, finalized: isLast || decision === 'REJECT' }
      })
      if (result.touchedProducts) void invalidatePattern(`products:full:${tenantId}:*`)
      return { success: true, decision, finalized: result.finalized }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'document decision failed')
      return reply.status(500).send({ error: '审批失败，未保存任何变更' })
    }
  })

  // ── 撤回（发起人）────────────────────────────────────────
  app.patch('/:id/cancel', auth(app), async (req: any, reply) => {
    const { tenantId, userId } = req.user
    const id = req.params.id as string
    try {
      const touchedProducts = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`document:${id}`}))`
        const doc = await tx.document.findFirst({
          where: { id, tenantId, status: 'PENDING', initiatorId: userId },
        })
        if (!doc) throw Object.assign(new Error('单据不存在或不可撤回'), { statusCode: 404 })
        const touched = await applyProductDecision(tx, doc, tenantId, 'REJECT')
        await tx.document.update({
          where: { id: doc.id }, data: { status: 'CANCELED', finalizedAt: new Date() },
        })
        await tx.opLog.create({
          data: { tenantId, userId, action: `撤回单据 ${doc.no}`, target: doc.no, entityType: 'Document', targetId: doc.id },
        })
        return touched
      })
      if (touchedProducts) void invalidatePattern(`products:full:${tenantId}:*`)
      return { success: true }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'document cancel failed')
      return reply.status(500).send({ error: '撤回失败，未保存任何变更' })
    }
  })
}
