/**
 * 阿拉伯数字 → 中文大写金额 (财务规范)
 *
 * 关键实现约束: 先 toFixed(2) 定点化成字符串再逐位取数, 避开二进制浮点误差。
 * (旧实现 Math.floor(1.19 * 100) % 10 得 8, 会把 1.19 写成「壹角捌分」)
 */
export function num2cn(n: number): string {
  if (!Number.isFinite(n)) return '零元整'
  if (n === 0) return '零元整'
  const fraction = ['角', '分']
  const digit = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
  const unit = [['元', '万', '亿'], ['', '拾', '佰', '仟']]
  const head = n < 0 ? '负' : ''
  const fixed = Math.abs(n).toFixed(2)
  const fracStr = fixed.slice(-2)
  let s = ''
  for (let i = 0; i < fraction.length; i++) {
    s += (digit[+fracStr[i]] + fraction[i]).replace(/零./, '')
  }
  s = s || '整'
  let intPart = fixed.slice(0, -3)
  for (let i = 0; i < unit[0].length && intPart.length > 0; i++) {
    let p = ''
    for (let j = 0; j < unit[1].length && intPart.length > 0; j++) {
      p = digit[+intPart.slice(-1)] + unit[1][j] + p
      intPart = intPart.slice(0, -1)
    }
    s = p.replace(/(零.)*零$/, '').replace(/^$/, '零') + unit[0][i] + s
  }
  // 开头多余的「元」只在整数位为 0 时出现 (如 0.19 → 「元壹角玖分」), 剥掉
  const body = s.replace(/(零.)*零元/, '元').replace(/(零.)+/g, '零').replace(/^整$/, '零元整').replace(/^元/, '')
  return head + body
}
