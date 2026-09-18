import { describe, expect, it } from 'vitest'
import { num2cn } from './num2cn'

describe('num2cn 中文大写金额', () => {
  it('浮点边界: 1.19 的分位必须是玖而不是捌', () => {
    // 回归: 旧实现 Math.floor(1.19 * 100) % 10 = 8 → 「壹角捌分」
    expect(num2cn(1.19)).toBe('壹元壹角玖分')
  })

  it('纯小数不带多余「元」字', () => {
    expect(num2cn(0.19)).toBe('壹角玖分')
    expect(num2cn(0.01)).toBe('壹分')
    expect(num2cn(0.1)).toBe('壹角')
  })

  it('整元', () => {
    expect(num2cn(0)).toBe('零元整')
    expect(num2cn(100)).toBe('壹佰元整')
    expect(num2cn(19370)).toBe('壹万玖仟叁佰柒拾元整')
    expect(num2cn(1000000)).toBe('壹佰万元整')
  })

  it('混合金额', () => {
    expect(num2cn(13780.5)).toBe('壹万叁仟柒佰捌拾元伍角')
    expect(num2cn(123456.78)).toBe('壹拾贰万叁仟肆佰伍拾陆元柒角捌分')
  })

  it('负数', () => {
    expect(num2cn(-2.5)).toBe('负贰元伍角')
    expect(num2cn(-0.19)).toBe('负壹角玖分')
  })

  it('非法输入按零处理', () => {
    expect(num2cn(NaN)).toBe('零元整')
    expect(num2cn(Infinity)).toBe('零元整')
  })
})
