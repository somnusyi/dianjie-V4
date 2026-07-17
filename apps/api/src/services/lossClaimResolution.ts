import { Prisma } from '@dianjie/db'
import { z } from 'zod'

export const lossClaimResolutionSchema = z.object({
  finalDeductAmount: z.number()
    .nonnegative('最终扣减金额不能为负数')
    .max(99_999_999.99, '最终扣减金额超出范围')
    .refine(value => new Prisma.Decimal(value).decimalPlaces() <= 2, '最终扣减金额最多保留 2 位小数'),
  note: z.string().trim().max(500).optional(),
}).strict()

/**
 * 金额仲裁暂时没有逐行结论，因此按报损金额比例计算各行的库存回补量。
 * 数量保留 2 位，与当前 Product.stock 精度一致。
 */
export function proratedLossQuantity(
  lossQty: Prisma.Decimal.Value,
  finalDeductAmount: Prisma.Decimal.Value,
  totalLossAmount: Prisma.Decimal.Value,
) {
  const total = new Prisma.Decimal(totalLossAmount)
  if (total.lte(0)) return new Prisma.Decimal(0)
  const deduct = Prisma.Decimal.min(Prisma.Decimal.max(new Prisma.Decimal(finalDeductAmount), 0), total)
  return new Prisma.Decimal(lossQty)
    .mul(deduct.div(total))
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
}
