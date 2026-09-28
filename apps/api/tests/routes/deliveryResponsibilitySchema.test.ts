import { describe, expect, it } from 'vitest'
import { deliveryDeliverSchema, deliveryShipSchema } from '../../src/routes/orders'

describe('delivery responsibility input', () => {
  it('requires an actual driver name before marking a delivery delivered', () => {
    expect(deliveryDeliverSchema.safeParse({ note: '已到店' }).success).toBe(false)
    expect(deliveryDeliverSchema.parse({ note: '已到店', driverName: '司机甲' })).toEqual({
      note: '已到店',
      driverName: '司机甲',
    })
  })

  it('accepts an explicit picker name in a shipment request and bounds its length', () => {
    const base = { idempotencyKey: 'shipment-request-1' }
    expect(deliveryShipSchema.parse({ ...base, pickerName: '分拣员乙' }).pickerName).toBe('分拣员乙')
    expect(deliveryShipSchema.safeParse({ ...base, pickerName: '分'.repeat(81) }).success).toBe(false)
  })
})
