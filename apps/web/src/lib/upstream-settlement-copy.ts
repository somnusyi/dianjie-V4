export function settlementLineTypeLabel(
  sourceType: string,
  adjustmentAmount: string | number,
) {
  if (sourceType === 'RECEIPT') return '收货'
  if (sourceType !== 'CLAIM') return sourceType
  return Number(adjustmentAmount) === 0 ? '差异记录' : '差异扣款'
}

export function claimResolutionCopy(type: string, amount: string) {
  if (type === 'POST_RECEIPT_DAMAGE') {
    return {
      button: '确认责任并扣款',
      confirmation: `确认供应商责任并按 ${amount} 计入对账扣款办结？`,
    }
  }
  if (type === 'OVERAGE') {
    return {
      button: '确认责任并办结',
      confirmation: '确认供应商责任并办结？仅已计入收货应付的超收部分会进入扣款。',
    }
  }
  return {
    button: '确认责任并办结',
    confirmation: '确认供应商责任并办结？该差异已在收货净额中体现，不会重复扣款。',
  }
}
