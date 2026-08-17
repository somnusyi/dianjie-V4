import { describe, expect, it } from 'vitest'
import { effectiveDishStatus } from '../../src/routes/dishes'

/**
 * 日报菜名匹配按营业日过滤候选（2026-08-17 修复）：
 * 新菜"傣味鸡脚"(UPCOMING) 与老菜"傣味舂鸡脚"的别名"傣味鸡脚"撞名时，
 * 营业日当天还没上架的新菜不得参与匹配，否则误报"菜品匹配不唯一"。
 */
describe('effectiveDishStatus 按营业日判定在售状态', () => {
  const dish = (overrides: Partial<{ status: string; from: string | null; to: string | null }>) => ({
    status: overrides.status ?? 'ACTIVE',
    availableFrom: overrides.from ? new Date(`${overrides.from}T00:00:00.000Z`) : null,
    availableTo: overrides.to ? new Date(`${overrides.to}T00:00:00.000Z`) : null,
  })

  it('availableFrom 在营业日之后 → UPCOMING（新菜不得参与当日匹配）', () => {
    expect(effectiveDishStatus(dish({ status: 'UPCOMING', from: '2026-08-18' }), '2026-08-15')).toBe('UPCOMING')
    expect(effectiveDishStatus(dish({ status: 'ACTIVE', from: '2026-08-16' }), '2026-08-15')).toBe('UPCOMING')
  })

  it('当日新上（availableFrom <= 营业日）→ ACTIVE（正常参与匹配）', () => {
    expect(effectiveDishStatus(dish({ status: 'UPCOMING', from: '2026-08-15' }), '2026-08-15')).toBe('ACTIVE')
    expect(effectiveDishStatus(dish({ status: 'UPCOMING', from: '2026-08-14' }), '2026-08-15')).toBe('ACTIVE')
  })

  it('availableTo 到期 → DISABLED（下架菜不得参与当日匹配）', () => {
    expect(effectiveDishStatus(dish({ to: '2026-08-15' }), '2026-08-15')).toBe('DISABLED')
  })

  it('无上下架时间 → 沿用档案状态', () => {
    expect(effectiveDishStatus(dish({ status: 'DISABLED' }), '2026-08-15')).toBe('DISABLED')
    expect(effectiveDishStatus(dish({}), '2026-08-15')).toBe('ACTIVE')
  })

  it('营业日在上下架区间内 → ACTIVE', () => {
    expect(effectiveDishStatus(dish({ from: '2026-08-01', to: '2026-08-31' }), '2026-08-15')).toBe('ACTIVE')
  })
})
