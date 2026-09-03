import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ordersPage = readFileSync(new URL('./orders/page.tsx', import.meta.url), 'utf8')
const deliveriesPage = readFileSync(new URL('./deliveries/page.tsx', import.meta.url), 'utf8')
const horizontalTable = readFileSync(
  new URL('../../../components/v2/order-center-horizontal-table.tsx', import.meta.url),
  'utf8',
)

describe('independent order and delivery table horizontal controls', () => {
  it.each([
    ['orders', ordersPage],
    ['deliveries', deliveriesPage],
  ])('wraps the %s table in the dedicated horizontal table component', (_name, source) => {
    expect(source).toContain("import { OrderCenterHorizontalTable } from '@/components/v2/order-center-horizontal-table'")
    const open = source.indexOf('<OrderCenterHorizontalTable>')
    const table = source.indexOf('<table', open)
    const tableEnd = source.indexOf('</table>', table)
    const close = source.indexOf('</OrderCenterHorizontalTable>', tableEnd)
    expect(open).toBeGreaterThan(-1)
    expect(table).toBeGreaterThan(open)
    expect(tableEnd).toBeGreaterThan(table)
    expect(close).toBeGreaterThan(tableEnd)
  })

  it('places the range after the scroll viewport content with the table-specific accessible label', () => {
    const children = horizontalTable.indexOf('{children}')
    const range = horizontalTable.indexOf('type="range"')
    const label = horizontalTable.indexOf('aria-label="横向拖动查看完整表格"')
    expect(horizontalTable).toContain('overflow-x-auto overscroll-x-contain')
    expect(children).toBeGreaterThan(-1)
    expect(range).toBeGreaterThan(children)
    expect(label).toBeGreaterThan(range)
  })
})
