import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import { hasInternalSupplyChainCapability, isInternalSupplyChainRole } from '../lib/internal-supply-chain-access'
import { resolveTenantWarehouseId } from '../services/defaultWarehouse'
import { resolveSupplierIdsByNames } from '../services/supplierAliases'

const READ_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'PURCHASER'])
const WRITE_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'PURCHASER'])
const MULTI_SUPPLIER_SEP = '、'

function hasCapability(role: string, capability: 'read' | 'write') {
  if (isInternalSupplyChainRole(role)) {
    return hasInternalSupplyChainCapability(role, capability === 'read' ? 'inventory.read' : 'inventory.write')
  }
  return (capability === 'read' ? READ_ROLES : WRITE_ROLES).has(role)
}

function requireCapability(capability: 'read' | 'write') {
  return async (req: any, reply: any) => {
    if (!hasCapability(req.user?.role, capability)) {
      return reply.status(403).send({ error: capability === 'read' ? '无权查看供应商别名' : '无权维护供应商别名' })
    }
  }
}

const claimSchema = z.object({
  supplierId: z.string().trim().min(1),
  alias: z.string().trim().min(1).max(120),
  backfill: z.boolean().default(true),
})

/**
 * 供应商名称别名（P2）：
 * - 待认领清单从台账实时派生（supplierId 为空且文本无法自动解析的 sourceName）
 * - 认领 = 建别名，之后数据包/回填自动命中；可同时回填历史台账行
 */
export const supplierAliasRoutes: FastifyPluginAsync = async app => {
  const authRead = { preHandler: [(app as any).authenticate, requireCapability('read')] }
  const authWrite = { preHandler: [(app as any).authenticate, requireCapability('write')] }

  app.get('/', authRead, async (req: any) => {
    const rows = await prisma.supplierNameAlias.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: [{ createdAt: 'desc' }],
      include: { supplier: { select: { id: true, no: true, name: true, status: true } } },
    })
    return { items: rows }
  })

  app.get('/unclaimed', authRead, async (req: any) => {
    const { tenantId } = req.user
    const warehouseId = await resolveTenantWarehouseId(prisma, tenantId, undefined)
    const grouped = await prisma.warehouseLedgerMovement.groupBy({
      by: ['sourceName'],
      where: {
        tenantId,
        warehouseId,
        type: 'MANUAL_INBOUND',
        supplierId: null,
        sourceName: { not: null },
      },
      _count: { _all: true },
      _max: { effectiveAt: true },
      orderBy: { _count: { sourceName: 'desc' } },
      take: 200,
    })
    const names = grouped.map(row => String(row.sourceName || '').trim()).filter(Boolean)
    const resolved = await resolveSupplierIdsByNames(tenantId, names)
    // 能自动解析的交给回填脚本处理，这里只列真正需要人工认领的
    const items = grouped
      .filter(row => {
        const name = String(row.sourceName || '').trim()
        return name && !resolved.has(name)
      })
      .map(row => {
        const name = String(row.sourceName || '').trim()
        return {
          sourceName: name,
          rowCount: row._count._all,
          lastUsedAt: row._max.effectiveAt,
          // 数据包多供应商聚合行的拼合文本，不能认领为单一供应商
          multi: name.includes(MULTI_SUPPLIER_SEP),
        }
      })
    return { items }
  })

  app.post('/', authWrite, async (req: any, reply: any) => {
    const parsed = claimSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const { tenantId, userId } = req.user
    const alias = parsed.data.alias.trim()
    if (alias.includes(MULTI_SUPPLIER_SEP)) {
      return reply.status(400).send({ error: '多供应商拼合文本不能认领为单一供应商' })
    }
    const supplier = await prisma.supplier.findFirst({
      where: { id: parsed.data.supplierId, tenantId },
      select: { id: true, name: true, status: true, businessScopes: true },
    })
    if (!supplier) return reply.status(400).send({ error: '供应商不存在' })
    if (supplier.status !== 'ENABLED') return reply.status(409).send({ error: `供应商「${supplier.name}」已停用` })
    if (!supplier.businessScopes.includes('WAREHOUSE_UPSTREAM')) {
      return reply.status(409).send({ error: `供应商「${supplier.name}」不是总仓上游供应商` })
    }
    // 别名不能与其他供应商的档案名撞车（撞车时精确名匹配会永远赢，别名形同虚设）
    const nameCollision = await prisma.supplier.findFirst({
      where: { tenantId, name: alias, id: { not: supplier.id } },
      select: { id: true, name: true },
    })
    if (nameCollision) {
      return reply.status(409).send({ error: `「${alias}」是供应商「${nameCollision.name}」的档案名，请先改名再认领` })
    }
    const existing = await prisma.supplierNameAlias.findUnique({
      where: { tenantId_alias: { tenantId, alias } },
    })
    if (existing) {
      if (existing.supplierId === supplier.id) return reply.status(409).send({ error: '该别名已认领过' })
      return reply.status(409).send({ error: '该别名已归属其他供应商，如需调整请先删除原别名' })
    }
    const created = await prisma.supplierNameAlias.create({
      data: { tenantId, supplierId: supplier.id, alias, createdById: userId },
    })
    let backfilled = 0
    if (parsed.data.backfill) {
      const warehouseId = await resolveTenantWarehouseId(prisma, tenantId, undefined)
      const result = await prisma.warehouseLedgerMovement.updateMany({
        where: { tenantId, warehouseId, type: 'MANUAL_INBOUND', supplierId: null, sourceName: alias },
        data: { supplierId: supplier.id },
      })
      backfilled = result.count
    }
    await prisma.opLog.create({
      data: {
        tenantId,
        userId,
        action: `认领供应商别名「${alias}」→ ${supplier.name}${backfilled > 0 ? `（回填 ${backfilled} 行台账）` : ''}`,
        target: created.id,
        entityType: 'SupplierNameAlias',
        targetId: created.id,
        metadata: { alias, supplierId: supplier.id, supplierName: supplier.name, backfilled },
      },
    })
    return { ok: true, alias: created, backfilled }
  })

  app.delete('/:id', authWrite, async (req: any, reply: any) => {
    const { tenantId, userId } = req.user
    const id = String((req.params as any).id || '')
    const existing = await prisma.supplierNameAlias.findFirst({ where: { id, tenantId } })
    if (!existing) return reply.status(404).send({ error: '别名不存在' })
    // 只删别名，不动已回填的台账行
    await prisma.supplierNameAlias.delete({ where: { id: existing.id } })
    await prisma.opLog.create({
      data: {
        tenantId,
        userId,
        action: `删除供应商别名「${existing.alias}」`,
        target: existing.id,
        entityType: 'SupplierNameAlias',
        targetId: existing.id,
        metadata: { alias: existing.alias, supplierId: existing.supplierId },
      },
    })
    return { ok: true }
  })
}
