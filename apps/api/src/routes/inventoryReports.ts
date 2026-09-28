import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { hasInternalSupplyChainCapability, isInternalSupplyChainRole } from '../lib/internal-supply-chain-access'
import { loadInventoryReport, reportIds, reportQuerySchema } from '../services/inventoryReports'
import {
  inventoryPolicyFingerprint,
  inventoryAlertStatus,
  inventoryPolicySnapshot,
  resolveInventoryRule,
  warehouseInventoryPolicyWriteSchema,
} from '../services/warehouseInventoryPolicy'

export function inventoryReportAccess(role: string, write = false) {
  if (isInternalSupplyChainRole(role)) return hasInternalSupplyChainCapability(role, write ? 'inventory.write' : 'inventory.read')
  return (write ? ['SUPER_ADMIN', 'ADMIN'] : ['SUPER_ADMIN', 'ADMIN', 'FINANCE']).includes(role)
}

const policyListQuerySchema = z.object({
  warehouseId: z.string().trim().min(1).max(64).optional(),
  q: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})

const POLICY_WRITE_ROLES = new Set(['SUPPLY_CHAIN', 'ADMIN', 'SUPER_ADMIN'])

async function policyWarehouse(tenantId: string, warehouseId?: string) {
  const warehouse = await prisma.warehouse.findFirst({
    where: warehouseId
      ? { tenantId, id: warehouseId, isActive: true }
      : { tenantId, isDefault: true, isActive: true },
    select: { id: true, code: true, name: true },
  })
  if (!warehouse) throw Object.assign(new Error(warehouseId ? '仓库不存在、已停用或不属于当前租户' : '当前租户未配置启用的默认仓'), { statusCode: 404 })
  return warehouse
}

