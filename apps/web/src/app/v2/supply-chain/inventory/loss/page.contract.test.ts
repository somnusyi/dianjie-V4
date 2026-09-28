import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

describe('总仓自损页面契约', () => {
  it('要求原因、责任、证据和按库存单位扣减', () => {
    expect(source).toContain('自损原因 *')
    expect(source).toContain('责任归属 *')
    expect(source).toContain('现场证据 *')
    expect(source).toContain('inventoryQuantity: Number(line.quantity)')
    expect(source).toContain('/api/warehouse-inventory/batch-self-loss')
    const requestBody = source.slice(source.indexOf('body: JSON.stringify({'), source.indexOf('}),\n      })', source.indexOf('body: JSON.stringify({')))
    expect(requestBody).not.toContain('totalAmount:')
  })

  it('确认危险动作并提供查询导出闭环', () => {
    expect(source).toContain('确认提交总仓自损？')
    expect(source).toContain('SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT')
    expect(source).toContain("window.addEventListener('beforeunload'")
    expect(source).toContain('不能直接改写历史')
    expect(source).toContain('/v2/supply-chain/inventory-management/other-out')
    expect(source).toContain('导出其他出库单')
    expect(source).toContain('/v2/supply-chain/docs?doc=')
    expect(source).toContain('查看单据明细与现场证据')
  })
})
