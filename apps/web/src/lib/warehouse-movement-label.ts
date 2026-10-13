const labels: Record<string, string> = {
  OPENING_BALANCE: '期初建账', MANUAL_INBOUND: '手工入库',
  ORDER_RESERVED: '门店订单预占', ORDER_RELEASED: '订单预占释放',
  ADJUSTMENT: '盘点调整', LOSS: '仓库报损', REVERSAL: '冲销',
}

export function warehouseMovementLabel(type: string, sourceType?: string | null): string {
  if (type === 'ADJUSTMENT' && sourceType === 'WarehouseDocValueAdjust') return '单据金额调整'
  if (sourceType === 'WarehouseStocktake') {
    if (type === 'LOSS') return '盘亏'
    if (type === 'ADJUSTMENT') return '盘盈'
  }
  if (type === 'ORDER_OUTBOUND') {
    if (sourceType === 'WarehouseSelfLoss') return '总仓自损'
    if (sourceType === 'WarehouseManualOutbound') return '手工出库'
    if (sourceType === 'DeliveryOrder') return '门店订单出库'
    if (sourceType === 'MeituanDailyPackage') return '美团日包出库'
    return '出库'
  }
  return labels[type] || type
}
