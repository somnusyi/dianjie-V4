import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { purchaseOrderRoutes } from '../../src/routes/orders'
import { resolveTenantWarehouseId } from '../../src/services/defaultWarehouse'

const suffix = `warehouse-order-entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let warehouseId = ''
let supplierId = ''
let storeId = ''
let userId = ''
let productId = ''
let externalSupplierId = ''
let externalProductId = ''
let app: ReturnType<typeof Fastify>

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitForBlockedWarehousePolicyRead() {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const waiting = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND query ILIKE '%FROM "warehouses"%'
        AND query ILIKE '%FOR SHARE%'
    `
    if (waiting.length > 0) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('未观察到订单事务等待总仓策略行锁')
}

async function cleanupFixture() {
  if (!tenantId) return

  await prisma.warehouseLedgerLotAllocation.deleteMany({ where: { tenantId } })
  await prisma.warehouseLedgerLot.deleteMany({ where: { tenantId } })
  await prisma.warehouseLedgerReservation.deleteMany({ where: { tenantId } })
  await prisma.warehouseLedgerMovement.deleteMany({ where: { tenantId } })
  await prisma.warehouseLedgerBalance.deleteMany({ where: { tenantId } })
  await prisma.supplierStockReservation.deleteMany({ where: { tenantId } })
  await prisma.supplierStockBatchAllocation.deleteMany({ where: { tenantId } })
  await prisma.supplierStockBatch.deleteMany({ where: { tenantId } })
  await prisma.supplierStockMovement.deleteMany({ where: { tenantId } })
  await prisma.purchaseOrderEvent.deleteMany({ where: { tenantId } })
  await prisma.purchaseOrderRevision.deleteMany({ where: { tenantId } })
  await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { tenantId } } })
  await prisma.purchaseOrder.deleteMany({ where: { tenantId } })
  await prisma.notification.deleteMany({ where: { tenantId } })
  await prisma.opLog.deleteMany({ where: { tenantId } })
  await prisma.businessSequence.deleteMany({ where: { tenantId } })
  await prisma.warehouseStock.deleteMany({ where: { tenantId } })
  await prisma.product.deleteMany({ where: { tenantId } })
  await prisma.user.deleteMany({ where: { tenantId } })
  await prisma.store.deleteMany({ where: { tenantId } })
  await prisma.supplier.deleteMany({ where: { tenantId } })
  await prisma.warehouse.deleteMany({ where: { tenantId } })
  await prisma.tenant.deleteMany({ where: { id: tenantId } })
  tenantId = ''
}

