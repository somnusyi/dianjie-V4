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

describe('总仓库存页面', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-inventory?scope=')) return Promise.resolve(inventory)
      if (url === '/api/warehouse-inventory/inbound-candidates?limit=500') return Promise.resolve({ items: inventory.items })
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

    const selects = Array.from(container.querySelectorAll('select')) as HTMLSelectElement[]
    const numberInputs = Array.from(container.querySelectorAll('input[type="number"]')) as HTMLInputElement[]
    change(selects[0], 'product-1')
    change(numberInputs[0], '2')
    change(numberInputs[1], '160')

    // 未选供应商时前端拦截，不发请求
    const submit = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('确认手工入库'))
    await act(async () => { submit?.click() })
    expect(container.textContent).toContain('请选择供货供应商')
    expect(mockFetch.mock.calls.some(([path]) => String(path) === '/api/warehouse-inventory/manual-inbound')).toBe(false)

    // 供应商下拉（商品 select 之后）选上游供应商
    change(selects[1], 'sup-1')
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

    const selects = Array.from(container.querySelectorAll('select')) as HTMLSelectElement[]
    change(selects[0], 'product-1')
    const add = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '添加商品')
    act(() => add?.click())

    const quantityInput = container.querySelector('input[aria-label="菌菇酱采购数量"]') as HTMLInputElement
    const priceInput = container.querySelector('input[aria-label="菌菇酱采购单价"]') as HTMLInputElement
    change(quantityInput, '2')
    change(priceInput, '80')

    // 底部供应商下拉
    change(selects[1], 'sup-1')
    expect(container.textContent).toContain('2 箱 = 16 袋')
    expect(container.textContent).toContain('¥160.00')
    const submit = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('确认批量入库'))
    await act(async () => { submit?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path]) => String(path) === '/api/warehouse-inventory/batch-manual-inbound'))

    const call = mockFetch.mock.calls.find(([path]) => String(path) === '/api/warehouse-inventory/batch-manual-inbound')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      items: [{ productId: 'product-1', purchaseQuantity: 2, unitPrice: 80 }],
      supplierId: 'sup-1',
    })

    act(() => root.unmount())
    container.remove()
  })
})
