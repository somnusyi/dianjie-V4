import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { mergeSupplierCategory } from '../../src/services/supplierCategory'

const suffix = `supplier-category-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierId = ''
let otherSupplierId = ''
let userId = ''

describe('supplier category merge (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `分类测试 ${suffix}`, slug: suffix } })
    tenantId = tenant.id
    const [supplier, otherSupplier] = await Promise.all([
      prisma.supplier.create({ data: { tenantId, no: `SUP-${suffix}-A`, name: '分类测试供应商 A' } }),
      prisma.supplier.create({ data: { tenantId, no: `SUP-${suffix}-B`, name: '分类测试供应商 B' } }),
    ])
    supplierId = supplier.id
    otherSupplierId = otherSupplier.id
    const user = await prisma.user.create({
      data: {
        tenantId,
        supplierId,
        name: '分类测试账号',
        email: `${suffix}@local.test`,
        password: 'integration-test-only',
        role: 'SUPPLIER_OWNER',
      },
    })
    userId = user.id
  })

  afterAll(async () => {
    if (!tenantId) return
    await prisma.opLog.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.supplierProductCategory.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('moves every SKU, disables the source and records one audit event atomically', async () => {
    const [source, target] = await Promise.all([
      prisma.supplierProductCategory.create({ data: { tenantId, supplierId, name: '鲜菌', sortOrder: 0 } }),
      prisma.supplierProductCategory.create({ data: { tenantId, supplierId, name: '菌菇', sortOrder: 1 } }),
    ])
    await Promise.all([
      prisma.product.create({ data: { tenantId, supplierId, code: `${suffix}-P1`, name: '鲜菌一', category: source.name, price: 10 } }),
      prisma.product.create({ data: { tenantId, supplierId, code: `${suffix}-P2`, name: '鲜菌二', category: source.name, price: 20 } }),
    ])

    const result = await mergeSupplierCategory({
      tenantId, supplierId, userId, role: 'SUPPLIER_OWNER', sourceId: source.id, targetId: target.id,
    })

    expect(result.productCount).toBe(2)
    expect(await prisma.product.count({ where: { tenantId, supplierId, category: target.name } })).toBe(2)
    expect(await prisma.supplierProductCategory.findUnique({ where: { id: source.id } })).toMatchObject({ isActive: false })
    const audit = await prisma.opLog.findFirst({ where: { tenantId, targetId: source.id } })
    expect(audit?.action).toContain('移动 2 个 SKU')
  })

  it('rejects merging a system fallback category', async () => {
    const [source, target] = await Promise.all([
      prisma.supplierProductCategory.create({ data: { tenantId, supplierId, name: '其他', sortOrder: 2, isSystem: true } }),
      prisma.supplierProductCategory.create({ data: { tenantId, supplierId, name: '常规', sortOrder: 3 } }),
    ])
    await expect(mergeSupplierCategory({
      tenantId, supplierId, userId, role: 'SUPPLIER_OWNER', sourceId: source.id, targetId: target.id,
    })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('cannot merge into another supplier category', async () => {
    const [source, foreignTarget] = await Promise.all([
      prisma.supplierProductCategory.create({ data: { tenantId, supplierId, name: '调料', sortOrder: 4 } }),
      prisma.supplierProductCategory.create({ data: { tenantId, supplierId: otherSupplierId, name: '外部分类', sortOrder: 0 } }),
    ])
    await expect(mergeSupplierCategory({
      tenantId, supplierId, userId, role: 'SUPPLIER_OWNER', sourceId: source.id, targetId: foreignTarget.id,
    })).rejects.toMatchObject({ statusCode: 404 })
  })
})
