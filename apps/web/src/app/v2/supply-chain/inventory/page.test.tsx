// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import InternalSupplyChainInventoryPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/v2', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span data-chip="true">{children}</span>,
}))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

const inventory = {
  warehouse: { id: 'warehouse-1', code: 'default', name: '供应链总仓', inventoryMode: 'SHADOW' },
  summary: {
    inventoryMode: 'SHADOW', totalSku: 1, physicalSku: 0, negativeSku: 0,
    totalValue: 0, activeReservations: 0, movementCount: 0, strictActivated: false,
  },
  scope: 'stock',
  scopeCounts: { stockSku: 1, bomMappingSku: 79, unitReviewSku: 3 },
  items: [{
    id: 'product-1', code: 'DJ001', name: '菌菇酱', category: '酱料', spec: '8袋/箱',
    purchaseUnit: '箱', inventoryUnit: '袋', purchaseToInventoryFactor: 8,
    unitConversionStatus: 'VERIFIED', physicalQty: 0, reservedQty: 0, availableQty: 0,
    inventoryValue: 0, averageUnitCost: 0, statusFlag: 'OUT',
  }],
}

// 第二个入库候选：验证勾选面板一次添加多种商品
const secondCandidate = {
  id: 'product-2', code: 'DJ002', name: '午餐肉', category: '肉制品', spec: '340g/罐',
  purchaseUnit: '箱', inventoryUnit: '罐', purchaseToInventoryFactor: 24,
  unitConversionStatus: 'VERIFIED', physicalQty: 0, reservedQty: 0, availableQty: 0,
  inventoryValue: 0, averageUnitCost: 0, statusFlag: 'OUT',
}

function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<InternalSupplyChainInventoryPage />))
  return { container, root }
}

async function waitFor(predicate: () => boolean, timeout = 1000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
      'value',
    )?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

// 供应商选择器是可搜索输入框：focus 展开列表后点选目标供应商
function pickSupplier(container: HTMLElement, name = '井育苗菇') {
  const input = Array.from(container.querySelectorAll('input')).find(
    el => (el as HTMLInputElement).placeholder.includes('搜索供应商'),
  ) as HTMLInputElement | undefined
  expect(input).toBeTruthy()
  act(() => {
    input!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
  const option = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes(name))
  expect(option).toBeTruthy()
  act(() => option?.click())
}

// 勾选面板：勾选指定商品后点「添加选中商品」一次性加入入库单
function checkAndAddCandidates(container: HTMLElement, names: string[]) {
  for (const name of names) {
    const checkbox = container.querySelector(`input[aria-label="选择${name}"]`) as HTMLInputElement | null
    expect(checkbox, `候选勾选框：${name}`).toBeTruthy()
    act(() => checkbox!.click())
  }
  const add = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('添加选中商品'))
  act(() => add?.click())
}

