import { prisma } from '@dianjie/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  latestOperationGroupOrderId,
  loadOperationGroupDetails,
  mergeOperationGroupItems,
  operationGroupShipmentSummary,
} from '../../src/services/orderOperationGroupDetails'
import { operationGroupId } from '../../src/services/orderOperationGroups'

afterEach(() => vi.restoreAllMocks())

describe('operation group printable item merge', () => {
  it('merges only identical product snapshots and preserves source order numbers', () => {
    const items = mergeOperationGroupItems([
      {
        no: 'PO-01',
        items: [
          { productId: 'p1', name: '土豆', spec: '10kg', unit: '箱', quantity: '2', amount: '20.00' },
          { productId: 'p2', name: '青菜', spec: null, unit: '把', quantity: '3', amount: '9.00' },
        ],
      },
      {
        no: 'PO-02',
        items: [
          { productId: 'p1', name: '土豆', spec: '10kg', unit: '箱', quantity: '1', amount: '11.00' },
          // Same SKU but a different frozen specification is a separate line.
          { productId: 'p1', name: '土豆', spec: '5kg', unit: '箱', quantity: '1', amount: '6.00' },
        ],
      },
    ])

    expect(items).toHaveLength(3)
    expect(items.find(item => item.spec === '10kg')).toMatchObject({
      productId: 'p1', quantity: '3.00', amount: '31.00', sourceOrderNos: ['PO-01', 'PO-02'],
    })
    expect(items.find(item => item.spec === '5kg')).toMatchObject({
      productId: 'p1', quantity: '1.00', amount: '6.00', sourceOrderNos: ['PO-02'],
    })
  })

  it('preserves current zero-quantity delivery lines', () => {
    const items = mergeOperationGroupItems([
      {
        no: 'PO-01',
        items: [
          { productId: 'p1', name: '土豆', spec: null, unit: 'kg', quantity: '0', unitPrice: '6.50', amount: '0.00' },
          { productId: 'p2', name: '青菜', spec: null, unit: 'kg', quantity: '2', amount: '20.00' },
        ],
      },
    ])

    expect(items).toHaveLength(2)
    expect(items.find(item => item.productId === 'p1')).toMatchObject({
      quantity: '0.00', unitPrice: '6.50', amount: '0.00', sourceOrderNos: ['PO-01'],
    })
    expect(items.find(item => item.productId === 'p2')).toMatchObject({
      quantity: '2.00', amount: '20.00', sourceOrderNos: ['PO-01'],
    })
  })

  it('adds complete per-item frozen costs and keeps an incomplete merge private', () => {
    const complete = mergeOperationGroupItems([
      { no: 'PO-01', items: [{ productId: 'p1', name: '土豆', spec: null, unit: 'kg', quantity: '2', amount: '20', costAmount: '12.50' }] },
      { no: 'PO-02', items: [{ productId: 'p1', name: '土豆', spec: null, unit: 'kg', quantity: '1', amount: '10', costAmount: '6.25' }] },
    ])
    expect(complete[0]?.costAmount).toBe('18.75')

    const incomplete = mergeOperationGroupItems([
      { no: 'PO-01', items: [{ productId: 'p1', name: '土豆', spec: null, unit: 'kg', quantity: '2', amount: '20', costAmount: '12.50' }] },
      { no: 'PO-02', items: [{ productId: 'p1', name: '土豆', spec: null, unit: 'kg', quantity: '1', amount: '10' }] },
    ])
    expect(incomplete[0]?.costAmount).toBeNull()
  })
})

describe('operation group shipment amount boundary', () => {
  it('adds every valid delivery snapshot without falling back to unordered members', () => {
    expect(operationGroupShipmentSummary([
      { deliveries: [{ status: 'SHIPPED', actualTotalAmount: '21.50' }, { status: 'DELIVERED', actualTotalAmount: '8.25' }] },
      { deliveries: [] },
      { deliveries: [{ status: 'DRAFT', actualTotalAmount: '999.00' }, { status: 'CANCELLED', actualTotalAmount: '999.00' }] },
    ])).toEqual({ shipmentAmount: '29.75', hasAnyShipment: true, snapshotComplete: false })
  })

  it('reports zero shipment rather than substituting ordered money', () => {
    expect(operationGroupShipmentSummary([{ deliveries: [] }, { deliveries: [] }])).toEqual({
      shipmentAmount: '0.00', hasAnyShipment: false, snapshotComplete: false,
    })
  })
})