export const inventoryReportRoutes: FastifyPluginAsync = async app => {
  app.get('/policies', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    if (!req.user?.tenantId || !inventoryReportAccess(req.user.role)) return reply.status(403).send({ error: '无权查看库存规则' })
    const query = policyListQuerySchema.safeParse(req.query || {})
    if (!query.success) return reply.status(400).send({ error: query.error.issues[0].message })
    try {
      const warehouse = await policyWarehouse(req.user.tenantId, query.data.warehouseId)
      const warehouses = await prisma.warehouse.findMany({ where: { tenantId: req.user.tenantId, isActive: true }, select: { id: true, code: true, name: true, isDefault: true }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] })
      const terms = query.data.q.split(/\s+/).filter(Boolean)
      const productWhere: Prisma.ProductWhereInput = {
        tenantId: req.user.tenantId,
        status: { in: ['ENABLED', 'DISABLED'] },
        ...(terms.length ? { AND: terms.map(term => ({ OR: [
          { code: { contains: term, mode: 'insensitive' as const } },
          { name: { contains: term, mode: 'insensitive' as const } },
          { category: { contains: term, mode: 'insensitive' as const } },
        ] })) } : {}),
      }
      const [products, total] = await prisma.$transaction([
        prisma.product.findMany({ where: productWhere, orderBy: [{ category: 'asc' }, { code: 'asc' }], skip: (query.data.page - 1) * query.data.pageSize, take: query.data.pageSize }),
        prisma.product.count({ where: productWhere }),
      ])
      const productIds = products.map(product => product.id)
      const [policies, balances] = productIds.length ? await prisma.$transaction([
        prisma.warehouseInventoryPolicy.findMany({ where: { tenantId: req.user.tenantId, warehouseId: warehouse.id, productId: { in: productIds } } }),
        prisma.warehouseLedgerBalance.findMany({ where: { tenantId: req.user.tenantId, warehouseId: warehouse.id, productId: { in: productIds } } }),
      ]) : [[], []]
      const policyByProduct = new Map(policies.map(policy => [policy.productId, policy]))
      const balanceByProduct = new Map(balances.map(balance => [balance.productId, balance]))
      return {
        warehouse,
        items: products.map(product => {
          const policy = policyByProduct.get(product.id)
          const balance = balanceByProduct.get(product.id)
          const inventoryUnit = balance?.inventoryUnit || product.inventoryUnit || product.unit
          const rule = resolveInventoryRule(product, policy, inventoryUnit)
          const currentQty = balance ? Number(balance.physicalQty) : 0
          return {
            productId: product.id, code: product.code, name: product.name, spec: product.spec, category: product.category,
            inventoryUnit, currentQty,
            minQty: policy?.minQty == null ? rule.minQty : Number(policy.minQty),
            maxQty: policy?.maxQty == null ? rule.maxQty : Number(policy.maxQty),
            stagnantDays: policy?.stagnantDays ?? rule.stagnantDays,
            source: policy && !policy.active ? 'disabled' : rule.source,
            alertStatus: inventoryAlertStatus(currentQty, rule),
            active: policy?.active ?? rule.source === 'legacy-fallback', rowVersion: policy?.rowVersion ?? 0,
            hasPolicy: Boolean(policy),
            unitChanged: Boolean(policy && policy.inventoryUnitSnapshot !== inventoryUnit),
          }
        }),
        warehouses, total, page: query.data.page, pageSize: query.data.pageSize,
      }
    } catch (error: any) {
      return reply.status(error?.statusCode || 500).send({ error: error?.message || '库存规则查询失败' })
    }
  })

  app.patch('/policies/:productId', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    if (!req.user?.tenantId || !POLICY_WRITE_ROLES.has(req.user.role) || !inventoryReportAccess(req.user.role, true)) {
      return reply.status(403).send({ error: '仅供应链、管理员可配置库存规则' })
    }
    const productId = z.string().trim().min(1).max(100).safeParse(req.params?.productId)
    const body = warehouseInventoryPolicyWriteSchema.safeParse(req.body || {})
    if (!productId.success || !body.success) return reply.status(400).send({ error: !body.success ? body.error.issues[0].message : '商品参数无效' })
    let requestFingerprint = ''
    try {
      const warehouse = await policyWarehouse(req.user.tenantId, body.data.warehouseId)
      const actor = await prisma.user.findFirst({ where: { tenantId: req.user.tenantId, id: req.user.userId }, select: { id: true, name: true, role: true } })
      if (!actor) return reply.status(403).send({ error: '当前账号不属于当前租户' })
      const fingerprint = inventoryPolicyFingerprint(productId.data, warehouse.id, body.data)
      requestFingerprint = fingerprint
      const result = await prisma.$transaction(async tx => {
        const replay = await tx.warehouseInventoryPolicyEvent.findUnique({ where: { tenantId_requestId: { tenantId: req.user.tenantId, requestId: body.data.requestId } } })
        if (replay) {
          if (replay.requestFingerprint !== fingerprint) throw Object.assign(new Error('同一 requestId 不能用于不同库存规则内容'), { statusCode: 409 })
          return { policy: replay.afterValue, replayed: true }
        }
        const product = await tx.product.findFirst({ where: { tenantId: req.user.tenantId, id: productId.data }, select: { id: true, inventoryUnit: true, unit: true, unitConversionStatus: true } })
        if (!product) throw Object.assign(new Error('商品不存在或不属于当前租户'), { statusCode: 404 })
        if (product.unitConversionStatus !== 'VERIFIED' || !product.inventoryUnit) throw Object.assign(new Error('请先核验商品库存基准单位后再配置库存规则'), { statusCode: 409 })
        const existing = await tx.warehouseInventoryPolicy.findUnique({ where: { tenantId_warehouseId_productId: { tenantId: req.user.tenantId, warehouseId: warehouse.id, productId: product.id } } })
        if (existing && existing.inventoryUnitSnapshot !== product.inventoryUnit && !body.data.confirmUnitChange) {
          throw Object.assign(new Error(`库存单位已从 ${existing.inventoryUnitSnapshot} 变为 ${product.inventoryUnit}，请人工核对上下限后确认单位变更`), { statusCode: 409 })
        }
        const before = existing ? inventoryPolicySnapshot(existing) : null
        let policy
        if (!existing) {
          if (body.data.rowVersion !== 0) throw Object.assign(new Error('库存规则已变更，请刷新后重试'), { statusCode: 409 })
          policy = await tx.warehouseInventoryPolicy.create({ data: {
            tenantId: req.user.tenantId, warehouseId: warehouse.id, productId: product.id,
            inventoryUnitSnapshot: product.inventoryUnit, minQty: body.data.minQty, maxQty: body.data.maxQty,
            stagnantDays: body.data.stagnantDays, active: body.data.active,
            createdById: actor.id, createdByName: actor.name, createdByRole: actor.role,
            updatedById: actor.id, updatedByName: actor.name, updatedByRole: actor.role,
          } })
        } else {
          const updated = await tx.warehouseInventoryPolicy.updateMany({
            where: { tenantId: req.user.tenantId, id: existing.id, rowVersion: body.data.rowVersion },
            data: {
              inventoryUnitSnapshot: product.inventoryUnit, minQty: body.data.minQty, maxQty: body.data.maxQty,
              stagnantDays: body.data.stagnantDays, active: body.data.active, rowVersion: { increment: 1 },
              updatedById: actor.id, updatedByName: actor.name, updatedByRole: actor.role,
            },
          })
          if (updated.count !== 1) throw Object.assign(new Error('库存规则已被其他人修改，请刷新后重试'), { statusCode: 409 })
          policy = await tx.warehouseInventoryPolicy.findFirstOrThrow({ where: { tenantId: req.user.tenantId, id: existing.id } })
        }
        const after = inventoryPolicySnapshot(policy)
        await tx.warehouseInventoryPolicyEvent.create({ data: {
          tenantId: req.user.tenantId, policyId: policy.id, actorId: actor.id, actorName: actor.name, actorRole: actor.role,
          requestId: body.data.requestId, requestFingerprint: fingerprint,
          beforeValue: before === null ? Prisma.JsonNull : before, afterValue: after,
        } })
        return { policy: after, replayed: false }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return result
    } catch (error: any) {
      if (requestFingerprint && (error?.code === 'P2002' || error?.code === 'P2034')) {
        const replay = await prisma.warehouseInventoryPolicyEvent.findUnique({ where: { tenantId_requestId: { tenantId: req.user.tenantId, requestId: body.data.requestId } } })
        if (replay?.requestFingerprint === requestFingerprint) return { policy: replay.afterValue, replayed: true }
        if (replay) return reply.status(409).send({ error: '同一 requestId 不能用于不同库存规则内容' })
      }
      return reply.status(error?.statusCode || (error?.code === 'P2002' || error?.code === 'P2034' ? 409 : 500)).send({ error: error?.message || '库存规则保存失败' })
    }
  })

  app.get('/:report', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    if (!req.user?.tenantId || !inventoryReportAccess(req.user.role)) return reply.status(403).send({ error: '无权查看库存报表' })
    const id = z.enum(reportIds).safeParse(req.params.report)
    const query = reportQuerySchema.safeParse(req.query)
    if (!id.success || !query.success) return reply.status(400).send({ error: !query.success ? query.error.issues[0].message : '报表不存在' })
    const result = await prisma.$transaction(tx => loadInventoryReport(tx, req.user.tenantId, id.data, query.data), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30000 })
    if (query.data.export !== '1') return result
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet(result.title)
    sheet.columns = result.columns.map(c => ({ header: c.group ? `${c.group} · ${c.label}` : c.label, key: c.key, width: c.kind === 'number' ? 20 : 26 }))
    for (const row of result.rows) sheet.addRow(Object.fromEntries(result.columns.map(c => [c.key, row[c.key] ?? null])))
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
    sheet.getRow(1).font = { bold: true }
    sheet.autoFilter = { from: 'A1', to: { row: 1, column: result.columns.length } }
    workbook.addWorksheet('口径说明').addRows([[result.note], [`导出时间：${result.generatedAt}`], [`筛选条件：${JSON.stringify(query.data)}`]])
    const buffer = await workbook.xlsx.writeBuffer()
    return { filename: `${result.title}-${query.data.end}.xlsx`, fileBase64: Buffer.from(buffer).toString('base64'), total: result.total }
  })
}
