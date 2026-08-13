import { Prisma } from '@dianjie/db'

/**
 * 已入账收货单的更正。
 *
 * 项目规则:已确认入库单不得直接改，必须走审计更正。系统此前只有
 * `PATCH /receipts/:id/void`，而它明确拒绝 ACCOUNTED/CONFIRMED，
 * 于是入账后发现的错价没有任何合规出口。
 *
 * 这里的更正单是「留痕 + 审批」而不是复式红冲:门店预计库存和应付都是
 * 从 receipt_items 实时滚动出来的，系统里没有可供冲销的分录账，硬造一本
 * 反而会出现两个真相。所以做法是——原值完整保存在更正单 payload 与 OpLog 里，
 * 总厨批准后才落到单据行上，拒绝则单据分毫不动。
 *
 * 只更正价格，不碰数量:数量属于实物到货事实，错了要走退货或报损。
 */

const MONEY_DP = 2
const COST_DP = 6

export type ReceiptCorrectionInput = {
  receiptItemId: string
  newUnitPrice: Prisma.Decimal | number | string
}

export type ReceiptCorrectionLine = {
  receiptItemId: string
  productId: string
  productName: string
  quantity: string
  unit: string | null
  before: { unitPrice: string; amount: string; inventoryUnitCost: string | null }
  after: { unitPrice: string; amount: string; inventoryUnitCost: string | null }
  amountDelta: string
}

export type ReceiptCorrectionPlan = {
  receiptId: string
  receiptNo: string
  lines: ReceiptCorrectionLine[]
  totalBefore: string
  totalAfter: string
  totalDelta: string
}

type PlanReceipt = {
  id: string
  no: string
  status: string
  totalAmount: Prisma.Decimal
  items: Array<{
    id: string
    productId: string
    productNameSnapshot: string | null
    productUnitSnapshot: string | null
    quantity: Prisma.Decimal
    unitPrice: Prisma.Decimal
    amount: Prisma.Decimal
    inventoryQuantity: Prisma.Decimal | null
    inventoryUnitCostSnapshot: Prisma.Decimal | null
  }>
}

export class ReceiptCorrectionError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

/** 只有已入账/已确认的单据才需要走更正；其余状态走既有的作废或改单流程。 */
export const CORRECTABLE_RECEIPT_STATUSES = ['CONFIRMED', 'ACCOUNTED'] as const

function decimal(value: Prisma.Decimal | number | string, label: string): Prisma.Decimal {
  try {
    const parsed = new Prisma.Decimal(value as any)
    if (!parsed.isFinite()) throw new Error('not finite')
    return parsed
  } catch {
    throw new ReceiptCorrectionError(`${label}不是有效数字`)
  }
}

/**
 * 计算更正后的单据行与单据总额。纯计算，不碰数据库，便于在创建更正单和
 * 批准落地两处复用同一套算术。
 */
export function planReceiptCorrection(input: {
  receipt: PlanReceipt
  corrections: ReceiptCorrectionInput[]
}): ReceiptCorrectionPlan {
  const { receipt, corrections } = input
  if (!CORRECTABLE_RECEIPT_STATUSES.includes(receipt.status as any)) {
    throw new ReceiptCorrectionError(`入库单 ${receipt.no} 当前状态 ${receipt.status} 不需要走更正单`, 409)
  }
  if (!corrections.length) throw new ReceiptCorrectionError('至少要更正一行')
  const seen = new Set<string>()
  const itemById = new Map(receipt.items.map(item => [item.id, item]))
  const lines: ReceiptCorrectionLine[] = []
  let totalAfter: Prisma.Decimal

  for (const correction of corrections) {
    if (seen.has(correction.receiptItemId)) {
      throw new ReceiptCorrectionError('同一行不能重复更正')
    }
    seen.add(correction.receiptItemId)
    const item = itemById.get(correction.receiptItemId)
    if (!item) throw new ReceiptCorrectionError('更正的明细行不属于该入库单', 404)

    const label = item.productNameSnapshot || '商品'
    const newUnitPrice = decimal(correction.newUnitPrice, `${label}的更正单价`).toDecimalPlaces(MONEY_DP)
    if (newUnitPrice.lt(0)) throw new ReceiptCorrectionError(`${label}的更正单价不能为负`)
    if (newUnitPrice.equals(item.unitPrice)) {
      throw new ReceiptCorrectionError(`${label}的更正单价与原单价相同，无需更正`)
    }

    const newAmount = item.quantity.mul(newUnitPrice).toDecimalPlaces(MONEY_DP)
    // 每库存单位成本始终由「行金额 ÷ 记入库存量」推出，与单位名无关，
    // 不再依赖任何快照换算率——那正是这次事故的来源。
    const newInventoryUnitCost = item.inventoryQuantity && item.inventoryQuantity.gt(0)
      ? newAmount.div(item.inventoryQuantity).toDecimalPlaces(COST_DP)
      : null

    lines.push({
      receiptItemId: item.id,
      productId: item.productId,
      productName: label,
      quantity: item.quantity.toString(),
      unit: item.productUnitSnapshot,
      before: {
        unitPrice: item.unitPrice.toFixed(MONEY_DP),
        amount: item.amount.toFixed(MONEY_DP),
        inventoryUnitCost: item.inventoryUnitCostSnapshot?.toString() ?? null,
      },
      after: {
        unitPrice: newUnitPrice.toFixed(MONEY_DP),
        amount: newAmount.toFixed(MONEY_DP),
        inventoryUnitCost: newInventoryUnitCost?.toString() ?? null,
      },
      amountDelta: newAmount.minus(item.amount).toFixed(MONEY_DP),
    })
  }

  // 只在原总额上叠加被更正行的差额，不重新加总所有明细:重算会把单据上
  // 任何非明细来源的金额差静默抹掉，更正单应当只改它声明要改的东西。
  totalAfter = lines
    .reduce((sum, line) => sum.plus(new Prisma.Decimal(line.amountDelta)), receipt.totalAmount)
    .toDecimalPlaces(MONEY_DP)
  if (totalAfter.lt(0)) throw new ReceiptCorrectionError('更正后的单据总额不能为负')

  return {
    receiptId: receipt.id,
    receiptNo: receipt.no,
    lines,
    totalBefore: receipt.totalAmount.toFixed(MONEY_DP),
    totalAfter: totalAfter.toFixed(MONEY_DP),
    totalDelta: totalAfter.minus(receipt.totalAmount).toFixed(MONEY_DP),
  }
}

