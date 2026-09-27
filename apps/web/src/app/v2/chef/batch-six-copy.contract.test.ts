import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

describe('批次6 厨师长与总厨文案', () => {
  it('统一把厨师长底栏入口命名为报损', () => {
    for (const page of ['./home/page.tsx', './inventory/page.tsx', './purchase/page.tsx', './check/page.tsx']) {
      const code = source(page)
      expect(code, page).toContain("{ key: 'check', label: '报损', icon: '◐' }")
      expect(code, page).not.toContain("{ key: 'check', label: '盘点', icon: '◐' }")
    }
  })

  it('在库存页明确标出实物盘点入口并区分日常报损', () => {
    const inventory = source('./inventory/page.tsx')
    expect(inventory).toContain('进入门店月度实物盘点')
    expect(inventory).toContain('日常损耗请从底栏「报损」登记')
  })

  it('争议页不再声称存在500元审核阈值', () => {
    const disputes = source('../chef-director/disputes/page.tsx')
    expect(disputes).toContain('店内报损待审核(通过/驳回)')
    expect(disputes).not.toContain('店内报损 ≥¥500')
  })
})
