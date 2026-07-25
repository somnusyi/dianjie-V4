import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { productRoutes } from '../../src/routes/products'

const suffix = `batch-revoke-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let supplierId = ''
let userId = ''
let enabledProductId = ''
let pendingProductId = ''
let concurrencyProductId = ''
let enabledBatchId = ''
let pendingBatchId = ''
let concurrencyBatchId = ''
let app: ReturnType<typeof Fastify>

describe('product batch revoke approval guard (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `批次撤回审批测试 ${suffix}`, slug: suffix } })
    tenantId = tenant.id
    const supplier = await prisma.supplier.create({ data: { tenantId, no: `SUP-${suffix}`, name: '批次撤回测试供应商' } })
    supplierId = supplier.id
    const user = await prisma.user.create({
      data: {
        tenantId, supplierId,
        name: '批次撤回测试账号',
        email: `${suffix}@local.test`,
        password: 'integration-test-only',
        role: 'SUPPLIER_OWNER',
      },
    })
    userId = user.id

    enabledBatchId = `batch-enabled-${suffix}`
    pendingBatchId = `batch-pending-${suffix}`
    concurrencyBatchId = `batch-concurrency-${suffix}`
    await prisma.productBatch.createMany({
      data: [
        { id: enabledBatchId, tenantId, supplierId, uploadedById: userId, filename: 'enabled.xlsx', totalRows: 1, createdCount: 1, failedCount: 0 },
        { id: pendingBatchId, tenantId, supplierId, uploadedById: userId, filename: 'pending.xlsx', totalRows: 1, createdCount: 1, failedCount: 0 },
        { id: concurrencyBatchId, tenantId, supplierId, uploadedById: userId, filename: 'concurrency.xlsx', totalRows: 1, createdCount: 1, failedCount: 0 },
      ],
    })

    const [enabledProduct, pendingProduct, concurrencyProduct] = await Promise.all([
      prisma.product.create({
        data: {
          tenantId, supplierId, batchId: enabledBatchId,
          code: `ENABLED-${suffix}`, name: '已上架批次商品', unit: '件', price: 10, status: 'ENABLED',
        },
      }),
      prisma.product.create({
        data: {
          tenantId, supplierId, batchId: pendingBatchId,
          code: `PENDING-${suffix}`, name: '待审批批次商品', unit: '件', price: 10, status: 'PENDING_APPROVAL',
        },
      }),
      prisma.product.create({
        data: {
          tenantId, supplierId, batchId: concurrencyBatchId,
          code: `CONC-${suffix}`, name: '并发测试批次商品', unit: '件', price: 10, status: 'PENDING_APPROVAL',
        },
      }),
    ])
    enabledProductId = enabledProduct.id
    pendingProductId = pendingProduct.id
    concurrencyProductId = concurrencyProduct.id

    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = { tenantId, supplierId, userId, role: 'SUPPLIER_OWNER' }
    })
    await app.register(productRoutes, { prefix: '/api/products' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    if (!tenantId) return
    await prisma.opLog.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } })
    await prisma.productBatch.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('rejects supplier revoke when batch contains enabled products', async () => {
    const response = await app.inject({
      method: 'PATCH', url: `/api/products/batches/${enabledBatchId}/revoke`,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: expect.stringContaining('已上架商品') })
    const batch = await prisma.productBatch.findUniqueOrThrow({ where: { id: enabledBatchId } })
    expect(batch.revokedAt).toBeNull()
    const product = await prisma.product.findUniqueOrThrow({ where: { id: enabledProductId } })
    expect(product.status).toBe('ENABLED')
  })

  it('allows supplier revoke for a pending-approval batch and disables products', async () => {
    const response = await app.inject({
      method: 'PATCH', url: `/api/products/batches/${pendingBatchId}/revoke`,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ success: true, disabledCount: 1 })
    const batch = await prisma.productBatch.findUniqueOrThrow({ where: { id: pendingBatchId } })
    expect(batch.revokedAt).not.toBeNull()
    const product = await prisma.product.findUniqueOrThrow({ where: { id: pendingProductId } })
    expect(product.status).toBe('DISABLED')
  })

  it('marks batches with enabled products as not revocable in list', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/products/batches' })
    expect(response.statusCode).toBe(200)
    const list = response.json()
    const enabled = list.find((b: any) => b.id === enabledBatchId)
    const pending = list.find((b: any) => b.id === pendingBatchId)
    expect(enabled.canRevoke).toBe(false)
    expect(pending.canRevoke).toBe(false)
  })

  it('blocks revoke when a product becomes enabled after the revoke transaction starts', async () => {
    // 模拟并发：测试事务先按 id 顺序锁定批次商品，再把商品审为 ENABLED，
    // 然后提交。撤销请求在同一行锁释放后才能继续，必须重新读到 ENABLED 并拒绝。
    let markLocked!: () => void
    const locked = new Promise<void>(resolve => { markLocked = resolve })
    let allowEnable!: () => void
    const enableAllowed = new Promise<void>(resolve => { allowEnable = resolve })
    const enableAfterLock = prisma.$transaction(async tx => {
      await tx.$queryRaw`
        SELECT id, status FROM "products"
        WHERE "batchId" = ${concurrencyBatchId} AND "tenantId" = ${tenantId}
        ORDER BY id ASC
        FOR UPDATE
      `
      markLocked()
      await enableAllowed
      await tx.product.update({ where: { id: concurrencyProductId }, data: { status: 'ENABLED' } })
    }, { maxWait: 5000, timeout: 10000 })

    await locked
    const revoke = app.inject({
      method: 'PATCH', url: `/api/products/batches/${concurrencyBatchId}/revoke`,
    })
    allowEnable()

    const [_, revokeResponse] = await Promise.all([enableAfterLock, revoke])

    expect(revokeResponse.statusCode).toBe(400)
    expect(revokeResponse.json()).toMatchObject({ error: expect.stringContaining('已上架商品') })

    const batch = await prisma.productBatch.findUniqueOrThrow({ where: { id: concurrencyBatchId } })
    expect(batch.revokedAt).toBeNull()
    const product = await prisma.product.findUniqueOrThrow({ where: { id: concurrencyProductId } })
    expect(product.status).toBe('ENABLED')
  })
})
