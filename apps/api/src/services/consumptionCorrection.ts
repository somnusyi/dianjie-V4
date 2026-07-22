/**
 * 门店食材消耗 冲销/补记 (审计保留模式)
 *
 * 背景: 单位换算 bug 等原因产生的错误扣减不能直接删除 —— 按系统惯例保留审计痕迹。
 * 模式: 原行标记作废 (voidedAt/voidedReason/voidedById) 保留;
 *       需要修正时插入补记行 (sourceType='correction', sourceId=原行 id,
 *       correctionOfId=原行 id), calculationSnapshot 记录冲销上下文。
 * 读路径约定: 所有 stock_consumptions 读查询必须过滤 voidedAt: null,
 *       作废行不参与聚合/预估库存; 补记行按正常行计入, 库存数字随预估重算自愈。
 * 约束: 唯一键 (sourceType, sourceId, sourceLineKey, productId) 用固定
 *       sourceLineKey='correction' 规避; CHECK inventoryQuantity >= 0 由入参校验保证。
 */
import { Prisma } from '@dianjie/db'

export class VoidConsumptionError extends Error {
  statusCode: number
  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

export type VoidConsumptionInput = {
  consumptionId: string
  tenantId: string
  reason: string
  voidedById: string
  correctedQuantity?: Prisma.Decimal | number | string | null
  correctedInventoryQuantity?: Prisma.Decimal | number | string | null
  correctedCostAmount?: Prisma.Decimal | number | string | null
}

export type VoidConsumptionResult = {
  voidedId: string
  correctionId: string | null
}

/**
 * 在事务内冲销一行消耗, 可选插入补记行。
 * 重复冲销抛 409 (幂等报错), 行不存在/跨租户抛 404。
 */
export async function voidConsumptionWithCorrection(
  tx: Prisma.TransactionClient,
  input: VoidConsumptionInput,
): Promise<VoidConsumptionResult> {
  const reason = String(input.reason || '').trim()
  if (!reason) throw new VoidConsumptionError(400, '请填写作废原因')
  if (reason.length > 200) throw new VoidConsumptionError(400, '作废原因不能超过 200 字')

  const original = await tx.stockConsumption.findFirst({
    where: { id: input.consumptionId, tenantId: input.tenantId },
  })
  if (!original) throw new VoidConsumptionError(404, '消耗记录不存在或不属于当前租户')
  if (original.voidedAt) throw new VoidConsumptionError(409, '该消耗记录已作废，请勿重复冲销')

  const hasCorrection = input.correctedQuantity != null
    || input.correctedInventoryQuantity != null
    || input.correctedCostAmount != null

  const voidedAt = new Date()
  await tx.stockConsumption.update({
    where: { id: original.id },
    data: { voidedAt, voidedReason: reason, voidedById: input.voidedById },
  })

  if (!hasCorrection) return { voidedId: original.id, correctionId: null }

  const correctedInventoryQuantity = input.correctedInventoryQuantity != null
    ? new Prisma.Decimal(input.correctedInventoryQuantity)
    : new Prisma.Decimal(input.correctedQuantity!)
  const correctedQuantity = input.correctedQuantity != null
    ? new Prisma.Decimal(input.correctedQuantity)
    : correctedInventoryQuantity
  if (correctedInventoryQuantity.lt(0) || correctedQuantity.lt(0)) {
    throw new VoidConsumptionError(400, '修正数量不能为负数')
  }
  const correctedCostAmount = input.correctedCostAmount != null
    ? new Prisma.Decimal(input.correctedCostAmount)
    : original.unitCostSnapshot != null
      ? correctedInventoryQuantity.mul(original.unitCostSnapshot).toDecimalPlaces(4)
      : null
  if (correctedCostAmount != null && correctedCostAmount.lt(0)) {
    throw new VoidConsumptionError(400, '修正金额不能为负数')
  }

  const correction = await tx.stockConsumption.create({
    data: {
      tenantId: original.tenantId,
      storeId: original.storeId,
      productId: original.productId,
      date: original.date,
      quantity: correctedQuantity.toDecimalPlaces(6),
      inventoryQuantity: correctedInventoryQuantity.toDecimalPlaces(6),
      unitSnapshot: original.unitSnapshot,
      inventoryUnitSnapshot: original.inventoryUnitSnapshot,
      unitCostSnapshot: original.unitCostSnapshot,
      costAmountSnapshot: correctedCostAmount,
      note: original.note,
      dishId: original.dishId,
      variantKey: original.variantKey,
      bomVersionId: original.bomVersionId,
      sourceType: 'correction',
      sourceId: original.id,
      sourceLineKey: 'correction',
      correctionOfId: original.id,
      calculationSnapshot: {
        correctionOf: original.id,
        originalInventoryQuantity: original.inventoryQuantity?.toString() ?? null,
        reason,
      },
      createdById: input.voidedById,
    },
  })
  return { voidedId: original.id, correctionId: correction.id }
}
