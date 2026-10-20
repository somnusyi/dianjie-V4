import { Prisma } from '@dianjie/db'
type Value = Prisma.Decimal.Value
const fail = (message: string) => Object.assign(new Error(message), { statusCode: 400 })
function nonnegative(value: Value, places: number, label: string, limit = '1000000000000') {
  let result: Prisma.Decimal
  try { result = new Prisma.Decimal(value) } catch { throw fail(`${label}无效`) }
  if (!result.isFinite() || result.lt(0) || result.decimalPlaces() > places || result.gte(limit)) throw fail(`${label}必须非负且最多${places}位小数`)
  return result
}
export function receiptPricing(quantity: Value, unitPrice: Value, payableAmount?: Value) {
  const qty = nonnegative(quantity, 6, '数量'), price = nonnegative(unitPrice, 6, '单价')
  const amount = payableAmount === undefined ? qty.mul(price).toDecimalPlaces(4) : nonnegative(payableAmount, 4, '金额', '10000000000000000')
  if (amount.gte('10000000000000000')) throw fail('金额超出数据库精度范围')
  if (qty.isZero() && !amount.isZero()) throw fail('数量为0时金额必须为0')
  // Six-place displayed price can be approximate; four-place entered amount is authoritative.
  if (!qty.isZero() && amount.minus(qty.mul(price)).abs().gt(qty.mul('0.0000005').plus('0.00005'))) throw fail('数量、金额与单价不一致，请重新输入金额或单价')
  return { unitPrice: price, payableAmount: amount }
}
export function returnSettlementAmount(sourceQuantity: Value, sourceAmount: Value, quantity: Value, reservedQuantity: Value = 0, reservedAmount: Value = 0) {
  const totalQty = nonnegative(sourceQuantity, 6, '原收货数量'), totalAmount = nonnegative(sourceAmount, 4, '原收货金额', '10000000000000000')
  const qty = nonnegative(quantity, 6, '退货数量'), usedQty = nonnegative(reservedQuantity, 6, '已占用退货数量'), usedAmount = nonnegative(reservedAmount, 4, '已占用退货金额', '10000000000000000')
  if (!totalQty.gt(0) || !qty.gt(0) || usedQty.plus(qty).gt(totalQty) || usedAmount.gt(totalAmount)) throw fail('原收货数量或金额与累计退货不一致，请核对原单')
  const remainder = totalAmount.minus(usedAmount)
  return usedQty.plus(qty).eq(totalQty) ? remainder : Prisma.Decimal.min(totalAmount.mul(qty).div(totalQty).toDecimalPlaces(4), remainder)
}
