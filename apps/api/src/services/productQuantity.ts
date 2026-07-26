import { Prisma } from '@dianjie/db'
import { z } from 'zod'

export const PRODUCT_QUANTITY_MAX = '999999999.999'
const productQuantityMax = new Prisma.Decimal(PRODUCT_QUANTITY_MAX)

function hasValidScale(value: number): boolean {
  return Number.isFinite(value) && new Prisma.Decimal(value).decimalPlaces() <= 3
}

function isWithinMaximum(value: number): boolean {
  return Number.isFinite(value) && new Prisma.Decimal(value).lte(productQuantityMax)
}

function productQuantityNumber(label: string, positive: boolean) {
  const numberSchema = z.number({ invalid_type_error: `${label}必须是数字` })
    .finite(`${label}必须是有限数字`)
  const signedSchema = positive
    ? numberSchema.positive(`${label}必须大于 0`)
    : numberSchema.nonnegative(`${label}不能为负`)

  return signedSchema
    .refine(hasValidScale, `${label}最多支持 3 位小数`)
    .refine(isWithinMaximum, `${label}超过商品数量上限`)
}

function withCreateDefault(schema: ReturnType<typeof productQuantityNumber>, defaultValue: number, zeroAsDefault = false) {
  return z.preprocess(
    value => value === null || value === '' || (zeroAsDefault && value === 0) ? undefined : value,
    schema.optional().default(defaultValue),
  )
}

const nonnegativeProductQuantity = productQuantityNumber('库存数量', false)
const minOrderQuantity = productQuantityNumber('起订量', true)
const stepQuantity = productQuantityNumber('步长', true)

export const productStockCreateSchema = withCreateDefault(nonnegativeProductQuantity, 0)
export const productMinStockCreateSchema = withCreateDefault(nonnegativeProductQuantity, 0)
export const productMinOrderQuantityCreateSchema = withCreateDefault(minOrderQuantity, 1)
export const productStepQuantityCreateSchema = withCreateDefault(stepQuantity, 1, true)

export const productMinOrderQuantityPatchSchema = minOrderQuantity.optional()
export const productStepQuantityPatchSchema = stepQuantity.optional()
