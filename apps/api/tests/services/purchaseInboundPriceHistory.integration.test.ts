import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { findLatestPurchaseInboundPrices } from '../../src/services/purchaseInboundPriceHistory'

const suffix = `price-memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let otherTenantId = ''
let supplierId = ''
let otherSupplierId = ''
let warehouseId = ''
let userId = ''
let productId = ''

async function cleanup(tenant: string) {
  if (!tenant) return
  await prisma.warehouseDocLine.deleteMany({ where: { tenantId: tenant } })
  await prisma.warehouseDoc.deleteMany({ where: { tenantId: tenant } })
  await prisma.warehouseLedgerMovement.deleteMany({ where: { tenantId: tenant } })
  await prisma.upstreamReceiptLine.deleteMany({ where: { tenantId: tenant } })
  await prisma.upstreamReceipt.deleteMany({ where: { tenantId: tenant } })
  await prisma.upstreamPurchaseOrderLine.deleteMany({ where: { tenantId: tenant } })
  await prisma.upstreamPurchaseOrder.deleteMany({ where: { tenantId: tenant } })
  await prisma.product.deleteMany({ where: { tenantId: tenant } })
  await prisma.user.deleteMany({ where: { tenantId: tenant } })
  await prisma.supplier.deleteMany({ where: { tenantId: tenant } })
  await prisma.warehouse.deleteMany({ where: { tenantId: tenant } })
  await prisma.tenant.deleteMany({ where: { id: tenant } })
}

async function createReceipt(input: { no: string; price: number; acceptedQty: number; postedAt: Date; currency?: string; taxInclusive?: boolean; supplierId?: string; status?: 'POSTED' | 'DRAFT' | 'REVERSED' }) {
  const receiptSupplierId = input.supplierId || supplierId
  const order = await prisma.upstreamPurchaseOrder.create({ data: {
    tenantId, no: `PO-${input.no}`, supplierId: receiptSupplierId, warehouseId, status: 'RECEIVED', currency: input.currency || 'CNY', taxInclusive: input.taxInclusive ?? true,
    amountWithoutTax: input.price * 2, totalAmount: input.price * 2, createdById: userId,
    lines: { create: { lineNo: 1, productId, productCodeSnapshot: 'PRICE-1', productNameSnapshot: '价格记忆商品', purchaseUnit: '箱', inventoryUnit: '箱', inventoryUnitsPerPurchaseUnit: 1, orderedQty: 2, confirmedQty: 2, receivedQty: 2, unitPrice: input.price, amountWithoutTax: input.price * 2, taxAmount: 0, totalAmount: input.price * 2 } },
  }, include: { lines: true } })
  await prisma.upstreamReceipt.create({ data: {
    tenantId, no: `RC-${input.no}`, purchaseOrderId: order.id, supplierId: receiptSupplierId, warehouseId, status: input.status || 'POSTED', arrivedAt: input.postedAt, postedAt: input.status === 'DRAFT' ? null : input.postedAt, payableAmount: input.price * input.acceptedQty, createdById: userId,
    lines: { create: { purchaseOrderLineId: order.lines[0].id, productId, orderedQty: 2, arrivedQty: input.acceptedQty, acceptedQty: input.acceptedQty, purchaseUnit: '箱', inventoryUnit: '箱', inventoryUnitsPerPurchaseUnit: 1, inventoryAcceptedQty: input.acceptedQty, unitPrice: input.price, payableAmount: input.price * input.acceptedQty } },
  } })
}

describe('purchase inbound price history (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `价格记忆 ${suffix}`, slug: suffix } }); tenantId = tenant.id
    const other = await prisma.tenant.create({ data: { name: `隔离 ${suffix}`, slug: `other-${suffix}` } }); otherTenantId = other.id
    const [warehouse, supplier, otherSupplier, user, product] = await Promise.all([
      prisma.warehouse.findFirstOrThrow({ where: { tenantId, isDefault: true } }),
      prisma.supplier.create({ data: { tenantId, no: `SUP-${suffix}`, name: '价格记忆供应商', businessScopes: ['WAREHOUSE_UPSTREAM'] } }),
      prisma.supplier.create({ data: { tenantId, no: `SUP2-${suffix}`, name: '另一价格记忆供应商', businessScopes: ['WAREHOUSE_UPSTREAM'] } }),
      prisma.user.create({ data: { tenantId, name: '价格记忆经办人', email: `${suffix}@local.test`, password: 'test-only', role: 'SUPPLY_CHAIN' } }),
      prisma.product.create({ data: { tenantId, code: `PRICE-${suffix}`, name: '价格记忆商品', unit: '箱', purchaseUnit: '箱', inventoryUnit: '箱', orderUnit: '箱', costUnit: '箱', inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED', price: 1 } }),
    ])
    warehouseId = warehouse.id; supplierId = supplier.id; otherSupplierId = otherSupplier.id; userId = user.id; productId = product.id
  })

  afterAll(async () => { await cleanup(otherTenantId); await cleanup(tenantId); await prisma.$disconnect() })

  it('selects the latest valid manual/upstream fact and excludes zero, non-CNY, tax-exclusive, draft and reversed receipts', async () => {
    const movement = await prisma.warehouseLedgerMovement.create({ data: { tenantId, warehouseId, productId, type: 'MANUAL_INBOUND', physicalDelta: 1, physicalAfter: 1, reservedAfter: 0, valueAfter: 200, averageUnitCostAfter: 200, originalQuantity: 1, originalUnit: '箱', conversionFactor: 1, inventoryQuantity: 1, inventoryUnit: '箱', sourceType: 'test', sourceId: suffix, idempotencyKey: suffix, effectiveAt: new Date('2026-09-10T00:00:00Z') } })
    await prisma.warehouseDoc.create({ data: { tenantId, docNo: `MI-${suffix}`, type: 'MANUAL_INBOUND', warehouseId, supplierId, effectiveAt: new Date('2026-09-10T00:00:00Z'), idempotencyKey: suffix, lines: { create: { tenantId, lineNo: 1, productId, productName: '价格记忆商品', quantity: 1, unit: '箱', unitPrice: 200, amount: 200, inventoryQuantity: 1, inventoryUnit: '箱', movementId: movement.id } } } })
    await prisma.warehouseLedgerMovement.create({ data: { tenantId, warehouseId, productId, type: 'REVERSAL', physicalDelta: 0, physicalAfter: 1, reservedAfter: 0, valueAfter: 200, averageUnitCostAfter: 200, originalQuantity: 0, originalUnit: '箱', conversionFactor: 1, inventoryQuantity: 0, inventoryUnit: '箱', sourceType: 'test', sourceId: `${suffix}-reverse`, idempotencyKey: `${suffix}-reverse`, reversalOfId: movement.id, effectiveAt: new Date('2026-09-11T01:00:00Z') } })
    await createReceipt({ no: 'valid', price: 75, acceptedQty: 2, postedAt: new Date('2026-09-02T00:00:00Z') })
    await createReceipt({ no: 'zero', price: 99, acceptedQty: 0, postedAt: new Date('2026-09-04T00:00:00Z') })
    await createReceipt({ no: 'usd', price: 10, acceptedQty: 2, postedAt: new Date('2026-09-05T00:00:00Z'), currency: 'USD' })
    await createReceipt({ no: 'untaxed', price: 100, acceptedQty: 2, postedAt: new Date('2026-09-06T00:00:00Z'), taxInclusive: false })
    await createReceipt({ no: 'draft', price: 110, acceptedQty: 2, postedAt: new Date('2026-09-07T00:00:00Z'), status: 'DRAFT' })
    await createReceipt({ no: 'reversed', price: 120, acceptedQty: 2, postedAt: new Date('2026-09-08T00:00:00Z'), status: 'REVERSED' })
    await createReceipt({ no: 'other-supplier', price: 130, acceptedQty: 2, postedAt: new Date('2026-09-09T00:00:00Z'), supplierId: otherSupplierId })
    const validManualMovement = await prisma.warehouseLedgerMovement.create({ data: { tenantId, warehouseId, productId, type: 'MANUAL_INBOUND', physicalDelta: 1, physicalAfter: 1, reservedAfter: 0, valueAfter: 65, averageUnitCostAfter: 65, originalQuantity: 1, originalUnit: '箱', conversionFactor: 1, inventoryQuantity: 1, inventoryUnit: '箱', sourceType: 'test', sourceId: `${suffix}-valid`, idempotencyKey: `${suffix}-valid`, effectiveAt: new Date('2026-09-03T00:00:00Z') } })
    await prisma.warehouseDoc.create({ data: { tenantId, docNo: `MI2-${suffix}`, type: 'MANUAL_INBOUND', warehouseId, supplierId, effectiveAt: new Date('2026-09-03T00:00:00Z'), idempotencyKey: `${suffix}-valid`, lines: { create: { tenantId, lineNo: 1, productId, productName: '价格记忆商品', quantity: 1, unit: '箱', unitPrice: 65, amount: 65, inventoryQuantity: 1, inventoryUnit: '箱', movementId: validManualMovement.id } } } })

    await expect(findLatestPurchaseInboundPrices({ tenantId, supplierId, productIds: [productId], purchaseUnits: { [productId]: '箱' } })).resolves.toEqual([
      expect.objectContaining({ productId, unitPrice: 65, source: 'MANUAL_INBOUND' }),
    ])
    await expect(findLatestPurchaseInboundPrices({ tenantId, supplierId: otherSupplierId, productIds: [productId], purchaseUnits: { [productId]: '箱' } })).resolves.toEqual([
      expect.objectContaining({ productId, unitPrice: 130, source: 'UPSTREAM_RECEIPT' }),
    ])
    await expect(findLatestPurchaseInboundPrices({ tenantId: otherTenantId, supplierId, productIds: [productId], purchaseUnits: { [productId]: '箱' } })).resolves.toEqual([])
    await expect(findLatestPurchaseInboundPrices({ tenantId, supplierId, productIds: [productId], purchaseUnits: { [productId]: 'kg' } })).resolves.toEqual([])
  })
})
