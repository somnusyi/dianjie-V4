import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const evidencePage = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
const storePage = readFileSync(new URL('../../../../delivery-evidence/[id]/page.tsx', import.meta.url), 'utf8')
const procurementPage = readFileSync(new URL('../../../procurement/page.tsx', import.meta.url), 'utf8')

describe('来货资料页面合同', () => {
  it('展示会议明示的产品资料类型，不把所有资料误称检疫证明', () => {
    for (const label of ['检验检测报告', '屠宰证', '生产检验报告', '第三方检测报告', '蔬菜农残报告']) {
      expect(evidencePage).toContain(label)
      expect(storePage).toContain(label)
    }
  })

  it('明确商品规则是全局规则且需要二次确认', () => {
    expect(evidencePage).toContain('适用于该商品的所有上游供应商')
    expect(evidencePage).toContain('window.confirm')
    expect(evidencePage).toContain('expectedVersion')
    expect(evidencePage).toContain('expectedRequiredTypes')
    expect(evidencePage).toContain('所需资料类型（可多选）')
    expect(evidencePage).toContain('尚缺：')
  })

  it('新增证明和到货关联草稿都会阻止误点站内导航', () => {
    expect(evidencePage).toContain('SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT')
    expect(evidencePage).toContain('Object.values(selectedLinks).some')
    expect(evidencePage).toContain('backfillReason.trim()')
    expect(evidencePage).toContain('saving || !window.confirm')
  })

  it('缺件只提示不阻断，验收页可直达补齐', () => {
    expect(evidencePage).toContain('仅提示，不阻断收货')
    expect(procurementPage).toContain('只提示，不阻断验收或入库')
    expect(procurementPage).toContain('查看/补齐本次资料')
  })

  it('区分原始随货资料和事后补录，门店只显示真实追溯商品', () => {
    expect(evidencePage).toContain('事后补录原因')
    expect(evidencePage).toContain('作废错误补录')
    expect(storePage).toContain('本次配送实际追溯商品')
    expect(storePage).toContain('供应商级证照')
  })

  it('不把状态操作人冒充分拣工或司机', () => {
    expect(storePage).toContain('发货状态操作人')
    expect(storePage).toContain('送达状态操作人')
    expect(storePage).toContain('不冒充实际分拣工或司机')
  })
})