describe('总仓库存页面', () => {
  beforeEach(() => {
    sessionStorage.clear()
    mockFetch.mockReset()
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-inventory?scope=')) return Promise.resolve(inventory)
      if (url === '/api/warehouse-inventory/inbound-candidates?limit=500') return Promise.resolve({ items: [...inventory.items, secondCandidate] })
      if (url.startsWith('/api/warehouse-inventory/movements')) return Promise.resolve([])
      if (url === '/api/warehouse-inventory/audit') return Promise.resolve({
        readyForStrict: false,
        blockerCount: 1,
        warningCount: 0,
        checkedSku: 1,
        issues: [{ code: 'LOT_BALANCE_MISMATCH', productId: 'product-1', message: '批次剩余数量与物理余额不一致' }],
      })
      if (url === '/api/suppliers?businessScope=WAREHOUSE_UPSTREAM') {
        return Promise.resolve([{ id: 'sup-1', no: 'SUP001', name: '井育苗菇' }])
      }
      if (url === '/api/warehouse-inventory/manual-inbound' && init?.method === 'POST') {
        return Promise.resolve({ replayed: false, gateWarnings: [] })
      }
      if (url === '/api/warehouse-inventory/batch-manual-inbound' && init?.method === 'POST') {
        return Promise.resolve({ replayed: false, count: 1, totalAmount: 160, gateWarnings: [] })
      }
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
  })

  it('shows one total-warehouse ledger without a supplier selector', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('菌菇酱') ?? false)

    expect(container.textContent).toContain('影子账观察期')
    expect(container.textContent).toContain('总仓维度 · 不按供应商拆库存')
    expect(container.textContent).toContain('1 箱 = 8 袋')
    expect(container.textContent).toContain('采购规格')
    expect(container.textContent).toContain('库存单位')
    expect(container.textContent).toContain('待采购映射 79')
    expect(container.textContent).not.toContain('采购→库存单位')
    expect(container.textContent).toContain('库存四账审计：1 项待处理')
    expect(container.textContent).not.toContain('选择供应商')

    act(() => root.unmount())
    container.remove()
  })

  it('previews purchase-unit conversion and posts a valued manual inbound', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('菌菇酱') ?? false)
    const open = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '单条入库')
    act(() => open?.click())

    const productSelect = container.querySelector('select[aria-label="入库商品"]') as HTMLSelectElement
    const numberInputs = Array.from(container.querySelectorAll('input[type="number"]')) as HTMLInputElement[]
    change(productSelect, 'product-1')
    change(numberInputs[0], '2')
    change(numberInputs[1], '160')

    // 未选供应商时前端拦截，不发请求
    const submit = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('确认手工入库'))
    await act(async () => { submit?.click() })
    expect(container.textContent).toContain('请选择供货供应商')
    expect(mockFetch.mock.calls.some(([path]) => String(path) === '/api/warehouse-inventory/manual-inbound')).toBe(false)

    // 供应商搜索框选上游供应商
    pickSupplier(container)
    expect(container.textContent).toContain('2 箱 × 8 = 16 袋')
    expect(container.textContent).toContain('¥10.00/袋')

    await act(async () => { submit?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path]) => String(path) === '/api/warehouse-inventory/manual-inbound'))

    const call = mockFetch.mock.calls.find(([path]) => String(path) === '/api/warehouse-inventory/manual-inbound')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      productId: 'product-1', purchaseQuantity: 2, totalAmount: 160, supplierId: 'sup-1',
    })

    act(() => root.unmount())
    container.remove()
  })

  it('adds multiple products to one atomic batch inbound document', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('菌菇酱') ?? false)
    const open = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('批量入库'))
    await act(async () => { open?.click() })
    await waitFor(() => container.textContent?.includes('总仓批量入库') ?? false)

    // 勾选面板一次勾选两种商品，一次添加
    checkAndAddCandidates(container, ['菌菇酱', '午餐肉'])
    expect(container.textContent).toContain('合计 2 种商品')

    const quantityInput = container.querySelector('input[aria-label="菌菇酱采购数量"]') as HTMLInputElement
    const priceInput = container.querySelector('input[aria-label="菌菇酱采购单价"]') as HTMLInputElement
    change(quantityInput, '2')
    change(priceInput, '80')
    const quantityInput2 = container.querySelector('input[aria-label="午餐肉采购数量"]') as HTMLInputElement
    const priceInput2 = container.querySelector('input[aria-label="午餐肉采购单价"]') as HTMLInputElement
    change(quantityInput2, '1')
    change(priceInput2, '240')

    // 底部供应商搜索框
    pickSupplier(container)
    expect(container.textContent).toContain('2 箱 = 16 袋')
    expect(container.textContent).toContain('¥400.00')
    const submit = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('确认批量入库'))
    await act(async () => { submit?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path]) => String(path) === '/api/warehouse-inventory/batch-manual-inbound'))

    const call = mockFetch.mock.calls.find(([path]) => String(path) === '/api/warehouse-inventory/batch-manual-inbound')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      items: [
        { productId: 'product-1', purchaseQuantity: 2, unitPrice: 80 },
        { productId: 'product-2', purchaseQuantity: 1, unitPrice: 240 },
      ],
      supplierId: 'sup-1',
    })

    act(() => root.unmount())
    container.remove()
  })

  it('moves across populated batch cells with all four arrow keys', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('菌菇酱') ?? false)
    const open = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('批量入库'))
    await act(async () => { open?.click() })
    await waitFor(() => container.textContent?.includes('总仓批量入库') ?? false)
    checkAndAddCandidates(container, ['菌菇酱', '午餐肉'])

    const firstQuantity = container.querySelector('input[aria-label="菌菇酱采购数量"]') as HTMLInputElement
    const firstPrice = container.querySelector('input[aria-label="菌菇酱采购单价"]') as HTMLInputElement
    const firstAmount = container.querySelector('input[aria-label="菌菇酱行金额"]') as HTMLInputElement
    const secondAmount = container.querySelector('input[aria-label="午餐肉行金额"]') as HTMLInputElement
    change(firstQuantity, '12')

    firstQuantity.focus()
    act(() => firstQuantity.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(document.activeElement).toBe(firstPrice)

    act(() => firstPrice.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(document.activeElement).toBe(firstAmount)

    act(() => firstAmount.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement).toBe(secondAmount)

    act(() => secondAmount.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expect(document.activeElement).toBe(container.querySelector('input[aria-label="午餐肉采购单价"]'))

    act(() => (document.activeElement as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })))
    expect(document.activeElement).toBe(firstPrice)

    act(() => root.unmount())
    container.remove()
  })

  it('verifies an inferred unit conversion from the review queue', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const inferred = { ...inventory, items: [{ ...inventory.items[0], unitConversionStatus: 'INFERRED' }] }
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-inventory?scope=unit-review')) return Promise.resolve(inferred)
      if (url.startsWith('/api/warehouse-inventory?scope=')) return Promise.resolve(inventory)
      if (url.startsWith('/api/warehouse-inventory/movements')) return Promise.resolve([])
      if (url === '/api/warehouse-inventory/audit') return Promise.resolve({
        readyForStrict: false, blockerCount: 0, warningCount: 0, checkedSku: 1, issues: [],
      })
      if (url === '/api/suppliers?businessScope=WAREHOUSE_UPSTREAM') {
        return Promise.resolve([{ id: 'sup-1', no: 'SUP001', name: '井育苗菇' }])
      }
      if (url === '/api/products/product-1' && init?.method === 'PATCH') return Promise.resolve({ count: 1 })
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })

    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('菌菇酱') ?? false)
    const tab = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('单位待核验'))
    await act(async () => { tab?.click() })
    await waitFor(() => Array.from(container.querySelectorAll('button'))
      .some(button => button.textContent?.includes('确认 1 箱 = 8 袋')))

    const verify = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('确认 1 箱 = 8 袋'))
    await act(async () => { verify?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path, init]) => String(path) === '/api/products/product-1' && init?.method === 'PATCH'))

    const call = mockFetch.mock.calls.find(([path, init]) => String(path) === '/api/products/product-1' && init?.method === 'PATCH')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ unitConversionStatus: 'VERIFIED' })
    expect(window.confirm).toHaveBeenCalled()

    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('derives unit price from edited line amount for round-off totals', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('菌菇酱') ?? false)
    const open = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('批量入库'))
    await act(async () => { open?.click() })
    await waitFor(() => container.textContent?.includes('总仓批量入库') ?? false)

    checkAndAddCandidates(container, ['菌菇酱'])

    const quantityInput = container.querySelector('input[aria-label="菌菇酱采购数量"]') as HTMLInputElement
    const priceInput = container.querySelector('input[aria-label="菌菇酱采购单价"]') as HTMLInputElement
    const amountInput = container.querySelector('input[aria-label="菌菇酱行金额"]') as HTMLInputElement
    expect(amountInput).toBeTruthy()

    // 数量 3 箱、单价 80 → 金额自动 240
    change(quantityInput, '3')
    change(priceInput, '80')
    expect(amountInput.value).toBe('240.00')

    // 凑整：直接把金额改成 250 → 单价反算 250/3
    change(amountInput, '250')
    expect(Number(priceInput.value)).toBeCloseTo(83.333333, 5)

    pickSupplier(container)
    const submit = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('确认批量入库'))
    await act(async () => { submit?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path]) => String(path) === '/api/warehouse-inventory/batch-manual-inbound'))

    const call = mockFetch.mock.calls.find(([path]) => String(path) === '/api/warehouse-inventory/batch-manual-inbound')
    const body = JSON.parse(String(call?.[1]?.body))
    // 提交以行金额为权威口径（totalAmount=250），单价为反算值
    expect(body.items[0].totalAmount).toBe(250)
    expect(body.items[0].purchaseQuantity).toBe(3)
    expect(body.items[0].unitPrice).toBeCloseTo(83.333333, 5)

    act(() => root.unmount())
    container.remove()
  })
})
