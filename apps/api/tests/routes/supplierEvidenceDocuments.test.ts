import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { collectTraceableDeliveryEvidence, supplierEvidenceDocumentRoutes } from '../../src/routes/supplierEvidenceDocuments'

const mocks = vi.hoisted(() => ({
  receiptFindFirst: vi.fn(), documentFindMany: vi.fn(), userFindFirst: vi.fn(),
  linkFindUnique: vi.fn(), linkFindFirst: vi.fn(), linkFindMany: vi.fn(), linkCreate: vi.fn(), linkUpdateMany: vi.fn(),
  sourceFindFirst: vi.fn(), productUpdateMany: vi.fn(), requirementFindUnique: vi.fn(), requirementCreate: vi.fn(),
  opLogCreate: vi.fn(), userFindMany: vi.fn(),
  deliveryFindFirst: vi.fn(), movementFindMany: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  const prismaMock: any = {
    upstreamReceipt: { findFirst: (...args: any[]) => mocks.receiptFindFirst(...args) },
    supplierEvidenceDocument: { findMany: (...args: any[]) => mocks.documentFindMany(...args) },
    upstreamReceiptLineEvidenceDocument: {
      findUnique: (...args: any[]) => mocks.linkFindUnique(...args),
      findFirst: (...args: any[]) => mocks.linkFindFirst(...args),
      findMany: (...args: any[]) => mocks.linkFindMany(...args),
      create: (...args: any[]) => mocks.linkCreate(...args),
      updateMany: (...args: any[]) => mocks.linkUpdateMany(...args),
    },
    productUpstreamSource: { findFirst: (...args: any[]) => mocks.sourceFindFirst(...args) },
    product: { updateMany: (...args: any[]) => mocks.productUpdateMany(...args) },
    productEvidenceRequirementChange: {
      findUnique: (...args: any[]) => mocks.requirementFindUnique(...args),
      create: (...args: any[]) => mocks.requirementCreate(...args),
    },
    user: {
      findFirst: (...args: any[]) => mocks.userFindFirst(...args),
      findMany: (...args: any[]) => mocks.userFindMany(...args),
    },
    opLog: { create: (...args: any[]) => mocks.opLogCreate(...args) },
    deliveryOrder: { findFirst: (...args: any[]) => mocks.deliveryFindFirst(...args) },
    warehouseLedgerMovement: { findMany: (...args: any[]) => mocks.movementFindMany(...args) },
  }
  prismaMock.$transaction = vi.fn(async (fn: any) => fn(prismaMock))
  return { ...actual, prisma: prismaMock }
})

vi.mock('../../src/routes/upload', () => ({
  canManageSupplierEvidence: (role: string) => ['SUPER_ADMIN', 'ADMIN', 'SUPPLY_CHAIN'].includes(role),
  assertSupplierEvidenceObject: vi.fn(),
  signOssKey: (key: string) => `signed:${key}`,
}))

function document(id = 'doc-1') {
  return {
    id,
    supplierId: 'supplier-1',
    type: 'QUARANTINE_CERTIFICATE',
    version: 2,
    title: '检疫证明',
    note: '',
    validFrom: null,
    validUntil: null,
    archivedAt: new Date('2026-09-20T00:00:00Z'),
    objectKey: 'supplier-evidence-documents/tenant-1/doc.pdf',
    fileName: 'doc.pdf',
    fileMime: 'application/pdf',
    fileSize: 100,
    products: [{ productId: 'product-1', product: { id: 'product-1', code: 'P1', name: '牛肉', spec: '1kg' } }],
    createdByNameSnapshot: '供应链',
    createdByRoleSnapshot: 'SUPPLY_CHAIN',
    createdAt: new Date('2026-09-01T00:00:00Z'),
  }
}

function movement(overrides: any = {}) {
  return {
    id: 'out-1',
    warehouseId: 'warehouse-1',
    productId: 'product-1',
    lotAllocations: [{
      warehouseId: 'warehouse-1',
      productId: 'product-1',
      lot: {
        warehouseId: 'warehouse-1',
        productId: 'product-1',
        sourceMovement: {
          type: 'UPSTREAM_RECEIPT',
          physicalDelta: 10,
          warehouseId: 'warehouse-1',
          productId: 'product-1',
          upstreamReceiptLine: {
            id: 'receipt-line-1',
            productId: 'product-1',
            receipt: { id: 'receipt-1', no: 'RK-001', status: 'POSTED', supplier: { id: 'supplier-1', name: '上游供应商' } },
            evidenceDocumentLinks: [{ id: 'link-1', voidedAt: null, linkedAt: new Date('2026-09-10T00:00:00Z'), linkedAfterPosted: false, backfillReason: null, document: document() }],
          },
        },
      },
    }],
    ...overrides,
  }
}

async function makeApp(role = 'SUPPLY_CHAIN') {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => {
    request.user = { tenantId: 'tenant-1', userId: 'user-1', role, storeId: 'store-1', storeIds: ['store-1'] }
  })
  await app.register(supplierEvidenceDocumentRoutes, { prefix: '/api' })
  await app.ready()
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.userFindFirst.mockResolvedValue({ id: 'user-1', name: '供应链操作员', role: 'SUPPLY_CHAIN' })
  mocks.linkFindUnique.mockResolvedValue(null)
  mocks.linkFindFirst.mockResolvedValue(null)
  mocks.linkFindMany.mockResolvedValue([])
  mocks.linkCreate.mockResolvedValue({ id: 'link-created' })
  mocks.opLogCreate.mockResolvedValue({})
  mocks.requirementFindUnique.mockResolvedValue(null)
  mocks.requirementCreate.mockResolvedValue({})
  mocks.productUpdateMany.mockResolvedValue({ count: 1 })
})

