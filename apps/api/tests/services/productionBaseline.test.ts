import { describe, expect, it } from 'vitest'
import { planBaselineResolution } from '../../src/services/autofix/productionBaseline'

const BASE = 'a'.repeat(40)
const DEPLOYED = 'b'.repeat(40)

describe('planBaselineResolution', () => {
  it('基线相同直接放行', () => {
    expect(planBaselineResolution({ base: BASE, deployed: BASE, isAncestor: true, appliesClean: true })).toBe('same')
  })

  it('基线前移且补丁可干净应用 → 自动重基线', () => {
    expect(planBaselineResolution({ base: BASE, deployed: DEPLOYED, isAncestor: true, appliesClean: true })).toBe('rebase')
  })

  it('基线前移但补丁冲突 → 拒绝需重新开发', () => {
    expect(planBaselineResolution({ base: BASE, deployed: DEPLOYED, isAncestor: true, appliesClean: false })).toBe('reject_conflict')
  })

  it('基线分叉或回退 → 拒绝需重新开发（不看补丁能否应用）', () => {
    expect(planBaselineResolution({ base: BASE, deployed: DEPLOYED, isAncestor: false, appliesClean: true })).toBe('reject_diverged')
    expect(planBaselineResolution({ base: BASE, deployed: DEPLOYED, isAncestor: false, appliesClean: false })).toBe('reject_diverged')
  })
})
