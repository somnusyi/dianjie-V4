import { describe, expect, it } from 'vitest'
import { replenishmentItemSummary, replenishmentNextStep, type ReplenishmentOrder } from './replenishment-orders'

const base = {
  id: 'ro-1', no: 'RO001', displayStatus: 'DRAFT', items: [], fulfillment: null,
} as unknown as ReplenishmentOrder

describe('门店补货单页面投影', () => {
  it('keeps one unambiguous next action for every business state', () => {
    expect(replenishmentNextStep(base).label).toBe('继续编辑')
    expect(replenishmentNextStep({ ...base, displayStatus: 'SUBMITTED' }).label).toBe('接单')
    expect(replenishmentNextStep({ ...base, displayStatus: 'ACCEPTED', fulfillment: { purchaseOrderId: 'po-1', purchaseOrder: { id: 'po-1', no: 'PO001', status: 'CONFIRMED' } } }).href).toBe('/v2/supply-chain/fulfillment/po-1')
    expect(replenishmentNextStep({ ...base, displayStatus: 'FULFILLING', fulfillment: { purchaseOrderId: 'po-1', purchaseOrder: { id: 'po-1', no: 'PO001', status: 'DELIVERING' } } }).href).toContain('/deliveries?keyword=PO001')
    expect(replenishmentNextStep({ ...base, displayStatus: 'COMPLETED', fulfillment: { purchaseOrderId: 'po-1', purchaseOrder: { id: 'po-1', no: 'PO001', status: 'COMPLETED' } } }).href).toContain('/receipts?keyword=PO001')
    expect(replenishmentNextStep({ ...base, displayStatus: 'EXCEPTION' }).label).toBe('处理异常')
  })

  it('builds a compact product summary', () => {
    const items = ['白菜', '土豆', '茄子', '青椒'].map((name, index) => ({ productId: String(index), productNameSnapshot: name })) as any
    expect(replenishmentItemSummary(items)).toBe('白菜、土豆、茄子 等4项')
  })
})
