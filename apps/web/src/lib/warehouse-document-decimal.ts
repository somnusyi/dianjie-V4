/** Compare the values that the numeric API will persist, at its existing
 * quantity (6) / amount (4) decimal precision. Avoid a binary delta tolerance. */
function scaled(value: number | string, places: 4 | 6): bigint | null {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  const match = String(Math.abs(number)).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i)
  if (!match) return null
  const digits = BigInt(match[1] + (match[2] || ''))
  const scale = (match[2] || '').length - Number(match[3] || 0)
  let result: bigint
  if (scale <= places) result = digits * BigInt(10) ** BigInt(places - scale)
  else {
    const divisor = BigInt(10) ** BigInt(scale - places)
    result = (digits + divisor / BigInt(2)) / divisor
  }
  return number < 0 ? -result : result
}
export function warehouseDocumentDecimalChanged(next: number | string, previous: number, places: 4 | 6): boolean {
  const a = scaled(next, places), b = scaled(previous, places)
  return a === null || b === null || a !== b
}
