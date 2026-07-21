import { describe, expect, it } from 'vitest'
import { formatQuantity } from './format'

describe('formatQuantity', () => {
  it('进位克重到千克', () => {
    expect(formatQuantity(385302.193, 'g')).toBe('385.3 kg')
    expect(formatQuantity(1200, '克')).toBe('1.2 kg')
    expect(formatQuantity(2500, 'ml')).toBe('2.5 L')
  })

  it('千级数量取整加千分位', () => {
    expect(formatQuantity(8669.541188, '枚')).toBe('8,670 枚')
    expect(formatQuantity(1000, '个')).toBe('1,000 个')
  })

  it('百级保留 1 位小数', () => {
    expect(formatQuantity(168, '盒')).toBe('168 盒')
    expect(formatQuantity(144.5, '箱')).toBe('144.5 箱')
  })

  it('个位数保留 2 位小数并去尾零', () => {
    expect(formatQuantity(2.3188, '盒')).toBe('2.32 盒')
    expect(formatQuantity(3, '枚')).toBe('3 枚')
  })

  it('小剂量保留 4 位小数', () => {
    expect(formatQuantity(0.0125, '箱')).toBe('0.0125 箱')
    expect(formatQuantity(0.5, 'kg')).toBe('0.5 kg')
  })

  it('无单位与非法值', () => {
    expect(formatQuantity(5, null)).toBe('5')
    expect(formatQuantity(NaN, 'g')).toBe('0 g')
  })
})
