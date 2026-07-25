import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Prisma, prisma } from '@dianjie/db'

const suffix = `tenant-warehouse-db-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantAId = ''
let tenantBId = ''
let supplierAId = ''
let supplierA2Id = ''
let userAId = ''
let productAId = ''
let warehouseAId = ''
let warehouseBId = ''

async function expectDatabaseRejection(
  operation: Promise<unknown>,
  pattern: RegExp,
) {
  try {
    await operation
    throw new Error('expected PostgreSQL constraint rejection')
  } catch (error) {
    const serialized = `${String(error)}\n${JSON.stringify(error)}`
    expect(serialized).toMatch(pattern)
  }
}

describe('tenant warehouse database contract (integration)', () => {
  beforeAll(async () => {
    const [tenantA, tenantB] = await Promise.all([
      prisma.tenant.create({
        data: { name: `仓库数据库合同 A ${suffix}`, slug: `${suffix}-a` },
      }),
      prisma.tenant.create({
        data: { name: `仓库数据库合同 B ${suffix}`, slug: `${suffix}-b` },
      }),
    ])
    tenantAId = tenantA.id
    tenantBId = tenantB.id

    const [warehouseA, warehouseB] = await Promise.all([
      prisma.warehouse.findFirstOrThrow({
        where: { tenantId: tenantAId, code: 'default', isDefault: true },
      }),
      prisma.warehouse.findFirstOrThrow({
        where: { tenantId: tenantBId, code: 'default', isDefault: true },
      }),
    ])
    warehouseAId = warehouseA.id
    warehouseBId = warehouseB.id

    const [supplierA, supplierA2] = await Promise.all([
      prisma.supplier.create({
        data: {
          tenantId: tenantAId,
          no: `SUP-A-${suffix}`,
          name: '仓库数据库合同供应商 A',
        },
      }),
      prisma.supplier.create({
        data: {
          tenantId: tenantAId,
          no: `SUP-A2-${suffix}`,
          name: '仓库数据库合同供应商 A2',
        },
      }),
    ])
    supplierAId = supplierA.id
    supplierA2Id = supplierA2.id

    const user = await prisma.user.create({
      data: {
        tenantId: tenantAId,
        supplierId: supplierAId,
        name: '仓库数据库合同账号',
        email: `${suffix}@local.test`,
        password: 'integration-test-only',
        role: 'SUPPLIER_OWNER',
      },
    })
    userAId = user.id

    const product = await prisma.product.create({
      data: {
        tenantId: tenantAId,
        supplierId: supplierAId,
        code: `P-${suffix}`,
        name: '仓库数据库合同商品',
        price: 10,
        stock: new Prisma.Decimal('7.25'),
      },
    })
    productAId = product.id
  })

  afterAll(async () => {
    if (!tenantAId || !tenantBId) return
    await prisma.supplierStockMovement.deleteMany({
      where: { tenantId: { in: [tenantAId, tenantBId] } },
    })
    await prisma.warehouseStock.deleteMany({
      where: { tenantId: { in: [tenantAId, tenantBId] } },
    })
    await prisma.product.deleteMany({
      where: { tenantId: { in: [tenantAId, tenantBId] } },
    })
    await prisma.user.deleteMany({
      where: { tenantId: { in: [tenantAId, tenantBId] } },
    })
    await prisma.supplier.deleteMany({
      where: { tenantId: { in: [tenantAId, tenantBId] } },
    })
    await prisma.warehouse.deleteMany({
      where: { tenantId: { in: [tenantAId, tenantBId] } },
    })
    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantAId, tenantBId] } },
    })
  })

  it('creates one deterministic enabled default warehouse per new tenant', async () => {
    const warehouses = await prisma.warehouse.findMany({
      where: { tenantId: { in: [tenantAId, tenantBId] } },
      orderBy: { tenantId: 'asc' },
    })

    expect(warehouses).toHaveLength(2)
    expect(warehouses.every(row =>
      row.code === 'default' && row.isDefault && row.isActive,
    )).toBe(true)
    expect(warehouseAId).toMatch(/^wh_[a-f0-9]{32}$/)
    expect(warehouseBId).toMatch(/^wh_[a-f0-9]{32}$/)
  })

  it('mirrors Product.stock one-way and supplier changes do not create warehouses', async () => {
    const opening = await prisma.warehouseStock.findUniqueOrThrow({
      where: {
        tenantId_warehouseId_productId: {
          tenantId: tenantAId,
          warehouseId: warehouseAId,
          productId: productAId,
        },
      },
    })
    expect(opening.physicalQty.toFixed(2)).toBe('7.25')
    expect(opening.rowVersion).toBe(0)

    await prisma.product.update({
      where: { id: productAId },
      data: { stock: new Prisma.Decimal('9.5') },
    })
    const afterStock = await prisma.warehouseStock.findUniqueOrThrow({
      where: { id: opening.id },
    })
    expect(afterStock.physicalQty.toFixed(1)).toBe('9.5')
    expect(afterStock.rowVersion).toBe(1)

    await prisma.product.update({
      where: { id: productAId },
      data: { supplierId: supplierA2Id },
    })
    expect(await prisma.warehouse.count({
      where: { tenantId: tenantAId },
    })).toBe(1)
    expect(await prisma.warehouseStock.count({
      where: { tenantId: tenantAId, productId: productAId },
    })).toBe(1)
    expect((await prisma.warehouseStock.findUniqueOrThrow({
      where: { id: opening.id },
    })).rowVersion).toBe(1)
  })

  it('enforces one default warehouse and one product balance row per warehouse', async () => {
    await expectDatabaseRejection(
      prisma.warehouse.create({
        data: {
          tenantId: tenantAId,
          code: 'future-default',
          name: '伪造第二默认仓',
          isDefault: true,
        },
      }),
      /23505|warehouses_one_default_per_tenant_key|unique constraint/i,
    )

    await expectDatabaseRejection(
      prisma.warehouseStock.create({
        data: {
          tenantId: tenantAId,
          warehouseId: warehouseAId,
          productId: productAId,
          physicalQty: 1,
        },
      }),
      /23505|warehouse_stocks_tenantId_warehouseId_productId_key|unique constraint/i,
    )
  })

  it('rejects cross-tenant warehouse relations instead of rewriting caller values', async () => {
    await expectDatabaseRejection(
      prisma.warehouseStock.create({
        data: {
          tenantId: tenantAId,
          warehouseId: warehouseBId,
          productId: productAId,
          physicalQty: 1,
        },
      }),
      /23503|warehouse_stocks_tenantId_warehouseId_fkey|foreign key constraint/i,
    )

    await expectDatabaseRejection(
      prisma.supplierStockMovement.create({
        data: {
          tenantId: tenantAId,
          warehouseId: warehouseBId,
          supplierId: supplierA2Id,
          productId: productAId,
          delta: 0,
          balanceAfter: new Prisma.Decimal('9.5'),
          type: 'ADJUSTMENT',
          reason: '跨 tenant 仓库必须失败',
          createdById: userAId,
        },
      }),
      /23503|supplier_stock_movements_tenantId_warehouseId_fkey|foreign key constraint/i,
    )
  })

  it('fills omitted legacy fact warehouseId and validates every fact constraint', async () => {
    const movement = await prisma.supplierStockMovement.create({
      data: {
        tenantId: tenantAId,
        supplierId: supplierA2Id,
        productId: productAId,
        delta: 0,
        balanceAfter: new Prisma.Decimal('9.5'),
        type: 'ADJUSTMENT',
        reason: '旧运行时省略 warehouseId',
        createdById: userAId,
      },
    })
    expect(movement.warehouseId).toBe(warehouseAId)

    const constraintNames = [
      'delivery_orders_warehouse_present_ck',
      'delivery_orders_tenantId_warehouseId_fkey',
      'supplier_stock_movements_warehouse_present_ck',
      'supplier_stock_movements_tenantId_warehouseId_fkey',
      'supplier_stock_batches_warehouse_present_ck',
      'supplier_stock_batches_tenantId_warehouseId_fkey',
      'supplier_stock_batch_allocations_warehouse_present_ck',
      'supplier_stock_batch_allocations_tenantId_warehouseId_fkey',
      'supplier_stock_reservations_warehouse_present_ck',
      'supplier_stock_reservations_tenantId_warehouseId_fkey',
    ]
    const constraints = await prisma.$queryRaw<
      Array<{ conname: string; convalidated: boolean }>
    >`
      SELECT "conname", "convalidated"
      FROM "pg_constraint"
      WHERE "conname" IN (${Prisma.join(constraintNames)})
    `

    expect(constraints.map(row => row.conname).sort()).toEqual(
      [...constraintNames].sort(),
    )
    expect(constraints.every(row => row.convalidated)).toBe(true)
  })

  it('serializes concurrent legacy stock writes without diverging the bridge balance', async () => {
    const before = await prisma.warehouseStock.findFirstOrThrow({
      where: {
        tenantId: tenantAId,
        warehouseId: warehouseAId,
        productId: productAId,
      },
    })

    await Promise.all([
      prisma.product.update({
        where: { id: productAId },
        data: { stock: new Prisma.Decimal('10.25') },
      }),
      prisma.product.update({
        where: { id: productAId },
        data: { stock: new Prisma.Decimal('11.75') },
      }),
    ])

    const [product, stock] = await Promise.all([
      prisma.product.findUniqueOrThrow({ where: { id: productAId } }),
      prisma.warehouseStock.findUniqueOrThrow({ where: { id: before.id } }),
    ])
    expect(stock.physicalQty.equals(product.stock)).toBe(true)
    expect(stock.rowVersion).toBe(before.rowVersion + 2)
  })

  it('retains future multi-warehouse balances at three-decimal precision', async () => {
    const futureWarehouse = await prisma.warehouse.create({
      data: {
        tenantId: tenantAId,
        code: 'future-secondary',
        name: '未来扩展仓',
      },
    })
    const balance = await prisma.warehouseStock.create({
      data: {
        tenantId: tenantAId,
        warehouseId: futureWarehouse.id,
        productId: productAId,
        physicalQty: new Prisma.Decimal('1.234'),
      },
    })

    expect(balance.physicalQty.toFixed(3)).toBe('1.234')
    expect(await prisma.warehouse.count({
      where: { tenantId: tenantAId, isDefault: true },
    })).toBe(1)
  })
})
