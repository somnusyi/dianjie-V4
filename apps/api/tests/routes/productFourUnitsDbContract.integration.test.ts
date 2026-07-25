import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Prisma, prisma } from '@dianjie/db'

const suffix = `four-units-db-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierId = ''

function completeProduct(overrides: Record<string, unknown> = {}) {
  return {
    tenantId,
    supplierId,
    code: `${suffix}-${Math.random().toString(36).slice(2, 10)}`,
    name: '四单位数据库合同商品',
    unit: '托',
    purchaseUnit: '箱',
    inventoryUnit: '瓶',
    orderUnit: '托',
    costUnit: '瓶',
    inventoryUnitsPerPurchaseUnit: new Prisma.Decimal(12),
    inventoryUnitsPerOrderUnit: new Prisma.Decimal(144),
    inventoryUnitsPerCostUnit: new Prisma.Decimal(1),
    price: new Prisma.Decimal(10),
    ...overrides,
  }
}

async function expectDbConstraint(
  operation: Promise<unknown>,
  constraint?: string,
) {
  try {
    await operation
    throw new Error('expected PostgreSQL constraint rejection')
  } catch (error) {
    const serialized = `${String(error)}\n${JSON.stringify(error)}`
    expect(serialized).toMatch(/22003|23514|check constraint|violates check|numeric field overflow/i)
    if (constraint) expect(serialized).toContain(constraint)
  }
}

describe('product four-unit DB contract (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({
      data: { name: `四单位DB测试 ${suffix}`, slug: suffix },
    })
    tenantId = tenant.id
    const supplier = await prisma.supplier.create({
      data: { tenantId, no: `SUP-${suffix}`, name: '四单位DB测试供应商' },
    })
    supplierId = supplier.id
  })

  afterAll(async () => {
    if (!tenantId) return
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('keeps post-migration legacy direct writes nullable without parsing specification text', async () => {
    const product = await prisma.product.create({
      data: {
        tenantId,
        supplierId,
        code: `${suffix}-LEGACY-DIRECT`,
        name: '迁移后旧代码直写商品',
        unit: '箱',
        spec: '24瓶*330ml/箱',
        price: 10,
      },
    })

    expect(product.purchaseUnit).toBeNull()
    expect(product.orderUnit).toBeNull()
    expect(product.costUnit).toBeNull()
    expect(product.inventoryUnit).toBeNull()
    expect(product.inventoryUnitsPerPurchaseUnit).toBeNull()
    expect(product.inventoryUnitsPerOrderUnit).toBeNull()
    expect(product.inventoryUnitsPerCostUnit).toBeNull()
  })

  it.each([
    ['zero order factor', { inventoryUnitsPerOrderUnit: new Prisma.Decimal(0) }, 'products_order_unit_factor_ck'],
    ['negative order factor', { inventoryUnitsPerOrderUnit: new Prisma.Decimal(-1) }, 'products_order_unit_factor_ck'],
    ['zero cost factor', { inventoryUnitsPerCostUnit: new Prisma.Decimal(0) }, 'products_cost_unit_factor_ck'],
    ['negative cost factor', { inventoryUnitsPerCostUnit: new Prisma.Decimal(-1) }, 'products_cost_unit_factor_ck'],
    [
      'order factor above DECIMAL(18,6) business bound',
      { inventoryUnitsPerOrderUnit: new Prisma.Decimal('1000000000000') },
      undefined,
    ],
  ])('rejects %s', async (_label, overrides, constraint) => {
    await expectDbConstraint(
      prisma.product.create({ data: completeProduct(overrides) as any }),
      constraint,
    )
  })

  it('rejects same-named purchase and order units with different factors', async () => {
    await expectDbConstraint(
      prisma.product.create({
        data: completeProduct({
          orderUnit: '箱',
          inventoryUnitsPerOrderUnit: new Prisma.Decimal(6),
        }) as any,
      }),
      'products_four_unit_identity_ck',
    )
  })

  it('rejects same-named purchase and cost units with different factors', async () => {
    await expectDbConstraint(
      prisma.product.create({
        data: completeProduct({
          costUnit: '箱',
          inventoryUnitsPerCostUnit: new Prisma.Decimal(6),
        }) as any,
      }),
      'products_four_unit_identity_ck',
    )
  })

  it('rejects inventory unit matching another unit whose factor is not one', async () => {
    const product = await prisma.product.create({
      data: completeProduct() as any,
    })
    await expectDbConstraint(
      prisma.product.update({
        where: { id: product.id },
        data: { inventoryUnit: '箱' },
      }),
      'products_four_unit_identity_ck',
    )
  })

  it('keeps a named legacy inventory unit with no factor safely pending', async () => {
    const product = await prisma.product.create({
      data: {
        tenantId,
        supplierId,
        code: `${suffix}-LEGACY-PAIR`,
        name: '旧库存单位空因子',
        unit: '箱',
        price: 10,
      },
    })
    const updated = await prisma.product.update({
      where: { id: product.id },
      data: { inventoryUnit: '瓶' },
    })
    expect(updated.inventoryUnit).toBe('瓶')
    expect(updated.inventoryUnitsPerPurchaseUnit).toBeNull()
    expect(updated.purchaseUnit).toBeNull()
    expect(updated.orderUnit).toBeNull()
    expect(updated.costUnit).toBeNull()
  })

  it('rejects partially populated V5 fields while preserving all-null legacy writes', async () => {
    await expectDbConstraint(
      prisma.product.create({
        data: {
          tenantId,
          supplierId,
          code: `${suffix}-PARTIAL`,
          name: '部分四单位字段',
          unit: '箱',
          purchaseUnit: '箱',
          price: 10,
        },
      }),
      'products_four_unit_names_ck',
    )
  })

  it('accepts a six-decimal factor for distinct units', async () => {
    const product = await prisma.product.create({
      data: completeProduct({
        orderUnit: '滴',
        inventoryUnitsPerOrderUnit: new Prisma.Decimal('0.000001'),
      }) as any,
    })
    expect(product.inventoryUnitsPerOrderUnit?.toFixed(6)).toBe('0.000001')
  })

  it('accepts the DECIMAL(18,6) upper boundary', async () => {
    const product = await prisma.product.create({
      data: completeProduct({
        orderUnit: '托',
        inventoryUnitsPerOrderUnit: new Prisma.Decimal('999999999999.999999'),
      }) as any,
    })
    expect(product.inventoryUnitsPerOrderUnit?.toFixed(6)).toBe('999999999999.999999')
  })

  it('accepts same-named units when their factors agree', async () => {
    const product = await prisma.product.create({
      data: completeProduct({
        orderUnit: '箱',
        inventoryUnitsPerOrderUnit: new Prisma.Decimal(12),
      }) as any,
    })
    expect(product.orderUnit).toBe('箱')
    expect(product.inventoryUnitsPerOrderUnit?.toFixed(0)).toBe('12')
  })

  it('accepts an inventory-unit identity factor of one', async () => {
    const product = await prisma.product.create({
      data: completeProduct({
        purchaseUnit: '瓶',
        inventoryUnitsPerPurchaseUnit: new Prisma.Decimal(1),
      }) as any,
    })
    expect(product.purchaseUnit).toBe('瓶')
    expect(product.inventoryUnitsPerPurchaseUnit?.toFixed(0)).toBe('1')
  })
})
