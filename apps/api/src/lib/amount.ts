/**
 * 金额计算工具 (RMB, 2 位小数)
 *
 * Prisma `Decimal(12,2)` 返回 `Decimal` 对象, JS 里直接 `Number(a) + Number(b)` 会
 * 在累加多笔时出现浮点尾差 (例: 0.1 + 0.2 = 0.30000000000000004).
 * 月结对账 / 多店分账 累 50 笔以上就可能看到 ¥0.01 偏差.
 *
 * 用法:
 *   toCents(12.34)           === 1234
 *   toYuan(1234)             === 12.34
 *   sumYuan([0.1, 0.2, 0.3]) === 0.6        // 不是 0.6000000000000001
 *   equalYuan(0.1 + 0.2, 0.3) === true
 *
 * Prisma Decimal / string / number 都接收, null/undefined 当作 0
 */

type Num = number | string | { toNumber(): number } | null | undefined

function toNumber(v: Num): number {
  if (v == null) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'string') return Number(v) || 0
  if (typeof (v as any).toNumber === 'function') return (v as any).toNumber()
  return Number(v) || 0
}

/** 元 → 分 (rounding to nearest cent). 用 + 0.5 而不是 Math.round 处理负数边界 */
export function toCents(yuan: Num): number {
  const n = toNumber(yuan)
  return Math.round(n * 100)
}

/** 分 → 元 */
export function toYuan(cents: number): number {
  return Math.round(cents) / 100
}

/** 累加多笔金额, 内部以 cent 累加, 最后转回 yuan, 避免浮点尾差 */
export function sumYuan(values: Num[]): number {
  let cents = 0
  for (const v of values) cents += toCents(v)
  return toYuan(cents)
}

/** 相减 (a - b), 保留 2 位精度 */
export function subYuan(a: Num, b: Num): number {
  return toYuan(toCents(a) - toCents(b))
}

/** 相等比较 (容差 0.01) */
export function equalYuan(a: Num, b: Num): boolean {
  return toCents(a) === toCents(b)
}

/** a ≥ b (容差 0.005, 用于"金额不超过剩余可付"类校验) */
export function gteYuan(a: Num, b: Num): boolean {
  return toCents(a) >= toCents(b)
}

/** 强制 2 位小数, 用于返给前端显示 */
export function fixYuan(v: Num): number {
  return toYuan(toCents(v))
}
