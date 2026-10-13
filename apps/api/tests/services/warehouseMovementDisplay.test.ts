import { Prisma } from '@dianjie/db'
import { expect, it, vi } from 'vitest'
import { currentInboundValues } from '../../src/services/warehouseMovementDisplay'
it('adds repricing differences without rewriting original amounts and confines the query', async () => {
  const groupBy = vi.fn(async () => [{ sourceLineId: 'in-1', _sum: { valueDelta: new Prisma.Decimal(2) } }])
  const rows = [{ id: 'in-1', type: 'MANUAL_INBOUND', valueDelta: new Prisma.Decimal(3) }, { id: 'in-2', type: 'MANUAL_INBOUND', valueDelta: new Prisma.Decimal(7) }, { id: 'out-1', type: 'ORDER_OUTBOUND', valueDelta: new Prisma.Decimal(-9) }]
  const values = await currentInboundValues({ warehouseLedgerMovement: { groupBy } } as any, 'test-tenant', 'test-warehouse', rows)
  expect(Number(values.get('in-1'))).toBe(5)
  expect(Number(values.get('in-2'))).toBe(7)
  expect(values.has('out-1')).toBe(false)
  expect(Number(rows[0].valueDelta)).toBe(3)
  expect(groupBy).toHaveBeenCalledWith({ by: ['sourceLineId'], where: { tenantId: 'test-tenant', warehouseId: 'test-warehouse', sourceType: 'WarehouseDocValueAdjust', sourceLineId: { in: ['in-1', 'in-2'] } }, _sum: { valueDelta: true } })
})
it('does not query adjustments when there are no manual inbounds', async () => {
  const groupBy = vi.fn()
  expect((await currentInboundValues({ warehouseLedgerMovement: { groupBy } } as any, 't', 'w', [])).size).toBe(0)
  expect(groupBy).not.toHaveBeenCalled()
})
