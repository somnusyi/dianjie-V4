import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const orderDetailSource = readFileSync(
  new URL('../app/v2/chef/purchase/po-success/[id]/page.tsx', import.meta.url),
  'utf8',
)
const chefHomeSource = readFileSync(
  new URL('../app/v2/chef/home/page.tsx', import.meta.url),
  'utf8',
)
const chefInventorySource = readFileSync(
  new URL('../app/v2/chef/inventory/page.tsx', import.meta.url),
  'utf8',
)
const revisionReviewSource = orderDetailSource.slice(
  orderDetailSource.indexOf('function openRevisionReview'),
  orderDetailSource.indexOf('  return ('),
)

describe('厨师长改单确认与临期待办合同', () => {
  it('使用页面内二次确认，不依赖移动端 WebView 不稳定的原生对话框', () => {
    expect(orderDetailSource).toContain("setReviewAction(action)")
    expect(orderDetailSource).toContain('submitRevisionReview')
    expect(orderDetailSource).toContain('确定确认')
    expect(revisionReviewSource).not.toContain('window.prompt(')
    expect(revisionReviewSource).not.toMatch(/\bconfirm\(/)
  })

  it('厨师长工作台和库存页暂不展示临期提醒或临期报损入口', () => {
    expect(chefHomeSource).not.toContain('优先用于今晚特价 / 报损')
    expect(chefHomeSource).not.toContain("key={`exp-")
    expect(chefInventorySource).not.toContain('label: \'临期预警\'')
    expect(chefInventorySource).not.toContain('<Section title="临期预警"')
  })
})