describe('门店来货证明真实批次追溯', () => {
  it('仅返回由配送出库批次追到已过账采购到货行的证明，并保留归档状态', () => {
    const result = collectTraceableDeliveryEvidence([movement()])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      archived: true,
      supplierName: '上游供应商',
      actualProducts: [{ id: 'product-1', name: '牛肉' }],
      originalAssociations: [{ product: { id: 'product-1' } }],
      backfillAssociations: [],
    })
  })

  it.each([
    ['错商品', () => movement({ productId: 'other-product' })],
    ['错仓库', () => movement({ warehouseId: 'other-warehouse' })],
    ['未过账到货', () => {
      const value = movement()
      value.lotAllocations[0].lot.sourceMovement.upstreamReceiptLine.receipt.status = 'INSPECTING'
      return value
    }],
    ['未知来源', () => {
      const value = movement()
      value.lotAllocations[0].lot.sourceMovement.type = 'MANUAL_INBOUND'
      return value
    }],
    ['反向或零数量入库', () => {
      const value = movement()
      value.lotAllocations[0].lot.sourceMovement.physicalDelta = 0
      return value
    }],
    ['已作废关联', () => {
      const value = movement()
      value.lotAllocations[0].lot.sourceMovement.upstreamReceiptLine.evidenceDocumentLinks[0].voidedAt = new Date()
      return value
    }],
  ])('%s时拒绝回退到供应商泛查', (_label, makeMovement) => {
    expect(collectTraceableDeliveryEvidence([makeMovement()])).toEqual([])
  })

  it('同一证明由多个真实批次追到时只返回一次', () => {
    expect(collectTraceableDeliveryEvidence([movement(), movement({ id: 'out-2' })])).toHaveLength(1)
  })

  it('同一文档跨商品时保留实际商品和原始/补录关联，不用证明库全部商品冒充', () => {
    const first = movement()
    const second = movement({ id: 'out-2', productId: 'product-2' })
    const source = second.lotAllocations[0].lot.sourceMovement
    second.lotAllocations[0].productId = 'product-2'
    second.lotAllocations[0].lot.productId = 'product-2'
    source.productId = 'product-2'
    source.upstreamReceiptLine.productId = 'product-2'
    source.upstreamReceiptLine.evidenceDocumentLinks[0].linkedAfterPosted = true
    source.upstreamReceiptLine.evidenceDocumentLinks[0].backfillReason = '供应商延迟提供'
    source.upstreamReceiptLine.evidenceDocumentLinks[0].linkedAt = new Date('2026-09-11T00:00:00Z')
    source.upstreamReceiptLine.evidenceDocumentLinks[0].document.products.push({ productId: 'product-2', product: { id: 'product-2', code: 'P2', name: '羊肉', spec: '1kg' } })
    const result = collectTraceableDeliveryEvidence([first, second])
    expect(result).toHaveLength(1)
    expect(result[0].actualProducts.map((product: any) => product.name)).toEqual(['牛肉', '羊肉'])
    expect(result[0].originalAssociations).toHaveLength(1)
    expect(result[0].backfillAssociations).toEqual([expect.objectContaining({ product: expect.objectContaining({ name: '羊肉' }), reason: '供应商延迟提供' })])
  })
})

