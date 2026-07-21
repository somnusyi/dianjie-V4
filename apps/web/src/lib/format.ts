/**
 * 数量+单位的可读化格式化（门店角色看的是「多少料」，不是数据库精度）。
 *
 * 规则：
 * - 克重 ≥1000g 自动进位 kg（385302.193 g → 385.3 kg）；毫升 ≥1000ml 进位 L
 * - ≥1000：千分位整数（8669.541188 枚 → 8,670 枚）
 * - ≥100：最多 1 位小数（168 盒 → 168 盒）
 * - ≥1：最多 2 位小数（2.3188 → 2.32）
 * - <1：最多 4 位小数（0.0125 → 0.0125，小剂量 BOM 行不能四舍五入成 0）
 * 小数末尾的 0 一律去掉。
 */

const HEAVY_UNITS: Record<string, { big: string; factor: number }> = {
  g: { big: 'kg', factor: 1000 },
  克: { big: 'kg', factor: 1000 },
  ml: { big: 'L', factor: 1000 },
  毫升: { big: 'L', factor: 1000 },
}

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

export function formatQuantity(qty: number, unit?: string | null): string {
  if (!Number.isFinite(qty)) return `0 ${unit ?? ''}`.trim()
  let value = qty
  let u = (unit ?? '').trim()
  const heavy = HEAVY_UNITS[u]
  if (heavy && Math.abs(value) >= heavy.factor) {
    value = value / heavy.factor
    u = heavy.big
  }
  const abs = Math.abs(value)
  let text: string
  if (abs >= 1000) {
    text = Math.round(value).toLocaleString('zh-CN')
  } else if (abs >= 100) {
    text = trimZeros(value.toFixed(1))
  } else if (abs >= 1) {
    text = trimZeros(value.toFixed(2))
  } else {
    text = trimZeros(value.toFixed(4))
  }
  return u ? `${text} ${u}` : text
}
