import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const bossHome = source('./boss/home/page.tsx')
const mePage = source('./me/page.tsx')
const supplierOrders = source('./supplier/orders/page.tsx')
const transfers = source('./supply-chain/transfers/page.tsx')
const chefPurchase = source('./chef/purchase/page.tsx')
const chefInventory = source('./chef/inventory/page.tsx')
const supplyHome = source('./supply-chain/home/page.tsx')
const supplyOrders = source('./supply-chain/orders/page.tsx')
const orderProjection = source('../../lib/supply-order-delivery-pc.ts')

describe('2026-09-28 操作体验速修', () => {
  it('does not render unauthorized profit and budget shortcuts for BOSS', () => {
    expect(bossHome).toContain("data.user?.role !== 'BOSS'")
    expect(bossHome).toContain('href="/v2/profit"')
    expect(bossHome).toContain('href="/v2/budget"')
    const profitHref = mePage.indexOf('href="/v2/profit"')
    const profitGuard = mePage.slice(mePage.lastIndexOf('{(', profitHref), profitHref)
    expect(profitGuard).toContain("u.role === 'ADMIN'")
    expect(profitGuard).not.toContain("u.role === 'BOSS'")
  })

  it('keeps cancelled supplier orders out of completed and gives them a separate tab', () => {
    expect(supplierOrders).toContain("if (f === '已完成') return ['RECEIVED', 'COMPLETED'].includes(s)")
    expect(supplierOrders).toContain("if (f === '已取消') return s === 'CANCELLED'")
    expect(supplierOrders).toContain("'已完成', '已取消'")
    expect(supplierOrders).toContain("if (orderFilter === '已取消') params.set('status', 'CANCELLED')")
    expect(supplierOrders).toContain('void load(appliedSearch, f)')
  })

  it('requires ConfirmSheet before transfer shipment, receipt, or revocation', () => {
    expect(transfers).toContain("import { ConfirmSheet, useConfirmSheet }")
    expect(transfers).toContain("requestStatusChange(row, 'SHIPPED')")
    expect(transfers).toContain("requestStatusChange(row, 'RECEIVED')")
    expect(transfers).toContain("requestStatusChange(row, 'REVOKED')")
    expect(transfers).toContain('<ConfirmSheet {...confirmState} />')
  })

  it('removes decorative controls that had no click behavior', () => {
    expect(chefPurchase).not.toContain('>⌧</button>')
    expect(chefInventory).not.toContain('>⌕</button>')
    expect(chefInventory).not.toContain('>⋮</button>')
    expect(supplyHome).not.toContain('aria-label="搜索">⌕</button>')
  })

  it('keeps only one arrival-date column in the order query', () => {
    expect(supplyOrders).toContain("header: '期望到货日'")
    expect(supplyOrders).not.toContain("header: '预计到货日'")
    expect(orderProjection).not.toContain('estimatedArrivalAt:')
  })
})