describe('来货资料关联和商品规则路由', () => {
  const postedReceipt = {
    id: 'receipt-1', supplierId: 'supplier-1', status: 'POSTED', arrivedAt: new Date('2026-09-28T02:00:00Z'),
    supplier: { businessScopes: ['WAREHOUSE_UPSTREAM'] },
    lines: [{ id: 'line-1', productId: 'product-1', arrivedQty: 10, acceptedQty: 0 }],
  }
  const productEvidence = {
    id: 'doc-1', supplierId: 'supplier-1', type: 'THIRD_PARTY_TEST_REPORT',
    validFrom: new Date('2026-09-28T00:00:00Z'), validUntil: new Date('2026-09-28T00:00:00Z'),
    products: [{ productId: 'product-1' }],
  }

  it('已过账仍可受控补录，但必填原因并冻结补录标识', async () => {
    mocks.receiptFindFirst.mockResolvedValue(postedReceipt)
    mocks.documentFindMany.mockResolvedValue([productEvidence])
    const app = await makeApp()
    const missingReason = await app.inject({ method: 'POST', url: '/api/upstream/receipts/receipt-1/evidence-links', payload: { links: [{ receiptLineId: 'line-1', documentIds: ['doc-1'] }], requestKey: 'request-posted-1' } })
    expect(missingReason.statusCode).toBe(400)
    const response = await app.inject({ method: 'POST', url: '/api/upstream/receipts/receipt-1/evidence-links', payload: { links: [{ receiptLineId: 'line-1', documentIds: ['doc-1'] }], requestKey: 'request-posted-2', backfillReason: '供应商延迟交付检测报告' } })
    expect(response.statusCode).toBe(201)
    expect(mocks.linkCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ linkedAfterPosted: true, backfillReason: '供应商延迟交付检测报告' }) }))
    expect(mocks.opLogCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: '事后补录到货行资料' }) }))
    await app.close()
  })

  it('全拒收但实到大于0的行仍可关联随货资料', async () => {
    mocks.receiptFindFirst.mockResolvedValue({ ...postedReceipt, status: 'INSPECTING' })
    mocks.documentFindMany.mockResolvedValue([productEvidence])
    const app = await makeApp()
    const response = await app.inject({ method: 'POST', url: '/api/upstream/receipts/receipt-1/evidence-links', payload: { links: [{ receiptLineId: 'line-1', documentIds: ['doc-1'] }], requestKey: 'request-rejected-batch' } })
    expect(response.statusCode).toBe(201)
    expect(mocks.linkCreate).toHaveBeenCalled()
    await app.close()
  })

  it('截止日当天可关联，营业执照不得冒充行级产品资料', async () => {
    mocks.receiptFindFirst.mockResolvedValue({ ...postedReceipt, status: 'INSPECTING' })
    mocks.documentFindMany.mockResolvedValue([productEvidence])
    const app = await makeApp()
    const valid = await app.inject({ method: 'POST', url: '/api/upstream/receipts/receipt-1/evidence-links', payload: { links: [{ receiptLineId: 'line-1', documentIds: ['doc-1'] }], requestKey: 'request-valid-until' } })
    expect(valid.statusCode).toBe(201)
    mocks.documentFindMany.mockResolvedValue([{ ...productEvidence, type: 'BUSINESS_LICENSE', products: [] }])
    const invalid = await app.inject({ method: 'POST', url: '/api/upstream/receipts/receipt-1/evidence-links', payload: { links: [{ receiptLineId: 'line-1', documentIds: ['doc-1'] }], requestKey: 'request-license-line' } })
    expect(invalid.statusCode).toBe(400)
    await app.close()
  })

  it('商品全局规则使用CAS+幂等事件，冲突时不静默覆盖', async () => {
    mocks.sourceFindFirst.mockResolvedValue({ id: 'source-1', product: { name: '牛肉', evidenceRequirement: 'PENDING', requiredEvidenceTypes: [], evidenceRequirementVersion: 0 } })
    const app = await makeApp()
    const payload = { expectedStatus: 'PENDING', expectedRequiredTypes: [], expectedVersion: 0, status: 'REQUIRED', requiredTypes: ['THIRD_PARTY_TEST_REPORT', 'SLAUGHTER_CERTIFICATE'], reason: '食品必须随货提供资料', requestKey: 'requirement-change-1' }
    const response = await app.inject({ method: 'PATCH', url: '/api/suppliers/supplier-1/evidence-requirements/product-1', payload })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ evidenceRequirement: 'REQUIRED', requiredEvidenceTypes: ['SLAUGHTER_CERTIFICATE', 'THIRD_PARTY_TEST_REPORT'], evidenceRequirementVersion: 1, duplicated: false })
    expect(mocks.productUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ requiredEvidenceTypes: ['SLAUGHTER_CERTIFICATE', 'THIRD_PARTY_TEST_REPORT'] }),
    }))
    mocks.productUpdateMany.mockResolvedValueOnce({ count: 0 })
    const conflict = await app.inject({ method: 'PATCH', url: '/api/suppliers/supplier-1/evidence-requirements/product-1', payload: { ...payload, requestKey: 'requirement-change-2' } })
    expect(conflict.statusCode).toBe(409)
    await app.close()
  })

  it('资料类型按集合比较并以固定顺序持久化，乱序请求不会假冲突', async () => {
    mocks.sourceFindFirst.mockResolvedValue({ id: 'source-1', product: { name: '牛肉', evidenceRequirement: 'REQUIRED', requiredEvidenceTypes: ['SLAUGHTER_CERTIFICATE', 'THIRD_PARTY_TEST_REPORT'], evidenceRequirementVersion: 3 } })
    const app = await makeApp()
    const response = await app.inject({ method: 'PATCH', url: '/api/suppliers/supplier-1/evidence-requirements/product-1', payload: {
      expectedStatus: 'REQUIRED', expectedRequiredTypes: ['THIRD_PARTY_TEST_REPORT', 'SLAUGHTER_CERTIFICATE'], expectedVersion: 3,
      status: 'REQUIRED', requiredTypes: ['THIRD_PARTY_TEST_REPORT', 'SLAUGHTER_CERTIFICATE'], reason: '确认牛肉两类资料', requestKey: 'requirement-order-1',
    } })
    expect(response.statusCode).toBe(200)
    expect(mocks.productUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ requiredEvidenceTypes: { equals: ['SLAUGHTER_CERTIFICATE', 'THIRD_PARTY_TEST_REPORT'] } }),
      data: expect.objectContaining({ requiredEvidenceTypes: ['SLAUGHTER_CERTIFICATE', 'THIRD_PARTY_TEST_REPORT'] }),
    }))
    await app.close()
  })

  it('门店只按本店配送真实批次返回产品资料与当日有效供应商执照', async () => {
    const tracedMovement = movement()
    const tracedReceipt = tracedMovement.lotAllocations[0].lot.sourceMovement.upstreamReceiptLine.receipt
    Object.assign(tracedReceipt, { arrivedAt: new Date('2026-09-28T02:00:00Z'), inspectorId: 'inspector-1', purchaseOrder: { createdById: 'buyer-1' }, evidenceCompletenessSnapshot: { businessLicense: { status: 'COMPLETE', documentId: 'license-1', version: 1 } } })
    mocks.deliveryFindFirst.mockResolvedValue({ id: 'delivery-1', no: 'PS001', storeId: 'store-1', warehouseId: 'warehouse-1', status: 'DELIVERED', pickerNameSnapshot: '分拣人', driverNameSnapshot: '司机', shippedBy: { name: '发货操作员' }, deliveredBy: { name: '送达操作员' } })
    mocks.movementFindMany.mockResolvedValue([tracedMovement])
    mocks.documentFindMany.mockResolvedValue([{
      ...document('license-1'), type: 'BUSINESS_LICENSE', title: '营业执照', supplierId: 'supplier-1',
      validFrom: new Date('2026-09-01T00:00:00Z'), validUntil: new Date('2026-09-28T00:00:00Z'), supplier: { name: '上游供应商' },
    }])
    mocks.userFindMany.mockResolvedValue([{ id: 'buyer-1', name: '采购人' }, { id: 'inspector-1', name: '验收人' }])
    const app = await makeApp('MANAGER')
    const response = await app.inject({ method: 'GET', url: '/api/deliveries/delivery-1/evidence-documents' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(mocks.deliveryFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ storeId: { in: ['store-1'] } }) }))
    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'SUPPLIER', type: 'BUSINESS_LICENSE', supplierBusinessDates: ['2026-09-28'] }),
      expect.objectContaining({ scope: 'PRODUCT', type: 'QUARANTINE_CERTIFICATE', actualProducts: [expect.objectContaining({ id: 'product-1' })] }),
    ]))
    expect(body.responsibilities).toMatchObject({ purchaseOrderCreators: ['采购人'], warehouseInspectors: ['验收人'], sorter: '分拣人', deliveryPerson: '司机', shippingOperator: '发货操作员', deliveredOperator: '送达操作员' })
    expect(JSON.stringify(body)).not.toContain('receipt-line-1')
    expect(JSON.stringify(body)).not.toContain('buyer-1')
    await app.close()
  })

  it('后上传但未冻结在过账快照的执照不冒充历史随货证照', async () => {
    const tracedMovement = movement()
    const tracedReceipt = tracedMovement.lotAllocations[0].lot.sourceMovement.upstreamReceiptLine.receipt
    Object.assign(tracedReceipt, { arrivedAt: new Date('2026-09-28T02:00:00Z'), evidenceCompletenessSnapshot: { businessLicense: { status: 'MISSING', documentId: null, version: null } } })
    mocks.deliveryFindFirst.mockResolvedValue({ id: 'delivery-1', no: 'PS001', storeId: 'store-1', warehouseId: 'warehouse-1', status: 'DELIVERED', pickerNameSnapshot: null, driverNameSnapshot: null, shippedBy: null, deliveredBy: null })
    mocks.movementFindMany.mockResolvedValue([tracedMovement])
    mocks.documentFindMany.mockResolvedValue([{ ...document('late-license'), type: 'BUSINESS_LICENSE', title: '后补执照', supplierId: 'supplier-1', supplier: { name: '上游供应商' } }])
    const app = await makeApp('MANAGER')
    const response = await app.inject({ method: 'GET', url: '/api/deliveries/delivery-1/evidence-documents' })
    expect(response.statusCode).toBe(200)
    expect(mocks.documentFindMany).not.toHaveBeenCalled()
    expect(response.json().items.some((item: any) => item.scope === 'SUPPLIER')).toBe(false)
    await app.close()
  })
})
