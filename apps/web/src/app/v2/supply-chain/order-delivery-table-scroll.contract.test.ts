import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ordersPage = readFileSync(new URL('./orders/page.tsx', import.meta.url), 'utf8')
const deliveriesPage = readFileSync(new URL('./deliveries/page.tsx', import.meta.url), 'utf8')
const horizontalTable = readFileSync(
  new URL('../../../components/v2/order-center-horizontal-table.tsx', import.meta.url),
  'utf8',
)
const resizableTable = readFileSync(
  new URL('../../../components/v2/order-center-resizable-table.tsx', import.meta.url),
  'utf8',
)

function defaultColumnWidths(source: string) {
  return Object.fromEntries(
    [...source.matchAll(/id: '([^']+)',[\s\S]*?defaultWidth: (\d+),/g)]
      .map(match => [match[1], Number(match[2])]),
  )
}

describe('order and delivery table horizontal controls', () => {
  it.each([
    ['orders', ordersPage],
    ['deliveries', deliveriesPage],
  ])('nests the shared %s resizable table inside one persistent horizontal control', (_name, source) => {
    expect(source).toContain("import { OrderCenterHorizontalTable } from '@/components/v2/order-center-horizontal-table'")
    expect(source).toContain("from '@/components/v2/order-center-resizable-table'")
    expect(source.match(/<OrderCenterHorizontalTable>/g)).toHaveLength(1)
    expect(source.match(/<OrderCenterResizableTable/g)).toHaveLength(1)
    expect(source).toContain('className="overflow-clip rounded-card border border-border bg-white"')
    expect(source).not.toContain('className="overflow-hidden rounded-card border border-border bg-white"')
    const open = source.indexOf('<OrderCenterHorizontalTable>')
    const table = source.indexOf('<OrderCenterResizableTable', open)
    const close = source.indexOf('</OrderCenterHorizontalTable>', table)
    expect(open).toBeGreaterThan(-1)
    expect(table).toBeGreaterThan(open)
    expect(close).toBeGreaterThan(table)
    expect(source).not.toContain('onPointerDown=')
  })

  it.each([
    ['orders', ordersPage, 'orderItemSummary'],
    ['deliveries', deliveriesPage, 'deliveryItemSummary'],
  ])('starts the %s product summary at 400px and lets it wrap after resizing', (_name, source, summaryHelper) => {
    expect(source).toContain(`const summary = ${summaryHelper}(`)
    expect(source).toMatch(/id: 'summary',[\s\S]*?header: '商品摘要',[\s\S]*?defaultWidth: 400,/)
    expect(source).toContain('<span title={summary}>{summary}</span>')
    expect(source).not.toContain('truncate')
    expect(resizableTable).toContain('whitespace-normal break-words')
    expect(resizableTable).toContain('leading-5')
  })

  it('uses one conventional horizontal scrollbar without a separate slider or progress text', () => {
    expect(horizontalTable).not.toContain('type="range"')
    expect(horizontalTable).not.toContain('左右拖动查看完整表格')
    expect(horizontalTable).not.toContain('完整显示')
    expect(horizontalTable).toContain('role="scrollbar"')
    expect(horizontalTable).toContain('data-scrollbar-thumb')
    expect(horizontalTable).toContain('[scrollbar-width:none]')
    expect(horizontalTable).toContain('[&::-webkit-scrollbar]:hidden')
  })

  it('uses the measured current layout as each column maximum', () => {
    expect(defaultColumnWidths(ordersPage)).toEqual({
      sequence: 58,
      orderNo: 238,
      store: 136,
      supplier: 214,
      createdAt: 110,
      expectedDeliveryDate: 97,
      status: 77,
      summary: 400,
      amount: 104,
      action: 103,
    })
    expect(defaultColumnWidths(deliveriesPage)).toEqual({
      sequence: 58,
      deliveryNo: 170,
      orderNo: 237,
      store: 136,
      supplier: 214,
      createdAt: 110,
      shippedAt: 110,
      status: 77,
      summary: 400,
      amount: 102,
      action: 103,
    })
  })

  it('keeps a standard delivery number on one line by default and lets it wrap after narrowing', () => {
    expect(deliveriesPage).toMatch(
      /id: 'deliveryNo',\s+header: '配送单号',\s+defaultWidth: 170,\s+cellClassName: 'font-num',\s+renderCell: delivery => <b>\{delivery\.no\}<\/b>,/,
    )
    expect(resizableTable).toContain('whitespace-normal break-words')
  })

  it('keeps the expected-arrival header horizontal and removes dots from row numbers', () => {
    expect(ordersPage).toContain("header: '期望到货日'")
    expect(resizableTable).toContain('whitespace-nowrap px-4 py-3')
    for (const source of [ordersPage, deliveriesPage]) {
      expect(source).toMatch(/header: '序号',[\s\S]*?renderCell: \([^)]*index\) => index \+ 1,/)
      expect(source).not.toMatch(/renderCell: \([^)]*index\) => `?\$?\{?index \+ 1\}?\./)
    }
  })

  it('owns all resize state and pointer behavior in the shared component boundary', () => {
    expect(resizableTable).toContain('role="separator"')
    expect(resizableTable).toContain('onPointerDown={event => beginDragging(event, column.id)}')
    expect(resizableTable).toContain('column.defaultWidth')
    expect(resizableTable).toContain('orderCenterHeaderMinimumWidth(column.header)')
  })
})
