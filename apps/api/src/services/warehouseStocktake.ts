import { randomUUID } from 'node:crypto'
import { Prisma, prisma } from '@dianjie/db'
import { recordWarehousePhysicalCount } from './warehouseLedger'

const fail = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode })
const decimal = (value: string | number | Prisma.Decimal) => new Prisma.Decimal(value)
const include = { warehouse: true, partitions: { include: { lines: { orderBy: { productCode: 'asc' as const } } }, orderBy: { name: 'asc' as const } }, adjustments: true }
export const STOCKTAKE_WRITE_ROLES = ['SUPPLY_CHAIN', 'SUPER_ADMIN', 'ADMIN', 'PURCHASER']
export const STOCKTAKE_AUDIT_ROLES = ['SUPPLY_CHAIN', 'SUPER_ADMIN', 'ADMIN', 'FINANCE']
export const STOCKTAKE_READ_ROLES = [...new Set([...STOCKTAKE_WRITE_ROLES, ...STOCKTAKE_AUDIT_ROLES])]

async function transact<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await prisma.$transaction(work, { isolationLevel: 'Serializable', timeout: 30_000 }) }
    catch (error: any) {
      const conflict = ['P2034', 'P2002'].includes(error?.code) || error?.code === 'P2010' && error?.meta?.code === '40001'
      if (!conflict) throw error
      if (attempt === 5) throw fail('盘点单正在被其他人更新，请刷新后重试')
      await new Promise(resolve => setTimeout(resolve, 15 * (attempt + 1)))
    }
  }
}
async function locked(tx: Prisma.TransactionClient, tenantId: string, id: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "warehouse_stocktakes" WHERE "tenantId"=${tenantId} AND "id"=${id} FOR UPDATE`)
  if (!rows.length) throw fail('盘点单不存在', 404)
  return tx.warehouseStocktake.findFirstOrThrow({ where: { tenantId, id }, include })
}
export async function getWarehouseStocktake(tenantId: string, id: string) {
  const row = await prisma.warehouseStocktake.findFirst({ where: { tenantId, id }, include })
  if (!row) throw fail('盘点单不存在', 404)
  const lines = row.partitions.flatMap(partition => partition.lines)
  const sum = (field: 'bookValue' | 'countedValue' | 'differenceAmount') => lines.reduce((total, line) => total.plus(line[field] || 0), decimal(0))
  return { ...row, itemCount: lines.length, countedCount: lines.filter(line => line.countedQuantity != null).length, totalBookValue: sum('bookValue'), totalCountedValue: sum('countedValue'), totalDifferenceValue: sum('differenceAmount') }
}
export async function createWarehouseStocktake(input: {
  tenantId: string; userId: string; warehouseId: string; countDate: string; note?: string;
  partitions: Array<{ name: string; assignedToId: string; productIds: string[] }>
}) {
  return transact(async tx => {
    const warehouse = await tx.warehouse.findFirst({ where: { tenantId: input.tenantId, id: input.warehouseId, isActive: true } })
    if (!warehouse) throw fail('仓库不存在或不属于当前租户', 404)
    const productIds = input.partitions.flatMap(partition => partition.productIds)
    if (!productIds.length || new Set(productIds).size !== productIds.length) throw fail('每个商品只能分配到一个盘点分区', 400)
    if (new Set(input.partitions.map(partition => partition.name)).size !== input.partitions.length) throw fail('分区名称不能重复', 400)
    const users = await tx.user.findMany({ where: { tenantId: input.tenantId, id: { in: input.partitions.map(partition => partition.assignedToId) }, role: { in: STOCKTAKE_WRITE_ROLES as any } } })
    if (input.partitions.some(partition => !users.some(user => user.id === partition.assignedToId))) throw fail('分区负责人必须为本租户仓库写入角色', 400)
    const products = await tx.product.findMany({ where: { tenantId: input.tenantId, id: { in: productIds }, status: 'ENABLED', unitConversionStatus: 'VERIFIED' } })
    if (products.length !== productIds.length) throw fail('商品不存在、已停用或单位换算未核验', 400)
    const balances = await tx.warehouseLedgerBalance.findMany({ where: { tenantId: input.tenantId, warehouseId: warehouse.id, productId: { in: productIds } } })
    const stocktake = await tx.warehouseStocktake.create({ data: {
      tenantId: input.tenantId, warehouseId: warehouse.id, no: `WSC-${input.countDate.replaceAll('-', '')}-${randomUUID().slice(0, 12)}`,
      countDate: new Date(`${input.countDate}T00:00:00Z`), note: input.note, createdById: input.userId,
    } })
    for (const partition of input.partitions) {
      const saved = await tx.warehouseStocktakePartition.create({ data: { tenantId: input.tenantId, stocktakeId: stocktake.id, name: partition.name, assignedToId: partition.assignedToId } })
      for (const productId of partition.productIds) {
        const product = products.find(product => product.id === productId)!
        const balance = balances.find(balance => balance.productId === productId)
        await tx.warehouseStocktakeLine.create({ data: {
          tenantId: input.tenantId, stocktakeId: stocktake.id, partitionId: saved.id, productId,
          productName: product.name, productCode: product.code, inventoryUnit: balance?.inventoryUnit || product.inventoryUnit || product.unit,
          bookQuantity: balance?.physicalQty || 0, bookValue: balance?.inventoryValue || 0, bookVersion: balance?.rowVersion || 0, unitCost: balance?.averageUnitCost || 0,
        } })
      }
    }
    return stocktake
  })
}
export async function saveWarehouseStocktakePartition(input: {
  tenantId: string; userId: string; id: string; partitionId: string; version: number;
  lines: Array<{ id: string; quantity: string; unitCost?: string; reason?: string }>
}) {
  return transact(async tx => {
    const count = await locked(tx, input.tenantId, input.id)
    if (!['DRAFT', 'COUNTING'].includes(count.status)) throw fail('当前状态不能修改实盘')
    const partition = count.partitions.find(partition => partition.id === input.partitionId)
    if (!partition) throw fail('盘点分区不存在', 404)
    if (partition.assignedToId !== input.userId) throw fail('只能保存分配给自己的盘点分区', 403)
    if (partition.version !== input.version) throw fail('该分区已被更新，请刷新后重新录入')
    if (new Set(input.lines.map(line => line.id)).size !== input.lines.length) throw fail('不能重复录入同一商品', 400)
    for (const entry of input.lines) {
      const line = partition.lines.find(line => line.id === entry.id)
      if (!line) throw fail('录入商品不属于当前分区', 400)
      const quantity = decimal(entry.quantity).toDecimalPlaces(6)
      const unitCost = entry.unitCost == null ? line.unitCost : decimal(entry.unitCost).toDecimalPlaces(6)
      if (!quantity.isFinite() || quantity.lt(0) || !unitCost.isFinite() || unitCost.lt(0) || quantity.gt(0) && unitCost.lte(0)) throw fail('实盘数量不能为负，有库存时单价必须大于0', 400)
      // 已有库存沿用账面均价；只允许无成本的新增盘盈补录成本，防止将调价混入盘点。
      if (line.unitCost.gt(0) && !unitCost.eq(line.unitCost)) throw fail('已有库存必须沿用账面成本', 400)
      const value = quantity.mul(unitCost).toDecimalPlaces(4)
      await tx.warehouseStocktakeLine.update({ where: { id: line.id }, data: { countedQuantity: quantity, countedValue: value, unitCost, differenceQuantity: quantity.minus(line.bookQuantity), differenceAmount: value.minus(line.bookValue), reason: entry.reason || null } })
    }
    await tx.warehouseStocktakePartition.update({ where: { id: partition.id }, data: { savedAt: new Date(), savedById: input.userId, version: { increment: 1 } } })
    return tx.warehouseStocktake.update({ where: { id: count.id }, data: { status: 'COUNTING' } })
  })
}
export async function transitionWarehouseStocktake(tenantId: string, userId: string, id: string, action: 'submit' | 'approve' | 'reject' | 'cancel') {
  return transact(async tx => {
    const count = await locked(tx, tenantId, id)
    if (action === 'approve' && count.status === 'CONFIRMED') return count
    if (action === 'submit' && count.status === 'REVIEWING') return count
    const lines = count.partitions.flatMap(partition => partition.lines).sort((a, b) => a.productId.localeCompare(b.productId))
    if (action === 'cancel') {
      if (!['DRAFT', 'COUNTING', 'REVIEWING'].includes(count.status)) throw fail('当前状态不能取消')
      return tx.warehouseStocktake.update({ where: { id }, data: { status: 'CANCELLED' } })
    }
    if (action === 'reject') {
      if (count.status !== 'REVIEWING') throw fail('只有待审核盘点单可以退回')
      return tx.warehouseStocktake.update({ where: { id }, data: { status: 'COUNTING', submittedAt: null, submittedById: null } })
    }
    if (action === 'submit') {
      if (!['DRAFT', 'COUNTING'].includes(count.status)) throw fail('当前状态不能提交')
      if (!lines.length || lines.some(line => line.countedQuantity == null) || count.partitions.some(partition => !partition.savedAt)) throw fail('请所有负责人先保存完整实盘，再汇总提交')
      return tx.warehouseStocktake.update({ where: { id }, data: { status: 'REVIEWING', submittedAt: new Date(), submittedById: userId } })
    }
    if (count.status !== 'REVIEWING') throw fail('只有待审核盘点单可以审核')
    const effectiveAt = new Date()
    for (const line of lines) {
      if (line.countedQuantity == null || line.countedValue == null) throw fail('实盘数据不完整')
      const result = await recordWarehousePhysicalCount({ tenantId, userId, warehouseId: count.warehouseId, stocktakeId: count.id, productId: line.productId, countedInventoryQuantity: line.countedQuantity, countedInventoryValue: line.countedValue, expectedBookVersion: line.bookVersion, effectiveAt, idempotencyKey: `stocktake:${line.id}`, note: `${count.no} ${line.reason || '盘点审核'}` }, tx)
      await tx.warehouseStocktakeLine.update({ where: { id: line.id }, data: { movementId: result.movement.id } })
    }
    for (const kind of ['PROFIT', 'LOSS']) {
      const selected = lines.filter(line => kind === 'PROFIT' ? line.differenceQuantity!.gt(0) : line.differenceQuantity!.lt(0))
      if (!selected.length) continue
      await tx.warehouseStocktakeAdjustment.create({ data: { tenantId, stocktakeId: id, kind, no: `${count.no}-${kind === 'PROFIT' ? 'PY' : 'PK'}`, itemCount: selected.length, amount: selected.reduce((sum, line) => sum.plus(line.differenceAmount!.abs()), decimal(0)) } })
    }
    await tx.opLog.create({ data: { tenantId, userId, action: '审核总仓盘点并生成盘盈盘亏', entityType: 'WarehouseStocktake', targetId: id, target: count.no } })
    return tx.warehouseStocktake.update({ where: { id }, data: { status: 'CONFIRMED', confirmedAt: effectiveAt, confirmedById: userId } })
  })
}
