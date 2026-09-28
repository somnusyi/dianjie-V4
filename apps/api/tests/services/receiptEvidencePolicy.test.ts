import { describe, expect, it, vi } from 'vitest'
import { businessDayUtc, evaluateReceiptEvidenceCompleteness } from '../../src/services/receiptEvidencePolicy'

const businessAt = new Date('2026-09-27T16:30:00.000Z') // 上海2026-09-28 00:30
const lines = [
  { id: 'line-beef', productId: 'beef', arrivedQty: 10, acceptedQty: 10, product: { evidenceRequirement: 'REQUIRED' as const, requiredEvidenceTypes: ['SLAUGHTER_CERTIFICATE', 'THIRD_PARTY_TEST_REPORT'] }, purchaseOrderLine: { productNameSnapshot: '牛肉' } },
  { id: 'line-tissue', productId: 'tissue', arrivedQty: 5, acceptedQty: 5, product: { evidenceRequirement: 'NOT_REQUIRED' as const }, purchaseOrderLine: { productNameSnapshot: '纸巾' } },
  { id: 'line-unknown', productId: 'unknown', arrivedQty: 2, acceptedQty: 0, product: { evidenceRequirement: 'PENDING' as const }, purchaseOrderLine: { productNameSnapshot: '待配商品' } },
]

function tx(input: { license?: boolean; links?: any[] } = {}) {
  return {
    supplierEvidenceDocument: { findFirst: vi.fn().mockResolvedValue(input.license === false ? null : { id: 'license-1', version: 2, createdAt: new Date('2026-09-01T00:00:00Z') }) },
    upstreamReceiptLineEvidenceDocument: { findMany: vi.fn().mockResolvedValue(input.links || []) },
  }
}

describe('上游收货资料完整性提示', () => {
  it('以上海业务日而非UTC日判断起止日', async () => {
    expect(businessDayUtc(businessAt).toISOString()).toBe('2026-09-28T00:00:00.000Z')
    const client = tx({ license: false })
    await evaluateReceiptEvidenceCompleteness(client, { tenantId: 't1', supplierId: 's1', businessAt, lines })
    expect(client.supplierEvidenceDocument.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          { OR: [{ validFrom: null }, { validFrom: { lte: new Date('2026-09-28T00:00:00.000Z') } }] },
          { OR: [{ validUntil: null }, { validUntil: { gte: new Date('2026-09-28T00:00:00.000Z') } }] },
        ]),
      }),
    }))
  })

  it('缺件只返回提示，不抛出过账阻断', async () => {
    const result = await evaluateReceiptEvidenceCompleteness(tx({ license: false }), { tenantId: 't1', supplierId: 's1', businessAt, lines })
    expect(result).toMatchObject({ missingCount: 3, pendingConfigurationCount: 1, blocksPosting: false, businessLicense: { status: 'MISSING' } })
    expect(result.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: 'beef', status: 'MISSING' }),
      expect.objectContaining({ productId: 'tissue', status: 'NOT_REQUIRED' }),
      expect.objectContaining({ productId: 'unknown', status: 'PENDING_CONFIGURATION' }),
    ]))
  })

  it('按商品配置的多种资料逐项判断，缺一种仍为缺件', async () => {
    const partial = await evaluateReceiptEvidenceCompleteness(tx({ links: [{ receiptLineId: 'line-beef', document: { type: 'THIRD_PARTY_TEST_REPORT', products: [{ productId: 'beef' }] } }] }), { tenantId: 't1', supplierId: 's1', businessAt, lines })
    expect(partial.missingCount).toBe(1)
    expect(partial.lines.find(line => line.productId === 'beef')).toMatchObject({ status: 'MISSING', missingTypes: ['SLAUGHTER_CERTIFICATE'] })
    const result = await evaluateReceiptEvidenceCompleteness(tx({ links: [
      { receiptLineId: 'line-beef', document: { type: 'THIRD_PARTY_TEST_REPORT', products: [{ productId: 'beef' }] } },
      { receiptLineId: 'line-beef', document: { type: 'SLAUGHTER_CERTIFICATE', products: [{ productId: 'beef' }] } },
    ] }), { tenantId: 't1', supplierId: 's1', businessAt, lines })
    expect(result.missingCount).toBe(0)
    expect(result.lines.find(line => line.productId === 'beef')?.status).toBe('COMPLETE')
  })

  it('REQUIRED但未配所需类型时只能标记待配置，不伪装齐全', async () => {
    const result = await evaluateReceiptEvidenceCompleteness(tx(), { tenantId: 't1', supplierId: 's1', businessAt, lines: [{ ...lines[0], product: { evidenceRequirement: 'REQUIRED' as const, requiredEvidenceTypes: [] } }] })
    expect(result).toMatchObject({ pendingConfigurationCount: 1 })
    expect(result.lines[0].status).toBe('PENDING_CONFIGURATION')
  })

  it('实到大于0即纳入，即使合格数为0也保留拒收批次追溯', async () => {
    const result = await evaluateReceiptEvidenceCompleteness(tx(), { tenantId: 't1', supplierId: 's1', businessAt, lines: [{ ...lines[0], acceptedQty: 0 }] })
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]).toMatchObject({ receiptLineId: 'line-beef', status: 'MISSING' })
  })

  it('截止日当天仍有效，次日由DATE查询边界阻断', async () => {
    const client = tx()
    await evaluateReceiptEvidenceCompleteness(client, { tenantId: 't1', supplierId: 's1', businessAt, lines })
    const where = client.supplierEvidenceDocument.findFirst.mock.calls[0][0].where
    expect(where.AND[1]).toEqual({ OR: [{ validUntil: null }, { validUntil: { gte: new Date('2026-09-28T00:00:00.000Z') } }] })
  })
})
