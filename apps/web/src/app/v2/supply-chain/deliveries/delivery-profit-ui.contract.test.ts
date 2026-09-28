import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const list = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
const detail = readFileSync(new URL('./[id]/page.tsx', import.meta.url), 'utf8')

describe('delivery cost and profit UI contract', () => {
  it('exposes one clear detail action and explains missing frozen cost', () => {
    expect(list).toContain('/v2/supply-chain/deliveries/${delivery.id}')
    expect(list).toContain('查看明细')
    expect(list).toContain('成本金额')
    expect(list).toContain('利润')
    expect(list).toContain('进入明细查看缺成本或勾稽告警')
  })

  it('keeps original shipment and net settlement labels distinct and consistent', () => {
    expect(detail).toContain('原发货金额')
    expect(detail).toContain('净结算金额')
    expect(detail).not.toContain('净发货金额')
    expect(detail).toContain('接单数量')
    expect(detail).toContain('发货单价')
    expect(detail).toContain('成本单价')
  })

  it('provides desktop detail rows, mobile cards, export and next-step links', () => {
    expect(detail).toContain('hidden overflow-x-auto')
    expect(detail).toContain('md:hidden')
    expect(detail).toContain('/export.xlsx')
    expect(detail).toContain('查看订货与配送流程')
    expect(detail).toContain('前往集团毛利明细表核对')
  })
})