describe('HEADQ warehouse order entry stock guard (integration)', () => {
  beforeAll(async () => {
    try {
      const tenant = await prisma.tenant.create({
        data: { name: `总仓下单库存测试 ${suffix}`, slug: suffix },
      })
      tenantId = tenant.id
      warehouseId = await resolveTenantWarehouseId(prisma, tenantId, undefined)
      await prisma.warehouse.update({
        where: { id: warehouseId },
        data: {
          inventoryMode: 'STRICT',
          inventoryActivatedAt: new Date(),
          blockZeroStockAtOrderEntry: true,
        },
      })

      const supplier = await prisma.supplier.create({
        data: {
          tenantId,
          no: `HEADQ-${suffix}`,
          name: '总仓内部履约主体',
          sourceType: 'HEADQ_WAREHOUSE',
          inventoryMode: 'NOT_TRACKED',
          inventoryActivatedAt: null,
        },
      })
      supplierId = supplier.id
      const store = await prisma.store.create({
        data: { tenantId, no: `STORE-${suffix}`, name: '严格库存测试门店' },
      })
      storeId = store.id
      const user = await prisma.user.create({
        data: {
          tenantId,
          storeId,
          storeIds: [storeId],
          name: '严格库存测试厨师长',
          email: `chef-${suffix}@local.test`,
          password: 'integration-test-only',
          role: 'KITCHEN_LEAD',
        },
      })
      userId = user.id
      const product = await prisma.product.create({
        data: {
          tenantId,
          supplierId,
          code: `P-${suffix}`,
          name: '总仓零库存菌菇',
          category: '菌菇',
          unit: 'kg',
          purchaseUnit: 'kg',
          orderUnit: 'kg',
          costUnit: 'kg',
          inventoryUnit: 'kg',
          inventoryUnitsPerPurchaseUnit: 1,
          inventoryUnitsPerOrderUnit: 1,
          inventoryUnitsPerCostUnit: 1,
          unitConversionStatus: 'VERIFIED',
          price: 18,
          stock: 50,
          minOrderQty: 1,
          stepQty: 1,
        },
      })
      productId = product.id
      await prisma.warehouseLedgerBalance.create({
        data: {
          tenantId,
          warehouseId,
          productId,
          inventoryUnit: 'kg',
          physicalQty: 0,
          reservedQty: 0,
          inventoryValue: 0,
          averageUnitCost: 0,
        },
      })

      const externalSupplier = await prisma.supplier.create({
        data: {
          tenantId,
          no: `EXTERNAL-${suffix}`,
          name: '外部严格库存供应商',
          sourceType: 'MAIN_SUPPLIER',
          inventoryMode: 'STRICT',
          inventoryActivatedAt: new Date(),
        },
      })
      externalSupplierId = externalSupplier.id
      const externalProduct = await prisma.product.create({
        data: {
          tenantId,
          supplierId: externalSupplierId,
          code: `EXTERNAL-P-${suffix}`,
          name: '外部供应商零库存商品',
          category: '菌菇',
          unit: 'kg',
          purchaseUnit: 'kg',
          orderUnit: 'kg',
          costUnit: 'kg',
          inventoryUnit: 'kg',
          inventoryUnitsPerPurchaseUnit: 1,
          inventoryUnitsPerOrderUnit: 1,
          inventoryUnitsPerCostUnit: 1,
          unitConversionStatus: 'VERIFIED',
          price: 28,
          stock: 0,
          minOrderQty: 1,
          stepQty: 1,
        },
      })
      externalProductId = externalProduct.id

      app = Fastify()
      app.decorate('authenticate', async (request: any) => {
        request.user = {
          tenantId,
          storeId,
          storeIds: [storeId],
          userId,
          role: 'KITCHEN_LEAD',
        }
      })
      await app.register(purchaseOrderRoutes, { prefix: '/api/orders' })
      await app.ready()
    } catch (error) {
      if (app) await app.close()
      await cleanupFixture()
      throw error
    }
  })

  afterAll(async () => {
    if (app) await app.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    await cleanupFixture()
  })

  it('rejects POST /api/orders when the independent HEADQ order-entry policy blocks zero available stock', async () => {
    const [supplier, warehouse, balance, product] = await Promise.all([
      prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } }),
      prisma.warehouse.findUniqueOrThrow({ where: { id: warehouseId } }),
      prisma.warehouseLedgerBalance.findUniqueOrThrow({
        where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } },
      }),
      prisma.product.findUniqueOrThrow({ where: { id: productId } }),
    ])
    expect(supplier).toMatchObject({ sourceType: 'HEADQ_WAREHOUSE', inventoryMode: 'NOT_TRACKED' })
    expect(warehouse.inventoryMode).toBe('STRICT')
    expect(warehouse.blockZeroStockAtOrderEntry).toBe(true)
    expect(Number(balance.physicalQty) - Number(balance.reservedQty)).toBe(0)
    expect(Number(product.stock)).toBe(50)

    const response = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: {
        supplierId,
        storeId,
        expectedDate: '2030-01-02',
        idempotencyKey: `strict-zero-${suffix}`,
        items: [{ productId, quantity: 1, unitPrice: 999 }],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: '总仓零库存菌菇 当前可用库存为 0，不能下单' })
    expect(await prisma.purchaseOrder.count({ where: { tenantId } })).toBe(0)
    expect(await prisma.businessSequence.count({ where: { tenantId } })).toBe(0)
  })

  it('linearizes a concurrent policy enable before order creation and retries the order against the committed blocking policy', async () => {
    await prisma.warehouse.update({
      where: { id: warehouseId },
      data: { blockZeroStockAtOrderEntry: false },
    })
    await prisma.warehouseLedgerBalance.update({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } },
      data: { physicalQty: 0, reservedQty: 0 },
    })

    const policyUpdatedWhileLocked = deferred()
    const allowPolicyCommit = deferred()
    const policyWrite = prisma.$transaction(async tx => {
      await tx.$queryRaw`
        SELECT "id"
        FROM "warehouses"
        WHERE "id" = ${warehouseId} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `
      await tx.warehouse.update({
        where: { id: warehouseId },
        data: {
          blockZeroStockAtOrderEntry: true,
          rowVersion: { increment: 1 },
        },
      })
      policyUpdatedWhileLocked.resolve()
      await allowPolicyCommit.promise
    }, { timeout: 10_000 })

    await policyUpdatedWhileLocked.promise
    const orderResponse = app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: {
        supplierId,
        storeId,
        expectedDate: '2030-01-02',
        idempotencyKey: `policy-race-${suffix}`,
        items: [{ productId, quantity: 1, unitPrice: 999 }],
      },
    })

    try {
      await waitForBlockedWarehousePolicyRead()
    } finally {
      allowPolicyCommit.resolve()
    }
    await policyWrite

    const response = await orderResponse
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      statusCode: 400,
      message: '总仓零库存菌菇 当前可用库存为 0，不能提交订单',
    })
    expect(await prisma.purchaseOrder.count({
      where: { tenantId, createdById: userId, idempotencyKey: `policy-race-${suffix}` },
    })).toBe(0)
    expect(await prisma.businessSequence.count({ where: { tenantId } })).toBe(0)
  })

  it('allows zero-stock submission when the policy is reminder-only even though ledger mode remains STRICT', async () => {
    await prisma.warehouse.update({
      where: { id: warehouseId },
      data: { blockZeroStockAtOrderEntry: false },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: {
        supplierId,
        storeId,
        expectedDate: '2030-01-03',
        idempotencyKey: `reminder-zero-${suffix}`,
        items: [{ productId, quantity: 1, unitPrice: 999 }],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'SUBMITTED', supplierId, storeId })
    expect(await prisma.purchaseOrder.count({ where: { tenantId, status: 'SUBMITTED' } })).toBe(1)
    const warehouse = await prisma.warehouse.findUniqueOrThrow({ where: { id: warehouseId } })
    expect(warehouse.inventoryMode).toBe('STRICT')
    expect(warehouse.blockZeroStockAtOrderEntry).toBe(false)
  })

  it('allows an order larger than positive available stock because this policy only blocks exact zero', async () => {
    await prisma.warehouse.update({
      where: { id: warehouseId },
      data: { blockZeroStockAtOrderEntry: true },
    })
    await prisma.warehouseLedgerBalance.update({
      where: { tenantId_warehouseId_productId: { tenantId, warehouseId, productId } },
      data: { physicalQty: 1, reservedQty: 0 },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: {
        supplierId,
        storeId,
        expectedDate: '2030-01-04',
        idempotencyKey: `positive-insufficient-${suffix}`,
        items: [{ productId, quantity: 5, unitPrice: 999 }],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'SUBMITTED', supplierId, storeId })
    expect(await prisma.purchaseOrder.count({ where: { tenantId, status: 'SUBMITTED' } })).toBe(2)
  })

  it('allows store submission to an external STRICT supplier with zero supplier stock', async () => {
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: externalSupplierId } })
    const product = await prisma.product.findUniqueOrThrow({ where: { id: externalProductId } })
    expect(supplier).toMatchObject({ sourceType: 'MAIN_SUPPLIER', inventoryMode: 'STRICT' })
    expect(Number(product.stock)).toBe(0)
    expect(await prisma.supplierStockBatch.count({
      where: { tenantId, supplierId: externalSupplierId },
    })).toBe(0)

    const response = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: {
        supplierId: externalSupplierId,
        storeId,
        expectedDate: '2030-01-05',
        idempotencyKey: `external-strict-zero-${suffix}`,
        items: [{ productId: externalProductId, quantity: 1, unitPrice: 999 }],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      status: 'SUBMITTED',
      supplierId: externalSupplierId,
      storeId,
    })
    expect(await prisma.purchaseOrder.count({
      where: { tenantId, supplierId: externalSupplierId, status: 'SUBMITTED' },
    })).toBe(1)
  })
})
