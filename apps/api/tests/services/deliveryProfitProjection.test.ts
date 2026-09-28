import { describe, expect, it } from 'vitest'
import { projectDeliveryProfits } from '../../src/services/deliveryProfitProjection'
import { aggregateFinance } from '../../src/services/supplyChainFinanceReports'

const deliveries = [{
  id: 'delivery-1',
  items: [{
    id: 'delivery-item-1',
    productId: 'product-1',
    purchaseOrderItemId: 'order-item-1',
    orderedQtySnapshot: '10',
    shippedQty: '8',
    unitPriceSnapshot: '12.50',
    amount: '100.00',
  }],
}]

describe('delivery profit projection', () => {
  it('uses frozen outbound ledger cost and frozen shipment price', () => {
    const result = projectDeliveryProfits(deliveries, [{
      id: 'movement-1',
      sourceId: 'delivery-1',
      sourceLineId: 'order-item-1',
      productId: 'product-1',
      originalQuantity: '8',
      valueDelta: '-60',
    }], []).get('delivery-1')!

    expect(result).toMatchObject({
      shippedAmount: '100.00',
      settlementAmount: '100.00',
      costAmount: '60.00',
      profit: '40.00',
      completeCost: true,
    })
    expect(result.lines[0]).toMatchObject({
      costUnitPrice: '7.50',
      costAmount: '60.00',
      profit: '40.00',
    })
  })

  it('applies return and cancellation reversals to both settlement and frozen cost', () => {
    const result = projectDeliveryProfits(deliveries, [{
      id: 'movement-1', sourceId: 'delivery-1', sourceLineId: 'order-item-1',
      productId: 'product-1',
      originalQuantity: '8', valueDelta: '-60',
    }], [{
      sourceLineId: 'movement-1', originalQuantity: '2', valueDelta: '15', sourceType: 'ReceiptRejectionReversal',
    }]).get('delivery-1')!

    expect(result).toMatchObject({
      settlementAmount: '75.00',
      costAmount: '45.00',
      profit: '30.00',
    })
    expect(result.lines[0].settlementQuantity).toBe('6.00')

    const report = aggregateFinance([
      { id: 'out', customerId: 'store-1', warehouseId: 'warehouse-1', productId: 'product-1', unit: 'kg', spec: '1kg', category: '食材', quantity: 8, revenue: 100, cost: 60 },
      { id: 'return', customerId: 'store-1', warehouseId: 'warehouse-1', productId: 'product-1', unit: 'kg', spec: '1kg', category: '食材', quantity: -2, revenue: -25, cost: -15 },
    ], 'item-profit')[0]
    expect({ revenue: report.revenue, cost: report.cost, profit: report.profit }).toEqual({
      revenue: Number(result.settlementAmount),
      cost: Number(result.costAmount),
      profit: Number(result.profit),
    })
  })

  it('keeps missing cost and profit null instead of inventing zero', () => {
    const result = projectDeliveryProfits(deliveries, [], []).get('delivery-1')!
    expect(result.costAmount).toBeNull()
    expect(result.profit).toBeNull()
    expect(result.lines[0].costUnitPrice).toBeNull()
    expect(result.lines[0].costAmount).toBeNull()
    expect(result.lines[0].profit).toBeNull()
    expect(result.warnings).toContain('部分商品缺少冻结出库成本，成本及利润显示“—”')
  })

  it('does not attach a movement from another delivery with the same source line', () => {
    const result = projectDeliveryProfits(deliveries, [{
      id: 'movement-foreign', sourceId: 'delivery-2', sourceLineId: 'order-item-1',
      productId: 'product-1',
      originalQuantity: '8', valueDelta: '-60',
    }], []).get('delivery-1')!
    expect(result.costAmount).toBeNull()
    expect(result.profit).toBeNull()
  })

  it('ignores unrelated reversal types and keeps the frozen shipment result', () => {
    const result = projectDeliveryProfits(deliveries, [{
      id: 'movement-1', sourceId: 'delivery-1', sourceLineId: 'order-item-1',
      productId: 'product-1',
      originalQuantity: '8', valueDelta: '-60',
    }], [{
      sourceLineId: 'movement-1', originalQuantity: '2', valueDelta: '15', sourceType: 'InventoryCorrection',
    }]).get('delivery-1')!
    expect(result).toMatchObject({ settlementAmount: '100.00', costAmount: '60.00', profit: '40.00' })
  })

  it('does not dereference null when an early movement has an invalid cost direction', () => {
    const result = projectDeliveryProfits(deliveries, [
      { id: 'bad', productId: 'product-1', sourceId: 'delivery-1', sourceLineId: 'order-item-1', originalQuantity: '1', valueDelta: '1' },
      { id: 'later', productId: 'product-1', sourceId: 'delivery-1', sourceLineId: 'order-item-1', originalQuantity: '7', valueDelta: '-59' },
    ], []).get('delivery-1')!
    expect(result.costAmount).toBeNull()
    expect(result.profit).toBeNull()
    expect(result.warnings).toContain('出库成本流水方向异常，相关利润未计算')
  })

  it('keeps decimal arithmetic exact and treats a complete return as zero, not missing cost', () => {
    const decimalDelivery = [{
      id: 'delivery-decimal',
      items: [{ id: 'item-decimal', productId: 'product-decimal', purchaseOrderItemId: 'order-decimal', orderedQtySnapshot: '0.300000', shippedQty: '0.300000', unitPriceSnapshot: '0.20', amount: '0.06' }],
    }]
    const outbounds = [{ id: 'movement-decimal', productId: 'product-decimal', sourceId: 'delivery-decimal', sourceLineId: 'order-decimal', originalQuantity: '0.300000', valueDelta: '-0.030000' }]
    const normal = projectDeliveryProfits(decimalDelivery, outbounds, []).get('delivery-decimal')!
    expect(normal).toMatchObject({ settlementAmount: '0.06', costAmount: '0.03', profit: '0.03' })

    const returned = projectDeliveryProfits(decimalDelivery, outbounds, [{
      sourceLineId: 'movement-decimal', originalQuantity: '0.300000', valueDelta: '0.030000', sourceType: 'ReceiptRejectionReversal',
    }]).get('delivery-decimal')!
    expect(returned).toMatchObject({ settlementAmount: '0.00', costAmount: '0.00', profit: '0.00', completeCost: true })
    expect(returned.lines[0]).toMatchObject({ settlementQuantity: '0.00', costUnitPrice: null })
  })

  it('treats an active zero-shipment line as known zero cost without poisoning the document', () => {
    const mixed = [{
      ...deliveries[0],
      items: [
        ...deliveries[0].items,
        { id: 'zero-line', productId: 'product-zero', purchaseOrderItemId: 'order-zero', orderedQtySnapshot: '2', shippedQty: '0', unitPriceSnapshot: '8', amount: '0' },
      ],
    }]
    const result = projectDeliveryProfits(mixed, [{
      id: 'movement-1', sourceId: 'delivery-1', sourceLineId: 'order-item-1', originalQuantity: '8', valueDelta: '-60',
      productId: 'product-1',
    }], []).get('delivery-1')!
    expect(result).toMatchObject({ completeCost: true, costAmount: '60.00', profit: '40.00' })
    expect(result.lines[1]).toMatchObject({ costAmount: '0.00', profit: '0.00', settlementAmount: '0.00' })
    expect(result.warnings).toEqual([])
  })

  it('returns null profit when shipment and frozen outbound quantities do not reconcile', () => {
    const result = projectDeliveryProfits(deliveries, [{
      id: 'movement-short', sourceId: 'delivery-1', sourceLineId: 'order-item-1', originalQuantity: '7', valueDelta: '-52.50',
      productId: 'product-1',
    }], []).get('delivery-1')!
    expect(result.costAmount).toBeNull()
    expect(result.profit).toBeNull()
    expect(result.warnings).toContain('发货数量与冻结出库台账无法勾稽，相关利润未计算')
  })

  it('allows a document quantity reduction only when a matching ship-cancel reversal exists', () => {
    const reduced = [{
      ...deliveries[0],
      items: [{ ...deliveries[0].items[0], shippedQty: '6', amount: '75' }],
    }]
    const result = projectDeliveryProfits(reduced, [{
      id: 'movement-1', sourceId: 'delivery-1', sourceLineId: 'order-item-1', originalQuantity: '8', valueDelta: '-60',
      productId: 'product-1',
    }], [{
      sourceLineId: 'movement-1', originalQuantity: '2', valueDelta: '15', sourceType: 'DeliveryOrderShipCancel',
    }]).get('delivery-1')!
    expect(result).toMatchObject({ completeCost: true, settlementAmount: '75.00', costAmount: '45.00', profit: '30.00' })
  })

  it('rejects negative reversal quantities or values', () => {
    const result = projectDeliveryProfits(deliveries, [{
      id: 'movement-1', sourceId: 'delivery-1', sourceLineId: 'order-item-1', originalQuantity: '8', valueDelta: '-60',
      productId: 'product-1',
    }], [{
      sourceLineId: 'movement-1', originalQuantity: '-1', valueDelta: '7.5', sourceType: 'LossClaimReversal',
    }]).get('delivery-1')!
    expect(result.costAmount).toBeNull()
    expect(result.profit).toBeNull()
    expect(result.warnings).toContain('冲回数量或成本流水异常，相关利润未计算')
  })

  it('rejects an outbound movement whose product differs from the delivery item', () => {
    const result = projectDeliveryProfits(deliveries, [{
      id: 'movement-wrong-product', productId: 'product-2', sourceId: 'delivery-1',
      sourceLineId: 'order-item-1', originalQuantity: '8', valueDelta: '-60',
    }], []).get('delivery-1')!
    expect(result.costAmount).toBeNull()
    expect(result.profit).toBeNull()
    expect(result.warnings).toContain('物品与冻结出库流水不一致，相关利润未计算')
  })

  it('does not apply a reversal whose product differs from its original outbound movement', () => {
    const result = projectDeliveryProfits(deliveries, [{
      id: 'movement-1', productId: 'product-1', sourceId: 'delivery-1', sourceLineId: 'order-item-1', originalQuantity: '8', valueDelta: '-60',
    }], [{
      productId: 'product-2', sourceLineId: 'movement-1', originalQuantity: '2', valueDelta: '15', sourceType: 'ReceiptRejectionReversal',
    }]).get('delivery-1')!
    expect(result).toMatchObject({ settlementAmount: '100.00', costAmount: '60.00', profit: '40.00' })
    expect(result.warnings).toContain('冲回物品与原出库流水不一致，已排除该冲回')
  })
})