describe('operation group delivery summaries API', () => {
  it('returns every valid delivery with its own frozen product lines in chronological order', async () => {
    const memberIds = ['order-a', 'order-b']
    const groupId = operationGroupId(memberIds)
    const occurredAt = new Date('2026-09-03T03:00:00.000Z')
    vi.spyOn(prisma.purchaseOrderEvent, 'findMany').mockResolvedValue(memberIds.map((purchaseOrderId, index) => ({
      purchaseOrderId, occurredAt, metadata: { operationGroupId: groupId, operationGroupMemberIndex: index },
    })) as any)

    const base = {
      storeId: 'store-1', supplierId: 'supplier-1', expectedDate: new Date('2026-09-05T00:00:00.000Z'),
      status: 'CONFIRMED', updatedAt: occurredAt, rowVersion: 1, originalTotalAmount: '10.00', totalAmount: '10.00',
      receivedAt: null, store: { id: 'store-1', no: 'S01', name: '一店' },
      supplier: { id: 'supplier-1', name: '总仓' }, createdBy: null, shippedBy: null, items: [],
    }
    vi.spyOn(prisma.purchaseOrder, 'findMany').mockResolvedValue([
      {
        ...base, id: 'order-b', no: 'PO-02', createdAt: new Date('2026-09-03T02:00:00.000Z'), submittedAt: new Date('2026-09-03T02:00:00.000Z'),
        deliveries: [{
          id: 'draft-b', no: 'D-DRAFT-B', status: 'DRAFT', rowVersion: 3,
          createdAt: new Date('2026-09-03T02:10:00.000Z'), actualTotalAmount: '7',
          items: [{
            id: 'draft-item-b', purchaseOrderItemId: 'poi-3', productId: 'p3', shippedQty: '1',
            unitPriceSnapshot: '7', amount: '7', productNameSnapshot: '冻菜花', productUnitSnapshot: '颗',
            product: { name: '新菜花', unit: '箱' },
          }],
        }],
      },
      {
        ...base, id: 'order-a', no: 'PO-01', status: 'DELIVERING', createdAt: new Date('2026-09-03T01:00:00.000Z'), submittedAt: new Date('2026-09-03T01:00:00.000Z'),
        deliveries: [
          { no: 'D-DRAFT', status: 'DRAFT', createdAt: new Date('2026-09-03T01:10:00.000Z'), actualTotalAmount: '99', items: [] },
          {
            id: 'delivery-late', no: 'D-LATE', status: 'DELIVERED', rowVersion: 4, receipt: { id: 'receipt-1' },
            createdAt: new Date('2026-09-03T01:30:00.000Z'), shippedAt: new Date('2026-09-03T02:30:00.000Z'), actualTotalAmount: '6',
            items: [{ id: 'di-2', purchaseOrderItemId: 'poi-2', productId: 'p2', shippedQty: '3', unitPriceSnapshot: '2', amount: '6', productNameSnapshot: '冻土豆', productUnitSnapshot: '袋', product: { name: '新土豆', unit: '箱' } }],
          },
          {
            id: 'delivery-early', no: 'D-EARLY', status: 'SHIPPED', rowVersion: 2, receipt: null,
            createdAt: new Date('2026-09-03T01:20:00.000Z'), shippedAt: new Date('2026-09-03T02:00:00.000Z'), actualTotalAmount: '4',
            items: [{ id: 'di-1', purchaseOrderItemId: 'poi-1', productId: 'p1', shippedQty: '2', unitPriceSnapshot: '2', amount: '4', productNameSnapshot: '冻白菜', productUnitSnapshot: '斤', product: { name: '新白菜', unit: '箱' } }],
          },
          { no: 'D-CANCEL', status: 'CANCELLED', createdAt: occurredAt, actualTotalAmount: '99', items: [] },
        ],
      },
    ] as any)

    const detail = await loadOperationGroupDetails(
      { tenantId: 'tenant-1', role: 'SUPPLY_CHAIN' },
      groupId,
      { deliveryCostBreakdowns: async () => new Map([
        ['delivery-early', { total: '2.50', lineAmounts: new Map([['poi-1', '2.50']]) }],
        ['delivery-late', { total: '3.50', lineAmounts: new Map([['poi-2', '3.50']]) }],
      ]) },
    )

    expect(detail?.orders[0]).toMatchObject({
      no: 'PO-01',
      deliverySummaries: [
        {
          id: 'delivery-early', no: 'D-EARLY', status: 'SHIPPED', rowVersion: 2, hasReceipt: false,
          items: [{ name: '冻白菜', unit: '斤', quantity: '2' }],
        },
        {
          id: 'delivery-late', no: 'D-LATE', status: 'DELIVERED', rowVersion: 4, hasReceipt: true,
          items: [{ name: '冻土豆', unit: '袋', quantity: '3' }],
        },
      ],
    })
    expect((detail?.orders[0] as any).deliverySummaries.map((delivery: any) => delivery.no))
      .toEqual(['D-EARLY', 'D-LATE'])
    expect((detail?.orders[1] as any).deliverySummaries).toEqual([])
    expect((detail?.orders[1] as any).shipmentDraft).toMatchObject({
      id: 'draft-b', no: 'D-DRAFT-B', status: 'DRAFT', rowVersion: 3,
      items: [{ productId: 'p3', shippedQty: '1', amount: '7' }],
    })
    // Formal rows have complete outbound costs, but the CONFIRMED member's
    // draft row has no outbound cost yet. Never return the formal-only 6.00 as
    // though it were the complete mixed-document total.
    expect(detail?.totals.costAmount).toBeNull()
    expect(detail?.totals.amount).toBe('17.00')
    expect(detail?.mergedItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: 'p1', costAmount: '2.50' }),
      expect.objectContaining({ productId: 'p2', costAmount: '3.50' }),
      expect.objectContaining({ productId: 'p3', amount: '7.00', costAmount: null }),
    ]))
    const incompleteCostDetail = await loadOperationGroupDetails(
      { tenantId: 'tenant-1', role: 'SUPPLY_CHAIN' },
      groupId,
      { deliveryCosts: async () => new Map([['delivery-early', '2.50']]) },
    )
    expect(incompleteCostDetail?.totals.costAmount).toBeNull()
    const externalCostReader = vi.fn(async () => new Map([['delivery-early', '2.50'], ['delivery-late', '3.50']]))
    const supplierDetail = await loadOperationGroupDetails(
      { tenantId: 'tenant-1', role: 'SUPPLIER', supplierId: 'supplier-1' },
      groupId,
      { deliveryCosts: externalCostReader },
    )
    expect(externalCostReader).not.toHaveBeenCalled()
    expect(supplierDetail?.totals.costAmount).toBeNull()
    expect(prisma.purchaseOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        deliveries: expect.objectContaining({
          include: expect.objectContaining({
            items: expect.objectContaining({ where: { removedAt: null } }),
            receipt: { select: { id: true } },
          }),
        }),
      }),
    }))
  })
})

describe('operation group add-product owner', () => {
  it('selects the latest business submission time, with a stable id tie-break', () => {
    expect(latestOperationGroupOrderId([
      { id: 'a01', createdAt: '2026-08-31T10:00:00.000Z', submittedAt: '2026-08-31T09:00:00.000Z' },
      { id: 'a02', createdAt: '2026-08-31T10:01:00.000Z', submittedAt: '2026-08-31T11:15:00.000Z' },
      { id: 'a03', createdAt: '2026-08-31T10:02:00.000Z', submittedAt: '2026-08-31T11:15:00.000Z' },
    ])).toBe('a03')
  })

  it('falls back to createdAt for legacy rows without submittedAt', () => {
    expect(latestOperationGroupOrderId([
      { id: 'a01', createdAt: '2026-08-31T10:00:00.000Z' },
      { id: 'a02', createdAt: '2026-08-31T10:30:00.000Z' },
    ])).toBe('a02')
  })
})
