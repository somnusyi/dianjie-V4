// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StocktakeReviewPrintPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)
const count = {
  no: 'PD20260924001', countDate: '2026-09-24', status: 'REVIEWING', totalDifferenceValue: -38,
  store: { name: '复盘门店' },
  items: [
    { id: 'difference', productCodeSnapshot: 'A-01', productNameSnapshot: '有差异商品', productSpecSnapshot: '500g', unitSnapshot: '袋', bookQuantity: 10, countedQuantity: 8, differenceQuantity: -2, differenceAmount: -20, reasonCode: 'WEIGHING', reasonNote: '秤已复核', evidenceKeys: ['key-1', 'key-2'], evidenceUrls: [] },
    { id: 'zero', productCodeSnapshot: 'B-02', productNameSnapshot: '零差异商品', productSpecSnapshot: null, unitSnapshot: '件', bookQuantity: 5, countedQuantity: 5, differenceQuantity: 0, differenceAmount: 0, reasonCode: null, reasonNote: null, evidenceKeys: [], evidenceUrls: [] },
    { id: 'uncounted', productCodeSnapshot: 'C-03', productNameSnapshot: '未盘商品', productSpecSnapshot: null, unitSnapshot: '箱', bookQuantity: 3, countedQuantity: null, differenceQuantity: null, differenceAmount: null, reasonCode: null, reasonNote: null, evidenceKeys: null, evidenceUrls: ['signed-url'] },
  ],
}

function renderPage(id = 'count-1') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<StocktakeReviewPrintPage params={{ id }} />))
  return { container, root }
}

async function waitFor(predicate: () => boolean, timeout = 1000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

function clickByText(container: Element, text: string) {
  const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent === text)
  expect(button).toBeTruthy()
  act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function changeInput(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function setPendingFonts(ready: Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(document, 'fonts')
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } })
  return () => {
    if (original) Object.defineProperty(document, 'fonts', original)
    else Reflect.deleteProperty(document, 'fonts')
  }
}

