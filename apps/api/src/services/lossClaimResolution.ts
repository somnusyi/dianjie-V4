import { Prisma } from '@dianjie/db'
import { z } from 'zod'

export const lossClaimResolutionSchema = z.object({
  finalDeductAmount: z.number()
    .nonnegative('最终扣减金额不能为负数')
    .max(99_999_999.99, '最终扣减金额超出范围')
    .refine(value => new Prisma.Decimal(value).decimalPlaces() <= 2, '最终扣减金额最多保留 2 位小数'),
  note: z.string().trim().max(500).optional(),
}).strict()
