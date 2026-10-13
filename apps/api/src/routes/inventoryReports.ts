import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import ExcelJS from 'exceljs'
import { changeInventoryPolicy, policyRevisionView } from '../services/inventoryPolicyApproval'
import { z } from 'zod'
import {inventoryPolicyRow} from '../services/inventoryPolicyRead'
import { hasInternalSupplyChainCapability, isInternalSupplyChainRole } from '../lib/internal-supply-chain-access'
import { loadInventoryReport, reportIds, reportQuerySchema } from '../services/inventoryReports'
import {
  STAGNANT_REMINDER_DAYS,
  inventoryAlertStatus,
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
      const [policies, balances, revisions] = productIds.length ? await prisma.$transaction([
        prisma.warehouseInventoryPolicy.findMany({ where: { tenantId: req.user.tenantId, warehouseId: warehouse.id, productId: { in: productIds } } }),
        prisma.warehouseLedgerBalance.findMany({ where: { tenantId: req.user.tenantId, warehouseId: warehouse.id, productId: { in: productIds } } }),
        prisma.warehouseInventoryPolicyRevision.findMany({ where: { tenantId: req.user.tenantId, warehouseId: warehouse.id, productId: { in: productIds },isCurrent:true } }),
      ], {isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead}) : [[], [], []]
      const revisionByProduct = new Map(revisions.map(revision => [revision.productId, revision]))
      const policyByProduct = new Map(policies.map(policy => [policy.productId, policy]))
      const balanceByProduct = new Map(balances.map(balance => [balance.productId, balance]))
      return {
        warehouse,
        items: products.map(product => inventoryPolicyRow(product,policyByProduct.get(product.id),balanceByProduct.get(product.id),revisionByProduct.get(product.id))),
        warehouses, total, page: query.data.page, pageSize: query.data.pageSize,
      }
    } catch (error: any) {
      return reply.status(error?.statusCode || 500).send({ error: error?.message || '库存规则查询失败' })
    }
  })

  const exactPolicyQuery=z.object({warehouseId:z.string().trim().min(1).max(64)}).strict()
  app.get('/policies/:productId', {preHandler:[(app as any).authenticate]}, async(req:any,reply)=>{
    if(!req.user?.tenantId||!inventoryReportAccess(req.user.role))return reply.status(403).send({error:'无权查看库存规则'})
    const id=z.string().trim().min(1).max(100).safeParse(req.params.productId),query=exactPolicyQuery.safeParse(req.query)
    if(!id.success||!query.success)return reply.status(400).send({error:'请明确商品和仓库，不会替换为默认仓'})
    try{
      const warehouse=await policyWarehouse(req.user.tenantId,query.data.warehouseId)
      return await prisma.$transaction(async tx=>{
        const scope={tenantId:req.user.tenantId,warehouseId:warehouse.id,productId:id.data}
        const product=await tx.product.findFirst({where:{id:id.data,tenantId:req.user.tenantId}})
        if(!product)throw Object.assign(Error('商品不存在或不属于当前租户'),{statusCode:404})
        const [policy,balance,revision,tenant]=await Promise.all([
          tx.warehouseInventoryPolicy.findFirst({where:scope}),tx.warehouseLedgerBalance.findFirst({where:scope}),
          tx.warehouseInventoryPolicyRevision.findFirst({where:{...scope,isCurrent:true}}),tx.tenant.findUnique({where:{id:req.user.tenantId},select:{name:true}}),
        ])
        return {warehouse,warehouses:[warehouse],items:[inventoryPolicyRow(product,policy,balance,revision)],total:1,page:1,pageSize:1,organizationName:tenant?.name||''}
      },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead})
    }catch(error:any){return reply.status(error.statusCode||500).send({error:error.message||'库存规则读取失败'})}
  })
  app.get('/policies/:productId/history', {preHandler:[(app as any).authenticate]}, async(req:any,reply)=>{
    if(!req.user?.tenantId||!inventoryReportAccess(req.user.role))return reply.status(403).send({error:'无权查看库存规则'})
    const id=z.string().trim().min(1).max(100).safeParse(req.params.productId),query=exactPolicyQuery.extend({page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20)}).strict().safeParse(req.query)
    if(!id.success||!query.success)return reply.status(400).send({error:'请明确商品、仓库及有效日志分页'})
    try{
      const warehouse=await policyWarehouse(req.user.tenantId,query.data.warehouseId)
      if(!await prisma.product.findFirst({where:{id:id.data,tenantId:req.user.tenantId},select:{id:true}}))return reply.status(404).send({error:'商品不存在或不属于当前租户'})
      const tenantId=req.user.tenantId,scope={tenantId,warehouseId:warehouse.id,productId:id.data}
      return await prisma.$transaction(async tx=>{
        const standalonePolicyWhere=Prisma.sql`e."tenantId"=${tenantId} AND p."tenantId"=${tenantId} AND p."warehouseId"=${warehouse.id} AND p."productId"=${id.data}
          AND NOT EXISTS (SELECT 1 FROM warehouse_inventory_policy_revision_events re JOIN warehouse_inventory_policy_revisions rr ON rr.id=re."revisionId" AND rr."tenantId"=re."tenantId"
            WHERE re."tenantId"=e."tenantId" AND re."requestId"=e."requestId" AND rr."warehouseId"=p."warehouseId" AND rr."productId"=p."productId" AND re.action IN ('review','unreview'))`
        const [revisionCount,policyCounts]=await Promise.all([
          tx.warehouseInventoryPolicyRevisionEvent.count({where:{tenantId,revision:scope}}),
          tx.$queryRaw<Array<{total:bigint}>>(Prisma.sql`SELECT COUNT(*) AS total FROM warehouse_inventory_policy_events e JOIN warehouse_inventory_policies p ON p.id=e."policyId" AND p."tenantId"=e."tenantId" WHERE ${standalonePolicyWhere}`),
        ])
        const legacyCount=Number(policyCounts[0].total)
        const items=await tx.$queryRaw<Array<Record<string,unknown>>>(Prisma.sql`
          SELECT * FROM (
            SELECT 'revision:' || e.id AS id, 'REVISION' AS "sourceType", e.action, e."actorName", e."actorRole", e."createdAt", e."beforeValue", e."afterValue",
              json_build_object('id',r.id,'cycleNumber',r."cycleNumber",'status',r.status,'isCurrent',r."isCurrent") AS revision,
              (SELECT json_build_object('id',pe.id,'actorName',pe."actorName",'actorRole',pe."actorRole",'createdAt',pe."createdAt",'beforeValue',pe."beforeValue",'afterValue',pe."afterValue")
                FROM warehouse_inventory_policy_events pe JOIN warehouse_inventory_policies pp ON pp.id=pe."policyId" AND pp."tenantId"=pe."tenantId"
                WHERE pe."tenantId"=e."tenantId" AND pe."requestId"=e."requestId" AND pp."warehouseId"=r."warehouseId" AND pp."productId"=r."productId" AND e.action IN ('review','unreview')) AS "effectiveEvent"
            FROM warehouse_inventory_policy_revision_events e JOIN warehouse_inventory_policy_revisions r ON r.id=e."revisionId" AND r."tenantId"=e."tenantId"
            WHERE e."tenantId"=${tenantId} AND r."tenantId"=${tenantId} AND r."warehouseId"=${warehouse.id} AND r."productId"=${id.data}
            UNION ALL
            SELECT 'policy:' || e.id AS id, 'POLICY' AS "sourceType", 'policy_update' AS action, e."actorName", e."actorRole", e."createdAt", e."beforeValue", e."afterValue", NULL::json AS revision, NULL::json AS "effectiveEvent"
            FROM warehouse_inventory_policy_events e JOIN warehouse_inventory_policies p ON p.id=e."policyId" AND p."tenantId"=e."tenantId"
            WHERE ${standalonePolicyWhere}
          ) history ORDER BY "createdAt" DESC, id DESC LIMIT ${query.data.pageSize} OFFSET ${(query.data.page-1)*query.data.pageSize}
        `)
        return {items,total:revisionCount+legacyCount,page:query.data.page,pageSize:query.data.pageSize}
      },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead})
    }catch(error:any){return reply.status(error.statusCode||500).send({error:error.message||'库存规则日志读取失败'})}
  })

  app.patch('/policies/:productId', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    if (!req.user?.tenantId || !POLICY_WRITE_ROLES.has(req.user.role) || !inventoryReportAccess(req.user.role, true)) {
      return reply.status(403).send({ error: '仅供应链、管理员可配置库存规则' })
    }
    const productId = z.string().trim().min(1).max(100).safeParse(req.params?.productId)
    const body = warehouseInventoryPolicyWriteSchema.safeParse(req.body || {})
    if (!productId.success || !body.success) return reply.status(400).send({ error: !body.success ? body.error.issues[0].message : '商品参数无效' })
    try {
      const warehouse = await policyWarehouse(req.user.tenantId, body.data.warehouseId)
      return await changeInventoryPolicy({ tenantId: req.user.tenantId, userId: req.user.userId, productId: productId.data, warehouseId: warehouse.id, action: 'save', requestId: body.data.requestId, rowVersion: body.data.draftVersion, values: body.data })
    } catch (error: any) { return reply.status(error?.statusCode || 500).send({ error: error?.message || '规则草稿保存失败' }) }
  })

  app.post('/policies/:productId/:action', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    if (!req.user?.tenantId || !POLICY_WRITE_ROLES.has(req.user.role) || !inventoryReportAccess(req.user.role, true)) return reply.status(403).send({ error: '仅供应链可处理库存规则审批' })
    const params = z.object({ productId: z.string().min(1).max(100), action: z.enum(['submit','audit','unconfirm','review','unreview','revise']) }).safeParse(req.params)
    const body = z.object({ warehouseId: z.string().min(1).max(64).optional(), rowVersion: z.number().int().min(0), revisionId:z.string().min(1).max(64), requestId: z.string().min(8).max(100) }).strict().safeParse(req.body)
    if (!params.success || !body.success) return reply.status(400).send({ error: '审批参数无效' })
    try {
      const warehouse = await policyWarehouse(req.user.tenantId, body.data.warehouseId)
      return await changeInventoryPolicy({ tenantId: req.user.tenantId, userId: req.user.userId, productId: params.data.productId, warehouseId: warehouse.id, action: params.data.action, requestId: body.data.requestId, rowVersion: body.data.rowVersion,revisionId:body.data.revisionId })
    } catch (error: any) { return reply.status(error?.statusCode || 500).send({ error: error?.message || '规则审批失败' }) }
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
