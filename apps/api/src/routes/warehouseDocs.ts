import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import { hasInternalSupplyChainCapability, isInternalSupplyChainRole } from '../lib/internal-supply-chain-access'
import {
  confirmWarehouseDoc,
  editWarehouseDoc,
  unconfirmWarehouseDoc,
} from '../services/warehouseDocs'

// 仓库单据（审核流）：台账之上的控制层。
// 读：仓库/财务可见；改单：仓库写角色；审核/反审核：会计（FINANCE）与管理员。
const READ_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'PURCHASER'])
const WRITE_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'PURCHASER'])
const AUDIT_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'FINANCE'])

function hasDocAccess(role: string, capability: 'read' | 'write' | 'audit') {
  if (isInternalSupplyChainRole(role)) {
    // 内部供应链（SUPPLY_CHAIN）：读写+审核均可（身兼供应链管理员）
    return hasInternalSupplyChainCapability(role, capability === 'read' ? 'inventory.read' : 'inventory.write')
  }
  if (capability === 'read') return READ_ROLES.has(role)
  if (capability === 'write') return WRITE_ROLES.has(role)
  return AUDIT_ROLES.has(role)
}

function requireDocAccess(capability: 'read' | 'write' | 'audit', message: string) {
  return async (req: any, reply: any) => {
    if (!hasDocAccess(req.user?.role, capability)) {
      return reply.status(403).send({ error: message })
    }
  }
}

const editSchema = z.object({
  editReason: z.string().trim().min(2, '请填写修改原因').max(240),
  supplierId: z.string().trim().min(1).optional(),
  note: z.string().trim().max(240).optional().nullable(),
  reason: z.string().trim().max(120).optional().nullable(),
  lines: z.array(z.object({
    lineId: z.string().trim().min(1),
    amount: z.number().positive().max(999_999_999.99).optional().nullable(),
    quantity: z.number().positive().max(99_999_999).optional().nullable(),
    note: z.string().trim().max(240).optional().nullable(),
    batchNo: z.string().trim().max(80).optional().nullable(),
    manufactureDate: z.string().date().optional().nullable(),
    expiryDate: z.string().date().optional().nullable(),
  })).max(200).default([]),
})

export const warehouseDocsRoutes: FastifyPluginAsync = async app => {
  const authRead = { preHandler: [(app as any).authenticate, requireDocAccess('read', '无权查看仓库单据')] }
  const authWrite = { preHandler: [(app as any).authenticate, requireDocAccess('write', '无权修改仓库单据')] }
  const authAudit = { preHandler: [(app as any).authenticate, requireDocAccess('audit', '只有会计/管理员可以审核单据')] }

  // 单据列表
  app.get('/', authRead, async (req: any) => {
    const query = req.query as any
    const type = query.type === 'MANUAL_INBOUND' || query.type === 'MANUAL_OUTBOUND' ? query.type : undefined
    const status = query.status === 'POSTED' || query.status === 'CONFIRMED' ? query.status : undefined
    const page = Math.max(1, Number(query.page) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 20))
    const where: any = { tenantId: req.user.tenantId }
    if (type) where.type = type
    if (status) where.status = status
    if (query.supplierId) where.supplierId = String(query.supplierId)
    if (query.productId) where.lines = { some: { productId: String(query.productId) } }
    if (query.from || query.to) {
      where.effectiveAt = {}
      if (query.from) where.effectiveAt.gte = new Date(`${query.from}T00:00:00+08:00`)
      if (query.to) where.effectiveAt.lte = new Date(`${query.to}T23:59:59.999+08:00`)
    }
    const term = String(query.q || '').trim()
    const termProducts = term ? await prisma.product.findMany({
      where: { tenantId: req.user.tenantId, OR: [
        { code: { contains: term, mode: 'insensitive' } },
        { name: { contains: term, mode: 'insensitive' } },
      ] },
      select: { id: true, code: true, name: true }, take: 201,
    }) : []
    if (term) where.OR = [
      { docNo: { contains: term, mode: 'insensitive' } },
      { lines: { some: { productName: { contains: term, mode: 'insensitive' } } } },
      ...(termProducts.length ? [{ lines: { some: { productId: { in: termProducts.map(product => product.id) } } } }] : []),
    ]
    const [items, total] = await Promise.all([
      prisma.warehouseDoc.findMany({
        where,
        orderBy: [{ effectiveAt: 'desc' }, { docNo: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.warehouseDoc.count({ where }),
    ])
    const exactProducts = termProducts.filter(product => product.code.toLowerCase() === term.toLowerCase() || product.name.toLowerCase() === term.toLowerCase())
    const matchedProduct = exactProducts.length === 1 ? exactProducts[0] : termProducts.length === 1 ? termProducts[0] : null
    return { items, total, page, pageSize, matchedProduct }
  })

  // 单据详情（含行明细与操作日志）
  app.get('/:id', authRead, async (req: any, reply: any) => {
    const doc = await prisma.warehouseDoc.findFirst({
      where: { id: String(req.params.id), tenantId: req.user.tenantId },
      include: {
        lines: { orderBy: { lineNo: 'asc' } },
        logs: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    })
    if (!doc) return reply.status(404).send({ error: '单据不存在' })
    return doc
  })

  // 会计审核
  app.post('/:id/confirm', authAudit, async (req: any, reply: any) => {
    try {
      const result = await confirmWarehouseDoc({
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        docId: String(req.params.id),
      })
      return { ok: true, changed: result.changed, status: result.doc.status }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  // 会计反审核（必填退回原因）
  app.post('/:id/unconfirm', authAudit, async (req: any, reply: any) => {
    const parsed = z.object({ reason: z.string().trim().min(2, '请填写退回原因').max(240) }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    try {
      const result = await unconfirmWarehouseDoc({
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        docId: String(req.params.id),
        reason: parsed.data.reason,
      })
      return { ok: true, status: result.doc.status }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  // 反审核后编辑（金额走差额调整流水；入库数量在批次未动时冲销重记）
  app.put('/:id', authWrite, async (req: any, reply: any) => {
    const parsed = editSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    try {
      const result = await editWarehouseDoc({
        tenantId: req.user.tenantId,
        userId: req.user.userId,
        docId: String(req.params.id),
        editReason: parsed.data.editReason,
        supplierId: parsed.data.supplierId,
        note: parsed.data.note,
        reason: parsed.data.reason,
        lines: parsed.data.lines,
      })
      return { ok: true, changed: result.changed, doc: result.doc }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })
}
