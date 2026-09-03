import { prisma } from '@dianjie/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  latestOperationGroupOrderId,
  loadOperationGroupDetails,
  mergeOperationGroupItems,
} from '../../src/services/orderOperationGroupDetails'
import { operationGroupId } from '../../src/services/orderOperationGroups'
import { FORMAL_DELIVERY_STATUSES, SERVER_SHIPMENT_DRAFT_KEY } from '../../src/services/shipmentDraftMarker'

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('ignores removed zero-quantity delivery lines', () => {
    const items = mergeOperationGroupItems([
      {
        no: 'PO-01',
        items: [
          { productId: 'p1', name: '土豆', spec: null, unit: 'kg', quantity: '0', amount: '0.00' },
          { productId: 'p2', name: '青菜', spec: null, unit: 'kg', quantity: '2', amount: '20.00' },
        ],
      },
    ])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ productId: 'p2', quantity: '2.00', amount: '20.00' })
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

describe('operation group shipment-draft compatibility', () => {
  it('loads only formal, unmarked deliveries for accepted group details', async () => {
    const memberIds = ['order-a', 'order-b']
    const groupId = operationGroupId(memberIds)
    vi.spyOn(prisma.purchaseOrderEvent, 'findMany').mockResolvedValue(memberIds.map((purchaseOrderId, index) => ({
      purchaseOrderId,
      occurredAt: new Date(`2026-09-03T0${index + 1}:00:00.000Z`),
      metadata: { operationGroupId: groupId, operationGroupMemberIndex: index },
    })) as any)
    const findMany = vi.spyOn(prisma.purchaseOrder, 'findMany').mockResolvedValue([])

    await expect(loadOperationGroupDetails({ tenantId: 'tenant-a', role: 'SUPPLY_CHAIN' }, groupId)).resolves.toBeNull()

    const deliveryWhere = (findMany.mock.calls[0][0] as any).include.deliveries.where
    expect(deliveryWhere.status).toEqual({ in: [...FORMAL_DELIVERY_STATUSES] })
    expect(deliveryWhere.OR).toEqual([
      { idempotencyKey: null },
      { idempotencyKey: { not: SERVER_SHIPMENT_DRAFT_KEY } },
    ])
  })
})