/** 已经付过款的排期不能被静默改额，必须人工处理。 */
export const ADJUSTABLE_SCHEDULE_STATUSES = ['PENDING', 'PENDING_APPROVAL', 'NOTIFIED'] as const

/**
 * 落地更正:改单据行、重算单据总额、同步尚未付款的付款排期。
 * 调用方负责事务、权限与审批状态判断。
 */
export async function applyReceiptCorrection(tx: any, input: {
  tenantId: string
  plan: ReceiptCorrectionPlan
  userId?: string | null
  role?: string | null
  documentNo?: string | null
}) {
  const { plan, tenantId } = input
  const receipt = await tx.receipt.findFirst({
    where: { id: plan.receiptId, tenantId },
    select: { id: true, no: true, status: true, totalAmount: true },
  })
  if (!receipt) throw new ReceiptCorrectionError('入库单不存在', 404)
  if (!CORRECTABLE_RECEIPT_STATUSES.includes(receipt.status as any)) {
    throw new ReceiptCorrectionError(`入库单 ${receipt.no} 状态已变为 ${receipt.status}，更正未生效`, 409)
  }
  if (!new Prisma.Decimal(receipt.totalAmount).equals(new Prisma.Decimal(plan.totalBefore))) {
    throw new ReceiptCorrectionError('入库单金额在审批期间已变化，请重新发起更正', 409)
  }

  for (const line of plan.lines) {
    const updated = await tx.receiptItem.updateMany({
      where: {
        id: line.receiptItemId,
        receiptId: plan.receiptId,
        unitPrice: new Prisma.Decimal(line.before.unitPrice),
      },
      data: {
        unitPrice: new Prisma.Decimal(line.after.unitPrice),
        amount: new Prisma.Decimal(line.after.amount),
        ...(line.after.inventoryUnitCost
          ? { inventoryUnitCostSnapshot: new Prisma.Decimal(line.after.inventoryUnitCost) }
          : {}),
      },
    })
    if (updated.count !== 1) {
      throw new ReceiptCorrectionError(`${line.productName} 的明细行已被改动，更正未生效`, 409)
    }
  }

  await tx.receipt.updateMany({
    where: { id: plan.receiptId, tenantId, totalAmount: new Prisma.Decimal(plan.totalBefore) },
    data: { totalAmount: new Prisma.Decimal(plan.totalAfter) },
  })

  // 应付排期必须跟着走，否则错误金额仍会按原计划付出去。
  const schedules = await tx.paymentSchedule.findMany({
    where: { receiptId: plan.receiptId, status: { in: [...ADJUSTABLE_SCHEDULE_STATUSES] } },
    select: { id: true, amount: true, status: true },
  })
  const adjustedSchedules: Array<{ id: string; before: string; after: string }> = []
  for (const schedule of schedules) {
    // 单据只有一笔排期时直接对齐总额；拆分成多笔的按比例缩放，避免凭空并单。
    const before = new Prisma.Decimal(schedule.amount)
    const after = schedules.length === 1
      ? new Prisma.Decimal(plan.totalAfter)
      : before.mul(new Prisma.Decimal(plan.totalAfter)).div(new Prisma.Decimal(plan.totalBefore)).toDecimalPlaces(MONEY_DP)
    if (before.equals(after)) continue
    await tx.paymentSchedule.updateMany({
      where: { id: schedule.id, amount: before },
      data: { amount: after },
    })
    adjustedSchedules.push({ id: schedule.id, before: before.toFixed(MONEY_DP), after: after.toFixed(MONEY_DP) })
  }

  await tx.opLog.create({
    data: {
      tenantId,
      userId: input.userId ?? null,
      role: input.role ?? null,
      action: `更正入库单 ${plan.receiptNo}:金额 ¥${plan.totalBefore} → ¥${plan.totalAfter}`
        + (input.documentNo ? `（审批单 ${input.documentNo}）` : ''),
      entityType: 'Receipt',
      target: plan.receiptNo,
      targetId: plan.receiptId,
      metadata: { plan, adjustedSchedules, documentNo: input.documentNo ?? null },
    },
  })

  return { receiptId: plan.receiptId, lineCount: plan.lines.length, adjustedSchedules }
}
