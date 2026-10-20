import { Prisma } from '@dianjie/db'

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode })
type Line = { id: string; orderedQty: Prisma.Decimal.Value; unitPrice: Prisma.Decimal.Value; shippedQty: Prisma.Decimal.Value; receivedQty?: Prisma.Decimal.Value }
type Proposed = { lineId: string; quantity: number; unitPrice?: number }
export type RevisionLineSnapshot = { id: string; quantity: string; unitPrice?: string }
function positiveSix(value: Prisma.Decimal.Value) {
  const result = new Prisma.Decimal(value)
  if (!result.isFinite() || !result.gt(0) || result.gt('999999999') || result.decimalPlaces() > 6) throw fail('数量和单价必须大于0、最多六位小数且不超过999999999')
  return result
}
/** Only this order changes. Contract prices and historical receipts are never updated. */
export function proposeOrderRevision(lines: Line[], input: Proposed[]) {
  if (!input.length || new Set(input.map(row => row.lineId)).size !== input.length) throw fail('改单商品行不能为空或重复')
  const byId = new Map(lines.map(row => [row.id, row]))
  if (input.some(row => !byId.has(row.lineId))) throw fail('改单包含不属于该采购单的商品')
  if (lines.some(row => new Prisma.Decimal(row.shippedQty).gt(0) || new Prisma.Decimal(row.receivedQty || 0).gt(0))) throw fail('已有发货或收货记录，不能申请改单', 409)
  const before: RevisionLineSnapshot[] = lines.map(row => ({ id: row.id, quantity: new Prisma.Decimal(row.orderedQty).toString(), unitPrice: new Prisma.Decimal(row.unitPrice).toString() }))
  const after = lines.map(row => {
    const change = input.find(item => item.lineId === row.id)
    return { id: row.id, quantity: positiveSix(change?.quantity ?? row.orderedQty).toString(), unitPrice: positiveSix(change?.unitPrice ?? row.unitPrice).toString() }
  })
  return { before, after }
}
/** Old quantity-only revision snapshots remain readable; old unit price is retained. */
export function approvedOrderRevision(lines: Line[], before: RevisionLineSnapshot[], after: RevisionLineSnapshot[]) {
  if (after.length !== lines.length || new Set(after.map(row => row.id)).size !== after.length || after.some(row => !lines.some(line => line.id === row.id))) throw fail('改单快照商品行不完整或重复')
  if (lines.some(row => new Prisma.Decimal(row.shippedQty).gt(0) || new Prisma.Decimal(row.receivedQty || 0).gt(0))) throw fail('已有发货或收货记录，不能批准改单', 409)
  return lines.map(line => {
    const previous = before.find(row => row.id === line.id)
    const next = after.find(row => row.id === line.id)!
    if (!previous || !new Prisma.Decimal(previous.quantity).eq(line.orderedQty) || (previous.unitPrice !== undefined && !new Prisma.Decimal(previous.unitPrice).eq(line.unitPrice))) throw fail('采购单已变化，请刷新后重新申请', 409)
    return { id: line.id, quantity: positiveSix(next.quantity), unitPrice: positiveSix(next.unitPrice ?? line.unitPrice) }
  })
}