describe('stocktake review print page', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(count)
    vi.stubGlobal('print', vi.fn())
  })

  afterEach(() => {
    document.querySelectorAll('[data-stocktake-print]').forEach(node => node.remove())
    document.querySelectorAll('[data-stocktake-print-measure]').forEach(node => node.remove())
    document.querySelectorAll('[data-stocktake-fragment-measure]').forEach(node => node.remove())
    document.querySelectorAll('body > div').forEach(node => node.remove())
    vi.unstubAllGlobals()
  })

  it('reads only, defaults to counted differences, and renders isolated print paper', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('有差异商品') ?? false)

    expect(mockFetch).toHaveBeenCalledWith('/api/inventory-counts/count-1')
    expect(container.textContent).not.toContain('零差异商品')
    expect(container.textContent).not.toContain('未盘商品')
    expect(container.textContent).toContain('待审核')
    expect(container.textContent).toContain('称重/计量差异')
    expect(container.textContent).toContain('2 张')
    expect(container.textContent).toContain('整单差异金额：¥-38.00（非当前筛选合计）')
    expect(container.querySelector('a[href="/v2/supply-chain/stocktake/count"]')?.textContent).toBe('返回盘点管理')

    const paper = document.body.querySelector('[data-stocktake-print]')
    expect(paper?.textContent).toContain('打印范围：仅已盘且有差异（1 项）')
    expect(paper?.textContent).toContain('有差异商品')
    expect(paper?.textContent).not.toContain('零差异商品')
    expect(paper?.querySelector('button')).toBeNull()
    expect(Array.from(paper?.querySelectorAll('col') || []).map(column => (column as HTMLTableColElement).style.width)).toEqual(['10%', '18%', '5%', '7%', '7%', '8%', '10%', '29%', '6%'])

    clickByText(container, '打印复盘单')
    await waitFor(() => vi.mocked(window.print).mock.calls.length === 1)
    act(() => root.unmount())
    container.remove()
    expect(document.body.querySelector('[data-stocktake-print]')).toBeNull()
  })

  it('can show all rows and preserves null quantities as uncounted', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('有差异商品') ?? false)
    clickByText(container, '全部明细')

    expect(container.textContent).toContain('零差异商品')
    expect(container.textContent).toContain('未盘商品')
    expect(container.textContent).toContain('未盘')
    expect(container.textContent).toContain('1 张')
    expect(document.body.querySelector('[data-stocktake-print]')?.textContent).toContain('打印范围：全部明细（3 项）')

    act(() => root.unmount())
    container.remove()
  })

  it('uses the established confirmed label and gives zero-difference counts an explicit empty state', async () => {
    mockFetch.mockResolvedValueOnce({ ...count, status: 'CONFIRMED', items: [count.items[1], count.items[2]] })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('已审核') ?? false)

    expect(container.textContent).toContain('没有已盘且有差异的明细')
    const paper = document.body.querySelector('[data-stocktake-print]')
    const finalPage = paper?.querySelector('.stocktake-print-page:last-child')
    expect(paper?.querySelectorAll('.stocktake-print-page')).toHaveLength(1)
    expect(finalPage?.querySelector('[data-stocktake-print-empty]')?.textContent).toBe('没有已盘且有差异的明细')
    expect(paper?.querySelector(':scope > [data-stocktake-print-empty]')).toBeNull()

    act(() => root.unmount())
    container.remove()
  })

  it('keeps the paper rows and scope synchronized after search', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('有差异商品') ?? false)
    clickByText(container, '全部明细')
    const search = container.querySelector('input[aria-label="搜索盘点商品"]') as HTMLInputElement
    changeInput(search, '零差异')

    expect(container.textContent).toContain('零差异商品')
    expect(container.textContent).not.toContain('有差异商品')
    const paper = document.body.querySelector('[data-stocktake-print]')
    expect(paper?.textContent).toContain('打印范围：全部明细；搜索“零差异”（1 项）')
    expect(paper?.textContent).toContain('零差异商品')
    expect(paper?.textContent).not.toContain('有差异商品')

    act(() => root.unmount())
    container.remove()
  })

  it('recovers from a failed request after the route id changes', async () => {
    mockFetch.mockRejectedValueOnce(new Error('首次加载失败'))
    mockFetch.mockResolvedValueOnce({ ...count, no: 'RECOVERED-COUNT' })
    const { container, root } = renderPage('broken')
    await waitFor(() => container.textContent?.includes('首次加载失败') ?? false)
    act(() => root.render(<StocktakeReviewPrintPage params={{ id: 'recovered' }} />))
    await waitFor(() => container.textContent?.includes('RECOVERED-COUNT') ?? false)

    expect(container.textContent).not.toContain('首次加载失败')
    expect(mockFetch.mock.calls.map(([path]) => path)).toEqual(['/api/inventory-counts/broken', '/api/inventory-counts/recovered'])

    act(() => root.unmount())
    container.remove()
  })

  it('keeps navigation out of print CSS while retaining repeated table headers and mobile bottom clearance', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('有差异商品') ?? false)
    const printCss = container.querySelector('style')?.textContent || ''

    expect(container.querySelector('main')?.className).toContain('pb-24')
    expect(container.querySelector('main')?.className).toContain('lg:pb-4')
    expect(printCss).toContain('body > *:not([data-stocktake-print]) { display:none !important }')
    expect(printCss).toContain('@page { size:A4 landscape; margin:10mm }')
    expect(printCss).toContain('font-size:10pt')
    expect(printCss).toContain('font-size:9pt')
    expect(printCss).toContain('.stocktake-print-document-header { margin:0 0 16px }')
    expect(printCss).toContain('[data-stocktake-print] thead { display:table-header-group !important }')
    expect(printCss).toContain('break-inside:avoid !important')
    expect(printCss).toContain('.stocktake-print-page { break-after:page; page-break-after:always }')

    act(() => root.unmount())
    container.remove()
  })

  it('keeps off-paper measurement portals layoutable after print media hides the application shell', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('有差异商品') ?? false)
    const printCss = container.querySelector('style')?.textContent || ''
    const hideShell = printCss.indexOf('body > *:not([data-stocktake-print]) { display:none !important }')
    const restoreMeasurement = printCss.indexOf('body > [data-stocktake-print-measure], body > [data-stocktake-fragment-measure] { display:block !important; position:fixed !important; visibility:hidden !important; left:-100000px !important; top:0 !important; width:277mm !important; padding:0 !important; pointer-events:none !important }')

    expect(hideShell).toBeGreaterThan(-1)
    expect(restoreMeasurement).toBeGreaterThan(hideShell)
    expect(printCss).toContain('@media print')
    act(() => root.unmount())
    container.remove()
  })

  it('does not let a previous count request overwrite a newer route', async () => {
    let resolveOld!: (value: typeof count) => void
    let resolveNew!: (value: typeof count) => void
    mockFetch.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    mockFetch.mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve }))
    const { container, root } = renderPage('old')
    act(() => root.render(<StocktakeReviewPrintPage params={{ id: 'new' }} />))

    await act(async () => { resolveNew({ ...count, no: 'NEW-COUNT' }) })
    await waitFor(() => container.textContent?.includes('NEW-COUNT') ?? false)
    await act(async () => { resolveOld({ ...count, no: 'OLD-COUNT' }) })
    expect(container.textContent).toContain('NEW-COUNT')
    expect(container.textContent).not.toContain('OLD-COUNT')

    act(() => root.unmount())
    container.remove()
  })

  it('packs non-uniform measured rows at the exact page boundary before opening the print dialog', async () => {
    const rect = (height: number, top = 0) => ({ x: 0, y: top, width: 1046, height, top, right: 1046, bottom: top + height, left: 0, toJSON: () => ({}) })
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (!this.closest('[data-stocktake-print-measure]')) return rect(0) as DOMRect
      if (this.matches('.stocktake-print-page')) return rect(0) as DOMRect
      // The first row starts after the 40px document header, its explicit 16px
      // margin, and the 20px table header. The first two non-uniform rows fill
      // the Safari-safe remaining 534px exactly; the third starts a new page.
      if (this.matches('tbody tr')) {
        const rows = Array.from(this.parentElement?.querySelectorAll('tr') || [])
        return rect([260, 274, 80][rows.indexOf(this as HTMLTableRowElement)], 76) as DOMRect
      }
      return rect(0) as DOMRect
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('有差异商品') ?? false)
    clickByText(container, '全部明细')
    clickByText(container, '打印复盘单')
    await waitFor(() => vi.mocked(window.print).mock.calls.length === 1)

    const paper = document.body.querySelector('[data-stocktake-print]')
    expect(paper?.querySelectorAll('.stocktake-print-page')).toHaveLength(2)
    expect(paper?.querySelectorAll('[data-stocktake-print-header]')).toHaveLength(2)
    expect(Array.from(paper?.querySelectorAll('[data-stocktake-print-header]') || []).filter(header => header.textContent?.includes('整单差异金额'))).toHaveLength(1)
    expect(Array.from(paper?.querySelectorAll('tbody tr') || []).map(row => row.firstElementChild?.textContent)).toEqual(['A-01', 'B-02', 'C-03'])
    expect(rectSpy).toHaveBeenCalled()
    rectSpy.mockRestore()
    act(() => root.unmount())
    container.remove()
  })

  it('prepares pages for the first native Cmd+P and never retains prepared rows after filtering', async () => {
    const rect = (height: number) => ({ x: 0, y: 0, width: 1046, height, top: 0, right: 1046, bottom: height, left: 0, toJSON: () => ({}) })
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (!this.closest('[data-stocktake-print-measure]')) return rect(0) as DOMRect
      if (this.matches('tbody tr')) return rect(400) as DOMRect
      return rect(0) as DOMRect
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('有差异商品') ?? false)
    clickByText(container, '全部明细')

    act(() => window.dispatchEvent(new Event('beforeprint')))
    await waitFor(() => (document.body.querySelector('[data-stocktake-print]')?.querySelectorAll('.stocktake-print-page').length || 0) === 3)
    expect(window.print).not.toHaveBeenCalled()

    const search = container.querySelector('input[aria-label="搜索盘点商品"]') as HTMLInputElement
    changeInput(search, '零差异')
    const paper = document.body.querySelector('[data-stocktake-print]')
    expect(paper?.textContent).toContain('打印范围：全部明细；搜索“零差异”（1 项）')
    expect(paper?.textContent).toContain('零差异商品')
    expect(paper?.textContent).not.toContain('有差异商品')
    expect(paper?.querySelectorAll('.stocktake-print-page')).toHaveLength(1)

    rectSpy.mockRestore()
    act(() => root.unmount())
    container.remove()
  })

  it('splits an oversized row by measured Unicode-safe text fragments without losing text or repeating amounts', async () => {
    const rect = (height: number) => ({ x: 0, y: 0, width: 1046, height, top: 0, right: 1046, bottom: height, left: 0, toJSON: () => ({}) })
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.closest('[data-stocktake-fragment-measure]') && this.matches('tbody tr')) {
        const cells = this.querySelectorAll('td')
        const textLength = (cells[1]?.textContent?.replace('（续）', '') || '').length + (cells[7]?.textContent?.replace('（续）', '') || '').length
        return rect(textLength <= 4 ? 300 : 800) as DOMRect
      }
      if (this.closest('[data-stocktake-print-measure]') && this.matches('tbody tr')) {
        const rows = Array.from(this.parentElement?.querySelectorAll('tr') || [])
        return rect(rows.indexOf(this as HTMLTableRowElement) === 0 ? 1000 : 80) as DOMRect
      }
      return rect(0) as DOMRect
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('有差异商品') ?? false)
    clickByText(container, '全部明细')
    clickByText(container, '打印复盘单')
    await waitFor(() => vi.mocked(window.print).mock.calls.length === 1)

    const paper = document.body.querySelector('[data-stocktake-print]')
    const rows = Array.from(paper?.querySelectorAll('tbody tr') || [])
    const splitRows = rows.filter(row => row.firstElementChild?.textContent?.startsWith('A-01'))
    expect(paper?.querySelectorAll('.stocktake-print-page').length).toBeGreaterThan(1)
    expect(splitRows.length).toBeGreaterThan(1)
    expect(splitRows.map(row => row.children[1]?.textContent?.replace('（续）', '')).join('')).toBe('有差异商品 500g')
    expect(splitRows.map(row => row.children[7]?.textContent?.replace('（续）', '')).join('')).toBe('称重/计量差异 秤已复核')
    expect(splitRows.filter(row => row.textContent?.includes('¥-20.00'))).toHaveLength(1)
    expect(splitRows.filter(row => row.textContent?.includes('2 张'))).toHaveLength(1)
    expect(splitRows.slice(1).every(row => row.firstElementChild?.textContent === 'A-01（续）')).toBe(true)
    expect(Array.from(paper?.querySelectorAll('[data-stocktake-print-header]') || []).filter(header => header.textContent?.includes('整单差异金额'))).toHaveLength(1)
    rectSpy.mockRestore()
    act(() => root.unmount())
    container.remove()
  })

  it('cancels a font-waiting print when the route changes or the page unmounts', async () => {
    let resolveFonts!: () => void
    const restoreFonts = setPendingFonts(new Promise(resolve => { resolveFonts = resolve }))
    const { container, root } = renderPage('old')
    await waitFor(() => container.textContent?.includes('有差异商品') ?? false)
    clickByText(container, '打印复盘单')
    act(() => root.render(<StocktakeReviewPrintPage params={{ id: 'new' }} />))
    await act(async () => { resolveFonts() })
    await waitFor(() => container.textContent?.includes('PD20260924001') ?? false)
    expect(window.print).not.toHaveBeenCalled()

    let resolveSecondFonts!: () => void
    restoreFonts()
    const restoreSecondFonts = setPendingFonts(new Promise(resolve => { resolveSecondFonts = resolve }))
    clickByText(container, '打印复盘单')
    act(() => root.unmount())
    container.remove()
    await act(async () => { resolveSecondFonts() })
    expect(window.print).not.toHaveBeenCalled()
    restoreSecondFonts()
  })
})
