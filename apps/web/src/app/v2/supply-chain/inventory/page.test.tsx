// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import InternalSupplyChainInventoryPage from './page'
import { buildInventoryExportRows } from '@/lib/inventory-export'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/v2', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span data-chip="true">{children}</span>,
}))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

const inventory = {
  canEditOrderEntryPolicy: true,
  warehouse: {
    id: 'warehouse-1', code: 'default', name: '供应链总仓', rowVersion: 3,
    inventoryMode: 'SHADOW', blockZeroStockAtOrderEntry: false,
  },
  summary: {
    inventoryMode: 'SHADOW', totalSku: 1, physicalSku: 0, negativeSku: 0,
    totalValue: 0, activeReservations: 0, movementCount: 0, strictActivated: false,
  },
  scope: 'stock',
  scopeCounts: { stockSku: 1, bomMappingSku: 79, unitReviewSku: 3 },
  items: [{
    id: 'product-1', code: 'DJ001', name: '菌菇酱', category: '酱料', spec: '8袋/箱',
    purchaseUnit: '箱', inventoryUnit: '袋', purchaseToInventoryFactor: 8,
    unitConversionStatus: 'VERIFIED', physicalQty: 24, reservedQty: 4, availableQty: 20,
    inventoryValue: 120, averageUnitCost: 5, statusFlag: 'OK',
    shipmentAmount: 168,
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
      if (url.startsWith('/api/warehouse-inventory/purchase-inbound-price-history')) return Promise.resolve({ items: [] })
      if (url === '/api/warehouse-inventory/manual-inbound' && init?.method === 'POST') {
        return Promise.resolve({ replayed: false, gateWarnings: [] })
      }
      if (url === '/api/warehouse-inventory/batch-manual-inbound' && init?.method === 'POST') {
        return Promise.resolve({ replayed: false, count: 1, totalAmount: 160, gateWarnings: [] })
      }
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
  })

  it('writes current shipment and cost amounts as columns in the inventory Excel workbook', async () => {
    const rows = buildInventoryExportRows(inventory.items as any, '')

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ 发货金额: 168, 成本金额: 120 })
    const expectedHeaders = [
      '商品编码', '商品名称', '商品状态', '分类', '规格', '采购单位', '库存单位',
      '物理库存', '预占库存', '可用库存', '库存金额', '平均单位成本', '发货金额', '成本金额', '库存状态',
    ]
    expect(Object.keys(rows[0])).toEqual(expectedHeaders)

    const XLSX = await import('xlsx')
    const sheet = XLSX.utils.json_to_sheet(rows)
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, sheet, '实时库存')
    const reopened = XLSX.read(XLSX.write(book, { bookType: 'xlsx', type: 'buffer' }), { type: 'buffer' })
    const values = XLSX.utils.sheet_to_json<unknown[]>(reopened.Sheets['实时库存'], { header: 1 })
    expect(values[0]).toEqual(expectedHeaders)
    expect(values[1][12]).toBe(168)
    expect(values[1][13]).toBe(120)
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

  it('opens and cancels the order-entry policy dialog without writing', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('设置订货策略') ?? false)

    const open = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '设置订货策略')
    act(() => open?.click())
    expect(container.querySelector('[role="dialog"]')).toBeTruthy()
    expect(container.textContent).toContain('仅提醒，仍可下单')
    expect(container.textContent).toContain('库存为 0，禁止下单')
    const unchangedSave = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认保存') as HTMLButtonElement
    expect(unchangedSave.disabled).toBe(true)
    expect(mockFetch.mock.calls.some(([path]) => String(path) === '/api/warehouse-inventory/order-entry-policy')).toBe(false)

    const cancel = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '取消')
    act(() => cancel?.click())
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(mockFetch.mock.calls.some(([path]) => String(path) === '/api/warehouse-inventory/order-entry-policy')).toBe(false)

    act(() => root.unmount())
    container.remove()
  })

  it('disables BLOCK when SHADOW audit fails and shows the blocker count and first reason', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('设置订货策略') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '设置订货策略')?.click())

    const block = container.querySelector('input[name="order-entry-policy"][value="BLOCK"]') as HTMLInputElement
    expect(block.disabled).toBe(true)
    expect(container.textContent).toContain('尚有 1 项阻断问题')
    expect(container.textContent).toContain('首项：批次剩余数量与物理余额不一致')

    act(() => root.unmount())
    container.remove()
  })

  it('disables BLOCK when the warehouse inventory projection is OFF', async () => {
    mockFetch.mockImplementation((path) => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-inventory?scope=')) return Promise.resolve({
        ...inventory,
        warehouse: { ...inventory.warehouse, inventoryMode: 'OFF' },
        summary: { ...inventory.summary, inventoryMode: 'OFF' },
      })
      if (url.startsWith('/api/warehouse-inventory/movements')) return Promise.resolve([])
      if (url === '/api/warehouse-inventory/audit') return Promise.resolve({
        readyForStrict: true, blockerCount: 0, warningCount: 0, checkedSku: 1, issues: [],
      })
      if (url === '/api/suppliers?businessScope=WAREHOUSE_UPSTREAM') return Promise.resolve([])
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })

    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('设置订货策略') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '设置订货策略')?.click())

    const block = container.querySelector('input[name="order-entry-policy"][value="BLOCK"]') as HTMLInputElement
    expect(block.disabled).toBe(true)
    expect(container.textContent).toContain('暂不可选：总仓库存投影尚未启用')

    act(() => root.unmount())
    container.remove()
  })

  it('requires confirmation for ALLOW to BLOCK and cancellation sends no PATCH and restores ALLOW', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-inventory?scope=')) return Promise.resolve(inventory)
      if (url.startsWith('/api/warehouse-inventory/movements')) return Promise.resolve([])
      if (url === '/api/warehouse-inventory/audit') return Promise.resolve({
        readyForStrict: true, blockerCount: 0, warningCount: 0, checkedSku: 1, issues: [],
      })
      if (url === '/api/suppliers?businessScope=WAREHOUSE_UPSTREAM') return Promise.resolve([])
      if (url === '/api/warehouse-inventory/order-entry-policy' && init?.method === 'PATCH') {
        return Promise.resolve({ blockZeroStockAtOrderEntry: true, rowVersion: 4 })
      }
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('设置订货策略') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '设置订货策略')?.click())
    const block = container.querySelector('input[name="order-entry-policy"][value="BLOCK"]') as HTMLInputElement
    act(() => block.click())
    const save = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认保存')
    await act(async () => { save?.click() })

    expect(window.confirm).toHaveBeenCalled()
    expect(mockFetch.mock.calls.some(([path]) => String(path) === '/api/warehouse-inventory/order-entry-policy')).toBe(false)
    expect((container.querySelector('input[name="order-entry-policy"][value="ALLOW"]') as HTMLInputElement).checked).toBe(true)

    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('submits one audited BLOCK policy change, ignores a double click, and does not update the page before success', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    let resolvePolicy!: (value: unknown) => void
    const pendingPolicy = new Promise(resolve => { resolvePolicy = resolve })
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-inventory?scope=')) return Promise.resolve(inventory)
      if (url.startsWith('/api/warehouse-inventory/movements')) return Promise.resolve([])
      if (url === '/api/warehouse-inventory/audit') return Promise.resolve({
        readyForStrict: true, blockerCount: 0, warningCount: 0, checkedSku: 1, issues: [],
      })
      if (url === '/api/suppliers?businessScope=WAREHOUSE_UPSTREAM') return Promise.resolve([])
      if (url === '/api/warehouse-inventory/order-entry-policy' && init?.method === 'PATCH') return pendingPolicy as Promise<any>
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('设置订货策略') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '设置订货策略')?.click())
    act(() => (container.querySelector('input[name="order-entry-policy"][value="BLOCK"]') as HTMLInputElement).click())
    const save = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认保存') as HTMLButtonElement
    await act(async () => { save.click(); save.click() })

    expect(container.textContent).toContain('当前：仅提醒，仍可下单')
    expect((Array.from(container.querySelectorAll('button')).find(button => button.textContent === '保存中…') as HTMLButtonElement).disabled).toBe(true)
    expect(mockFetch.mock.calls.filter(([path]) => String(path) === '/api/warehouse-inventory/order-entry-policy')).toHaveLength(1)
    const policyCall = mockFetch.mock.calls.find(([path]) => String(path) === '/api/warehouse-inventory/order-entry-policy')
    expect(JSON.parse(String(policyCall?.[1]?.body))).toEqual({ blockZeroStockAtOrderEntry: true, rowVersion: 3 })

    await act(async () => { resolvePolicy({ blockZeroStockAtOrderEntry: true, rowVersion: 4 }); await pendingPolicy })
    await waitFor(() => container.querySelector('[role="dialog"]') === null)

    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('keeps the current policy and resets the selection when saving fails', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    let rejectPolicy!: (reason: unknown) => void
    const pendingPolicy = new Promise((_resolve, reject) => { rejectPolicy = reject })
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-inventory?scope=')) return Promise.resolve(inventory)
      if (url.startsWith('/api/warehouse-inventory/movements')) return Promise.resolve([])
      if (url === '/api/warehouse-inventory/audit') return Promise.resolve({
        readyForStrict: true, blockerCount: 0, warningCount: 0, checkedSku: 1, issues: [],
      })
      if (url === '/api/suppliers?businessScope=WAREHOUSE_UPSTREAM') return Promise.resolve([])
      if (url === '/api/warehouse-inventory/order-entry-policy' && init?.method === 'PATCH') return pendingPolicy as Promise<any>
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })

    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('设置订货策略') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '设置订货策略')?.click())
    act(() => (container.querySelector('input[name="order-entry-policy"][value="BLOCK"]') as HTMLInputElement).click())
    const save = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认保存') as HTMLButtonElement
    await act(async () => { save.click() })

    expect(container.textContent).toContain('当前：仅提醒，仍可下单')
    await act(async () => {
      rejectPolicy(new Error('策略保存失败'))
      await pendingPolicy.catch(() => undefined)
    })

    expect(container.querySelector('[role="dialog"]')).toBeTruthy()
    expect(container.textContent).toContain('策略保存失败')
    expect(container.textContent).toContain('当前：仅提醒，仍可下单')
    expect((container.querySelector('input[name="order-entry-policy"][value="ALLOW"]') as HTMLInputElement).checked).toBe(true)
    expect((Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认保存') as HTMLButtonElement).disabled).toBe(true)

    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('shows read-only roles the current policy without a settings entry', async () => {
    mockFetch.mockImplementation((path) => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-inventory?scope=')) return Promise.resolve({ ...inventory, canEditOrderEntryPolicy: false })
      if (url.startsWith('/api/warehouse-inventory/movements')) return Promise.resolve([])
      if (url === '/api/warehouse-inventory/audit') return Promise.resolve({
        readyForStrict: false, blockerCount: 1, warningCount: 0, checkedSku: 1,
        issues: [{ code: 'LOT_BALANCE_MISMATCH', productId: 'product-1', message: '批次剩余数量与物理余额不一致' }],
      })
      if (url === '/api/suppliers?businessScope=WAREHOUSE_UPSTREAM') return Promise.resolve([])
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('当前：仅提醒，仍可下单') ?? false)
    expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent === '设置订货策略')).toBe(false)

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
    change(numberInputs[2], '160')

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

  it('uploads a supplier delivery document and submits only durable attachment metadata', async () => {
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-inventory?scope=')) return Promise.resolve(inventory)
      if (url === '/api/warehouse-inventory/inbound-candidates?limit=500') return Promise.resolve({ items: [...inventory.items, secondCandidate] })
      if (url.startsWith('/api/warehouse-inventory/movements')) return Promise.resolve([])
      if (url === '/api/warehouse-inventory/audit') return Promise.resolve({ readyForStrict: true, blockerCount: 0, warningCount: 0, checkedSku: 1, issues: [] })
      if (url === '/api/suppliers?businessScope=WAREHOUSE_UPSTREAM') return Promise.resolve([{ id: 'sup-1', no: 'SUP001', name: '井育苗菇' }])
      if (url.startsWith('/api/warehouse-inventory/purchase-inbound-price-history')) return Promise.resolve({ items: [] })
      if (url === '/api/upload?category=warehouse-docs' && init?.method === 'POST') return Promise.resolve({
        key: 'warehouse-docs/tenant-1/delivery.pdf', name: '供应商送货单.pdf', mime: 'application/pdf', size: 2048, url: 'https://signed.test/delivery.pdf',
      })
      if (url === '/api/warehouse-inventory/manual-inbound' && init?.method === 'POST') return Promise.resolve({ replayed: false, gateWarnings: [] })
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('菌菇酱') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '单条入库')?.click())
    change(container.querySelector('select[aria-label="入库商品"]') as HTMLSelectElement, 'product-1')
    const numberInputs = Array.from(container.querySelectorAll('input[type="number"]')) as HTMLInputElement[]
    change(numberInputs[0], '2')
    change(container.querySelector('input[aria-label="入库总金额"]') as HTMLInputElement, '160')
    pickSupplier(container)

    const fileInput = container.querySelector('input[aria-label="上传供应商随货单据"]') as HTMLInputElement
    const file = new File(['pdf'], '供应商送货单.pdf', { type: 'application/pdf' })
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
    await act(async () => { fileInput.dispatchEvent(new Event('change', { bubbles: true })) })
    await waitFor(() => container.textContent?.includes('供应商送货单.pdf') ?? false)

    await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认手工入库')?.click())
    await waitFor(() => mockFetch.mock.calls.some(([path]) => String(path) === '/api/warehouse-inventory/manual-inbound'))
    const call = mockFetch.mock.calls.find(([path]) => String(path) === '/api/warehouse-inventory/manual-inbound')
    expect(JSON.parse(String(call?.[1]?.body)).attachments).toEqual([{
      key: 'warehouse-docs/tenant-1/delivery.pdf', name: '供应商送货单.pdf', mime: 'application/pdf', size: 2048,
    }])
    expect(String(call?.[1]?.body)).not.toContain('https://signed.test')

    act(() => root.unmount())
    container.remove()
  })

  it('fills a blank single inbound amount from history but preserves a manual amount', async () => {
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-inventory?scope=')) return Promise.resolve(inventory)
      if (url.startsWith('/api/warehouse-inventory/movements')) return Promise.resolve([])
      if (url === '/api/warehouse-inventory/audit') return Promise.resolve({ readyForStrict: true, blockerCount: 0, warningCount: 0, checkedSku: 1, issues: [] })
      if (url === '/api/suppliers?businessScope=WAREHOUSE_UPSTREAM') return Promise.resolve([{ id: 'sup-1', no: 'SUP001', name: '井育苗菇' }])
      if (url.startsWith('/api/warehouse-inventory/purchase-inbound-price-history')) return Promise.resolve({ items: [{ productId: 'product-1', purchaseUnit: '箱', unitPrice: 75, effectiveAt: '2026-09-01', source: 'MANUAL_INBOUND' }] })
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
    const { container, root } = renderPage(); await waitFor(() => container.textContent?.includes('菌菇酱') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '单条入库')?.click())
    change(container.querySelector('select[aria-label="入库商品"]') as HTMLSelectElement, 'product-1')
    change((Array.from(container.querySelectorAll('input[type="number"]')) as HTMLInputElement[])[0], '2')
    pickSupplier(container)
    await waitFor(() => container.textContent?.includes('上次 ¥75.00/箱') ?? false)
    const total = container.querySelector('input[aria-label="入库总金额"]') as HTMLInputElement
    expect(total.value).toBe('150.00')
    change(total, '160')
    expect(total.value).toBe('160')
    act(() => root.unmount()); container.remove()
  })

  it('uses the latest quantity when a pending single-history response resolves', async () => {
    let resolveHistory!: (value: unknown) => void
    const pendingHistory = new Promise(resolve => { resolveHistory = resolve })
    mockFetch.mockImplementation(path => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-inventory?scope=')) return Promise.resolve(inventory)
      if (url.startsWith('/api/warehouse-inventory/movements')) return Promise.resolve([])
      if (url === '/api/warehouse-inventory/audit') return Promise.resolve({ readyForStrict: true, blockerCount: 0, warningCount: 0, checkedSku: 1, issues: [] })
      if (url === '/api/suppliers?businessScope=WAREHOUSE_UPSTREAM') return Promise.resolve([{ id: 'sup-1', no: 'SUP001', name: '井育苗菇' }])
      if (url.startsWith('/api/warehouse-inventory/purchase-inbound-price-history')) return pendingHistory as Promise<any>
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
    const { container, root } = renderPage(); await waitFor(() => container.textContent?.includes('菌菇酱') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '单条入库')?.click())
    change(container.querySelector('select[aria-label="入库商品"]') as HTMLSelectElement, 'product-1')
    const quantity = (Array.from(container.querySelectorAll('input[type="number"]')) as HTMLInputElement[])[0]
    change(quantity, '2'); pickSupplier(container); change(quantity, '3')
    await act(async () => { resolveHistory({ items: [{ productId: 'product-1', purchaseUnit: '箱', unitPrice: 75, effectiveAt: '2026-09-01', source: 'MANUAL_INBOUND' }] }); await pendingHistory })
    expect((container.querySelector('input[aria-label="入库总金额"]') as HTMLInputElement).value).toBe('225.00')
    act(() => root.unmount()); container.remove()
  })

  it('keeps manual price authoritative but keeps manual total authoritative when quantity changes', async () => {
    const { container, root } = renderPage(); await waitFor(() => container.textContent?.includes('菌菇酱') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '单条入库')?.click())
    change(container.querySelector('select[aria-label="入库商品"]') as HTMLSelectElement, 'product-1')
    const quantity = (Array.from(container.querySelectorAll('input[type="number"]')) as HTMLInputElement[])[0]
    const price = container.querySelector('input[aria-label="采购单价"]') as HTMLInputElement
    const total = container.querySelector('input[aria-label="入库总金额"]') as HTMLInputElement
    change(quantity, '2'); change(price, '80'); change(quantity, '3')
    expect(total.value).toBe('240.00')
    change(total, '250'); change(quantity, ''); expect(total.value).toBe('250'); change(quantity, '5')
    expect(total.value).toBe('250')
    expect(Number(price.value)).toBeCloseTo(50, 5)
    act(() => root.unmount()); container.remove()
  })

  it('clears manual values when the product changes before a supplier is selected', async () => {
    const twoProducts = { ...inventory, items: [...inventory.items, secondCandidate] }
    mockFetch.mockImplementation(path => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-inventory?scope=')) return Promise.resolve(twoProducts)
      if (url.startsWith('/api/warehouse-inventory/movements')) return Promise.resolve([])
      if (url === '/api/warehouse-inventory/audit') return Promise.resolve({ readyForStrict: true, blockerCount: 0, warningCount: 0, checkedSku: 1, issues: [] })
      if (url === '/api/suppliers?businessScope=WAREHOUSE_UPSTREAM') return Promise.resolve([])
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
    const { container, root } = renderPage(); await waitFor(() => container.textContent?.includes('午餐肉') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '单条入库')?.click())
    const select = container.querySelector('select[aria-label="入库商品"]') as HTMLSelectElement
    change(select, 'product-1'); change((Array.from(container.querySelectorAll('input[type="number"]')) as HTMLInputElement[])[0], '2')
    change(container.querySelector('input[aria-label="入库总金额"]') as HTMLInputElement, '160')
    change(select, 'product-2')
    expect((container.querySelector('input[aria-label="入库总金额"]') as HTMLInputElement).value).toBe('')
    expect((container.querySelector('input[aria-label="采购单价"]') as HTMLInputElement).value).toBe('')
    act(() => root.unmount()); container.remove()
  })

  it('replaces an automatic price when supplier changes and keeps it linked to quantity', async () => {
    mockFetch.mockImplementation(path => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-inventory?scope=')) return Promise.resolve(inventory)
      if (url.startsWith('/api/warehouse-inventory/movements')) return Promise.resolve([])
      if (url === '/api/warehouse-inventory/audit') return Promise.resolve({ readyForStrict: true, blockerCount: 0, warningCount: 0, checkedSku: 1, issues: [] })
      if (url === '/api/suppliers?businessScope=WAREHOUSE_UPSTREAM') return Promise.resolve([{ id: 'sup-a', no: 'A', name: '供应商A' }, { id: 'sup-b', no: 'B', name: '供应商B' }])
      if (url.includes('supplierId=sup-a')) return Promise.resolve({ items: [{ productId: 'product-1', purchaseUnit: '箱', unitPrice: 75, effectiveAt: '2026-09-01', source: 'MANUAL_INBOUND' }] })
      if (url.includes('supplierId=sup-b')) return Promise.resolve({ items: [{ productId: 'product-1', purchaseUnit: '箱', unitPrice: 40, effectiveAt: '2026-09-02', source: 'MANUAL_INBOUND' }] })
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
    const { container, root } = renderPage(); await waitFor(() => container.textContent?.includes('菌菇酱') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '单条入库')?.click())
    change(container.querySelector('select[aria-label="入库商品"]') as HTMLSelectElement, 'product-1')
    change((Array.from(container.querySelectorAll('input[type="number"]')) as HTMLInputElement[])[0], '2')
    pickSupplier(container, '供应商A')
    const total = container.querySelector('input[aria-label="入库总金额"]') as HTMLInputElement
    await waitFor(() => total.value === '150.00')
    pickSupplier(container, '供应商B')
    await waitFor(() => total.value === '80.00')
    change((Array.from(container.querySelectorAll('input[type="number"]')) as HTMLInputElement[])[0], '3')
    await waitFor(() => total.value === '120.00')
    act(() => root.unmount()); container.remove()
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

  it('caps a batch at 200 distinct products and warns instead of requesting 201 history rows', async () => {
    const manyCandidates = Array.from({ length: 201 }, (_, index) => ({
      ...secondCandidate, id: `bulk-${index}`, code: `BULK${index}`, name: `批量商品${index}`,
    }))
    mockFetch.mockImplementation(path => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-inventory?scope=')) return Promise.resolve(inventory)
      if (url === '/api/warehouse-inventory/inbound-candidates?limit=500') return Promise.resolve({ items: manyCandidates })
      if (url.startsWith('/api/warehouse-inventory/movements')) return Promise.resolve([])
      if (url === '/api/warehouse-inventory/audit') return Promise.resolve({ readyForStrict: true, blockerCount: 0, warningCount: 0, checkedSku: 1, issues: [] })
      if (url === '/api/suppliers?businessScope=WAREHOUSE_UPSTREAM') return Promise.resolve([])
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
    const { container, root } = renderPage(); await waitFor(() => container.textContent?.includes('菌菇酱') ?? false)
    await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('批量入库'))?.click())
    await waitFor(() => container.querySelector('input[aria-label="全选当前筛选结果"]') !== null)
    act(() => (container.querySelector('input[aria-label="全选当前筛选结果"]') as HTMLInputElement).click())
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('添加选中商品'))?.click())
    await waitFor(() => container.textContent?.includes('合计 200 种商品') ?? false)
    expect(container.textContent).toContain('单张批量入库最多 200 种商品')
    act(() => root.unmount()); container.remove()
  })

  it('does not overwrite a manually entered batch amount when history arrives late', async () => {
    let resolveHistory!: (value: unknown) => void
    const pendingHistory = new Promise(resolve => { resolveHistory = resolve })
    mockFetch.mockImplementation(path => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-inventory?scope=')) return Promise.resolve(inventory)
      if (url === '/api/warehouse-inventory/inbound-candidates?limit=500') return Promise.resolve({ items: [...inventory.items, secondCandidate] })
      if (url.startsWith('/api/warehouse-inventory/movements')) return Promise.resolve([])
      if (url === '/api/warehouse-inventory/audit') return Promise.resolve({ readyForStrict: true, blockerCount: 0, warningCount: 0, checkedSku: 1, issues: [] })
      if (url === '/api/suppliers?businessScope=WAREHOUSE_UPSTREAM') return Promise.resolve([{ id: 'sup-1', no: 'SUP001', name: '井育苗菇' }])
      if (url.startsWith('/api/warehouse-inventory/purchase-inbound-price-history')) return pendingHistory as Promise<any>
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
    const { container, root } = renderPage(); await waitFor(() => container.textContent?.includes('菌菇酱') ?? false)
    await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('批量入库'))?.click())
    await waitFor(() => container.textContent?.includes('总仓批量入库') ?? false)
    checkAndAddCandidates(container, ['菌菇酱'])
    const amount = container.querySelector('input[aria-label="菌菇酱行金额"]') as HTMLInputElement
    change(amount, '100')
    pickSupplier(container)
    await act(async () => { resolveHistory({ items: [{ productId: 'product-1', purchaseUnit: '箱', unitPrice: 75, effectiveAt: '2026-09-01', source: 'MANUAL_INBOUND' }] }); await pendingHistory })
    expect(amount.value).toBe('100')
    expect((container.querySelector('input[aria-label="菌菇酱采购单价"]') as HTMLInputElement).value).toBe('')
    act(() => root.unmount()); container.remove()
  })

  it('preserves a manual batch amount when a row-set refresh does not alter existing rows', async () => {
    mockFetch.mockImplementation(path => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-inventory?scope=')) return Promise.resolve(inventory)
      if (url === '/api/warehouse-inventory/inbound-candidates?limit=500') return Promise.resolve({ items: [...inventory.items, secondCandidate] })
      if (url.startsWith('/api/warehouse-inventory/movements')) return Promise.resolve([])
      if (url === '/api/warehouse-inventory/audit') return Promise.resolve({ readyForStrict: true, blockerCount: 0, warningCount: 0, checkedSku: 1, issues: [] })
      if (url === '/api/suppliers?businessScope=WAREHOUSE_UPSTREAM') return Promise.resolve([{ id: 'sup-1', no: 'SUP001', name: '井育苗菇' }])
      if (url.startsWith('/api/warehouse-inventory/purchase-inbound-price-history')) return Promise.resolve({ items: [{ productId: 'product-1', purchaseUnit: '箱', unitPrice: 75, effectiveAt: '2026-09-01', source: 'MANUAL_INBOUND' }] })
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
    const { container, root } = renderPage(); await waitFor(() => container.textContent?.includes('菌菇酱') ?? false)
    await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('批量入库'))?.click())
    await waitFor(() => container.textContent?.includes('总仓批量入库') ?? false)
    checkAndAddCandidates(container, ['菌菇酱']); pickSupplier(container)
    const quantity = container.querySelector('input[aria-label="菌菇酱采购数量"]') as HTMLInputElement
    const amount = container.querySelector('input[aria-label="菌菇酱行金额"]') as HTMLInputElement
    await waitFor(() => (container.querySelector('input[aria-label="菌菇酱采购单价"]') as HTMLInputElement).value === '75')
    change(quantity, ''); change(amount, '100')
    checkAndAddCandidates(container, ['午餐肉'])
    await waitFor(() => amount.value === '100')
    expect((container.querySelector('input[aria-label="菌菇酱采购单价"]') as HTMLInputElement).value).toBe('75')
    act(() => root.unmount()); container.remove()
  })

  it('preserves a manual batch price and its calculated amount when the row set changes', async () => {
    const { container, root } = renderPage(); await waitFor(() => container.textContent?.includes('菌菇酱') ?? false)
    await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('批量入库'))?.click())
    await waitFor(() => container.textContent?.includes('总仓批量入库') ?? false)
    checkAndAddCandidates(container, ['菌菇酱'])
    const quantity = container.querySelector('input[aria-label="菌菇酱采购数量"]') as HTMLInputElement
    const price = container.querySelector('input[aria-label="菌菇酱采购单价"]') as HTMLInputElement
    const amount = container.querySelector('input[aria-label="菌菇酱行金额"]') as HTMLInputElement
    change(quantity, '2'); change(price, '80')
    expect(amount.value).toBe('160.00')
    checkAndAddCandidates(container, ['午餐肉'])
    await waitFor(() => amount.value === '160.00')
    expect(price.value).toBe('80')
    act(() => root.unmount()); container.remove()
  })

  it('recalculates the amount from a manual batch price after the supplier changes', async () => {
    mockFetch.mockImplementation(path => {
      const url = String(path)
      if (url.startsWith('/api/warehouse-inventory?scope=')) return Promise.resolve(inventory)
      if (url === '/api/warehouse-inventory/inbound-candidates?limit=500') return Promise.resolve({ items: [...inventory.items, secondCandidate] })
      if (url.startsWith('/api/warehouse-inventory/movements')) return Promise.resolve([])
      if (url === '/api/warehouse-inventory/audit') return Promise.resolve({ readyForStrict: true, blockerCount: 0, warningCount: 0, checkedSku: 1, issues: [] })
      if (url === '/api/suppliers?businessScope=WAREHOUSE_UPSTREAM') return Promise.resolve([{ id: 'sup-a', no: 'A', name: '供应商A' }, { id: 'sup-b', no: 'B', name: '供应商B' }])
      if (url.startsWith('/api/warehouse-inventory/purchase-inbound-price-history')) return Promise.resolve({ items: [] })
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
    const { container, root } = renderPage(); await waitFor(() => container.textContent?.includes('菌菇酱') ?? false)
    await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('批量入库'))?.click())
    await waitFor(() => container.textContent?.includes('总仓批量入库') ?? false)
    checkAndAddCandidates(container, ['菌菇酱'])
    change(container.querySelector('input[aria-label="菌菇酱采购数量"]') as HTMLInputElement, '2')
    const price = container.querySelector('input[aria-label="菌菇酱采购单价"]') as HTMLInputElement
    const amount = container.querySelector('input[aria-label="菌菇酱行金额"]') as HTMLInputElement
    change(price, '80'); pickSupplier(container, '供应商A'); await waitFor(() => amount.value === '160.00')
    pickSupplier(container, '供应商B'); await waitFor(() => amount.value === '160.00')
    expect(price.value).toBe('80')
    act(() => root.unmount()); container.remove()
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
