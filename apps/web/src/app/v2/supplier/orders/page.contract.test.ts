import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SUPPLIER_DIFFERENCES_PATH, supplierOrdersLegacyDifferenceRedirect } from './legacy-difference-redirect'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
const detailSource = readFileSync(new URL('./[id]/page.tsx', import.meta.url), 'utf8')
const differencesSource = readFileSync(new URL('../differences/page.tsx', import.meta.url), 'utf8')

describe('供应商订单与到货差异边界', () => {
  it('将旧报损筛选链接导向独立到货差异页', () => {
    expect(supplierOrdersLegacyDifferenceRedirect('?filter=%E6%8A%A5%E6%8D%9F')).toBe('/v2/supplier/differences')
    expect(supplierOrdersLegacyDifferenceRedirect('?filter=%E5%88%B0%E8%B4%A7%E5%B7%AE%E5%BC%82')).toBe('/v2/supplier/differences')
    expect(supplierOrdersLegacyDifferenceRedirect('?filter=%E5%BE%85%E5%8F%91%E8%B4%A7')).toBeNull()
    expect(SUPPLIER_DIFFERENCES_PATH).toBe('/v2/supplier/differences')
    expect(source).toContain("internalSupplyChain ? '/v2/supply-chain/receipts' : legacyDifferenceRedirect")
  })

  it('订单页只保留差异提醒与导航，不再内嵌处理工作台', () => {
    expect(source).not.toContain('到货差异工作台')
    expect(source).not.toContain("filter === '到货差异'")
    expect(source).not.toContain('handleClaim(')
    expect(source).not.toContain('/handle`')
    expect(source).toContain("internalSupplyChain ? '/v2/supply-chain/receipts' : SUPPLIER_DIFFERENCES_PATH")
    expect(differencesSource).toContain('function SupplierDifferencesPage')
    expect(differencesSource).toContain('数量短缺、破损与品质争议的独立处理工作台')
  })

  it('不改动订单详情中的差异区', () => {
    expect(detailSource).toContain('到货差异 — 显示履约链、完整明细、证据与处理按钮')
    expect(detailSource).toContain('查看并打印差异单')
  })
})
