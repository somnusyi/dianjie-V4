import { describe, expect, it } from 'vitest'
import { warehouseMovementLabel } from './warehouse-movement-label'
describe('warehouse movement origins', () => {
  it.each([
    ['WarehouseSelfLoss', '总仓自损'], ['WarehouseManualOutbound', '手工出库'], ['DeliveryOrder', '门店订单出库'],
    ['MeituanDailyPackage', '美团日包出库'], [null, '出库'], ['unknown', '出库'],
  ])('identifies %s without guessing from notes', (source, label) => {
    expect(warehouseMovementLabel('ORDER_OUTBOUND', source)).toBe(label)
  })
  it.each([['LOSS', '盘亏'], ['ADJUSTMENT', '盘盈']])('identifies stocktake %s without changing its movement type', (type, label) => {
    expect(warehouseMovementLabel(type, 'WarehouseStocktake')).toBe(label)
  })
  it('keeps other movement labels and unknown types readable', () => {
    expect(warehouseMovementLabel('ADJUSTMENT', 'WarehouseDocValueAdjust')).toBe('单据金额调整')
    expect(warehouseMovementLabel('MANUAL_INBOUND')).toBe('手工入库')
    expect(warehouseMovementLabel('LOSS')).toBe('仓库报损')
    expect(warehouseMovementLabel('FUTURE')).toBe('FUTURE')
  })
})
