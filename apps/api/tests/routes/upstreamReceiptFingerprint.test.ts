import { describe, expect, it } from 'vitest'
import { upstreamReceiptRequestFingerprint } from '../../src/routes/upstreamProcurement'

const line = (overrides: Record<string, unknown> = {}) => ({
  shipmentLineId: 'shipment-line-1',
  arrivedQty: 10,
  acceptedQty: 10,
  damagedQty: 0,
  rejectedQty: 0,
  batchNo: 'BATCH-20260928',
  manufactureDate: new Date('2026-09-27T00:00:00.000Z'),
  expiryDate: new Date('2026-10-27T00:00:00.000Z'),
  evidence: [{ type: 'PHOTO', objectKey: 'tenant/receipt/photo.jpg', note: '外包装' }],
  qualityResult: 'PASS' as const,
  qualityEvidence: [{ type: 'PHOTO', objectKey: 'tenant/receipt/quality.jpg', note: '验收' }],
  qualityDisposition: undefined,
  note: '到货正常',
  ...overrides,
})

const payload = (overrides: Record<string, unknown> = {}) => ({
  requestKey: 'receipt-request-20260928',
  arrivedAt: new Date('2026-09-28T02:00:00.000Z'),
  finalForShipment: true,
  evidence: [{ type: 'PHOTO', objectKey: 'tenant/receipt/main.jpg', note: '整车' }],
  note: '首批到货',
  lines: [line()],
  ...overrides,
})

describe('upstream receipt request fingerprint', () => {
  it('is stable for semantically identical JSON and line ordering', () => {
    const first = payload({
      evidence: [{ note: '整车', objectKey: 'tenant/receipt/main.jpg', type: 'PHOTO' }],
      lines: [line({ shipmentLineId: 'shipment-line-2' }), line()],
    })
    const second = payload({
      evidence: [{ type: 'PHOTO', objectKey: 'tenant/receipt/main.jpg', note: '整车' }],
      lines: [line(), line({ shipmentLineId: 'shipment-line-2' })],
    })

    expect(upstreamReceiptRequestFingerprint('shipment-1', first as any))
      .toBe(upstreamReceiptRequestFingerprint('shipment-1', second as any))
  })

  it('changes when a frozen quality result or evidence key changes', () => {
    const base = upstreamReceiptRequestFingerprint('shipment-1', payload() as any)
    const failed = upstreamReceiptRequestFingerprint('shipment-1', payload({
      lines: [line({
        acceptedQty: 0,
        rejectedQty: 10,
        qualityResult: 'FAIL',
        qualityDisposition: '整批退回供应商',
      })],
    }) as any)
    const differentEvidence = upstreamReceiptRequestFingerprint('shipment-1', payload({
      lines: [line({ qualityEvidence: [{ type: 'PHOTO', objectKey: 'tenant/receipt/other.jpg' }] })],
    }) as any)

    expect(failed).not.toBe(base)
    expect(differentEvidence).not.toBe(base)
  })

  it('changes when the shipment scope changes', () => {
    expect(upstreamReceiptRequestFingerprint('shipment-1', payload() as any))
      .not.toBe(upstreamReceiptRequestFingerprint('shipment-2', payload() as any))
  })
})
