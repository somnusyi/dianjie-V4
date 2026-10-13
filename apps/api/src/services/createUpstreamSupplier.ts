import { createHash } from 'node:crypto'
import { Prisma, prisma } from '@dianjie/db'
import { allocateSupplierNumber } from './supplierNumbering'

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
function failure(message: string, statusCode = 400) { return Object.assign(new Error(message), { statusCode }) }
const fields = ['id', 'no', 'name', 'category', 'status', 'businessScopes', 'inventoryMode', 'contactName', 'contactPhone', 'address', 'creditType', 'creditDays', 'upstreamReceiptReviewThreshold', 'postReceiptClaimHours', 'upstreamSensitiveCategories', 'createdAt', 'updatedAt']

export async function createUpstreamSupplier(input: {
  tenantId: string; userId: string; role: string; requestKey: string
  numberMode?: 'AUTO' | 'MANUAL'; supplier: Record<string, any>; items: Array<Record<string, any>>
}) {
  const { tenantId, userId, role, requestKey, supplier, items } = input
  const numberMode = input.numberMode || 'MANUAL'
  const sortedItems = [...items].sort((a, b) => a.productId.localeCompare(b.productId))
  const ids = sortedItems.map(item => item.productId)
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw failure('必须选择商品，且不得重复')
  if (items.some(item => item.isPrimary)) throw failure('新建供应商不能覆盖已有主供关系')
  const payloadHash = createHash('sha256').update(JSON.stringify(canonical({ supplier, items: sortedItems, ...(numberMode === 'AUTO' ? { numberMode } : {}) }))).digest('hex')
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier-create:${tenantId}:${requestKey}`}))`
        const previous = await tx.supplierCreateRequest.findUnique({ where: { tenantId_requestKey: { tenantId, requestKey } } })
        if (previous) {
          if (previous.actorId !== userId || previous.payloadHash !== payloadHash) throw failure('请求编号已被使用，不能更换账号或内容', 409)
          return { supplier: previous.response, replayed: true }
        }
        // Lock chosen master rows until commit; disabled/deleted products cannot race validation.
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "products" WHERE "tenantId" = ${tenantId} AND "id" IN (${Prisma.join(ids)}) FOR SHARE`)
        const products = await tx.product.findMany({ where: { tenantId, id: { in: ids }, status: 'ENABLED' }, select: { id: true } })
        if (products.length !== ids.length) throw failure('存在不可用商品，请重新核对选择')
        const no = await allocateSupplierNumber(tx, tenantId, numberMode === 'MANUAL' ? supplier.no : undefined)
        const created = await tx.supplier.create({ data: { ...supplier, no, tenantId, businessScopes: ['WAREHOUSE_UPSTREAM'] } as any })
        for (const item of sortedItems) {
          await tx.productUpstreamSource.create({ data: { ...item, tenantId, supplierId: created.id, isPrimary: false, isActive: true } as any })
        }
        await tx.opLog.create({ data: { tenantId, userId, role: role as any, entityType: 'Supplier', targetId: created.id,
          action: `创建上游供应商及供货关系：${created.name}`, metadata: { no: created.no, productIds: ids, requestKey } } })
        const response = JSON.parse(JSON.stringify(Object.fromEntries(fields.map(field => [field, (created as any)[field]]))))
        await tx.supplierCreateRequest.create({ data: { tenantId, requestKey, actorId: userId, payloadHash, supplierId: created.id, response } })
        return { supplier: response, replayed: false }
      }, { timeout: 20_000 })
    } catch (error: any) {
      if (error.code === 'P2034' && attempt < 2) continue
      if (error.code === 'P2002' && numberMode === 'AUTO' && attempt < 2) continue
      if (error.code === 'P2002') throw failure('供应商编号或创建请求已存在', 409)
      throw error
    }
  }
}
