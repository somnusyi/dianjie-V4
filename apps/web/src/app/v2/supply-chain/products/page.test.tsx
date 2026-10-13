// @vitest-environment jsdom
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'

import InternalSupplyChainProductsPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/v2', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span data-chip="true">{children}</span>,
}))

vi.mock('@/components/v2/product-tool-tabs', () => ({
  ProductToolTabs: () => <div data-tool-tabs="true" />,
}))

vi.mock('@/components/v2/confirm-sheet', () => ({
  useConfirmSheet: () => [
    { open: false, title: '', close: vi.fn() },
    vi.fn(),
  ],
  ConfirmSheet: () => null,
}))

vi.mock('@/components/v2/skeleton', () => ({
  EmptyState: ({ title, hint }: { title: string; hint?: string }) => (
    <div data-empty="true">
      <div data-empty-title="true">{title}</div>
      {hint && <div data-empty-hint="true">{hint}</div>}
    </div>
  ),
  FriendlyError: ({ message }: { message?: string }) => <div data-error="true">{message}</div>,
  SkeletonCard: () => <div data-skeleton="true" />,
}))

vi.mock('@/components/v2/product-image-preview', () => ({
  ProductImagePreview: () => null,
}))

vi.mock('@/lib/v2-auth', () => ({
  apiFetch: vi.fn(),
  apiDownload: vi.fn(),
}))

import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

const CATEGORIES = [
  { name: '蔬菜', count: 3 },
  { name: '冻品', count: 2 },
]

const SUPPLIERS = [{ id: 'sup-1', name: '昆明蔬菜批发' }]

const PRODUCT = {
  id: 'p1',
  name: '土豆',
  code: 'P001',
  category: '蔬菜',
  unit: 'kg',
  price: 3.5,
  status: 'ENABLED',
  spec: '500g/袋',
  shelfDays: 7,
  stock: 10,
  minStock: 2,
  minOrderQty: 1,
  stepQty: 1,
  imageUrl: null,
  supplier: { id: 'sup-1', name: '昆明蔬菜批发' },
}

function render(ui: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(ui))
  return { container, root }
}

function cleanup(container: HTMLElement, root: ReturnType<typeof createRoot>) {
  act(() => root.unmount())
  container.remove()
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeout = 1000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await act(async () => { await sleep(10) })
  }
}

function findButton(root: ParentNode, text: string) {
  return Array.from(root.querySelectorAll('button')).find(b => b.textContent?.trim() === text)
}

/** 定位编辑弹窗里的「分类」字段：单一组合框（input[list] + datalist）。 */
function getCategoryLabel(container: HTMLElement): HTMLLabelElement {
  const label = Array.from(container.querySelectorAll('label')).find(l =>
    l.querySelector('input[list]') !== null && l.querySelector('datalist') !== null,
  )
  if (!label) throw new Error('Category field not found')
  return label as HTMLLabelElement
}

function mockRoutes() {
  mockFetch.mockImplementation(path => {
    const url = String(path)
    if (url === '/api/products/next-code') return Promise.resolve({ code: 'TEN0-AUTOCODE01' })
    if (url.startsWith('/api/products/categories')) return Promise.resolve(CATEGORIES)
    if (url.startsWith('/api/suppliers')) return Promise.resolve(SUPPLIERS)
    if (url.startsWith('/api/product-upstream-sources')) return Promise.resolve({ productId: 'p1', sources: [] })
    if (url.startsWith('/api/products')) {
      // 不带 page 的调用是「按筛选统计分类数量」的全量请求，返回数组而非分页对象
      if (!url.includes('page=')) return Promise.resolve([PRODUCT])
      return Promise.resolve({ items: [PRODUCT], total: 1, page: 1, pageSize: 20 })
    }
    return Promise.resolve([])
  })
}

/** 读取左侧分类侧栏中某个分类名右侧显示的计数。 */
function getSidebarCategoryCount(container: HTMLElement, name: string): string | null {
  const button = Array.from(container.querySelectorAll('aside button')).find(btn => {
    const spans = btn.querySelectorAll('span')
    return spans.length > 0 && spans[0].textContent?.trim() === name
  })
  if (!button) return null
  const spans = button.querySelectorAll('span')
  return spans[spans.length - 1].textContent?.trim() ?? null
}

describe('商品管理 PC 页面 · 编辑弹窗分类组合框', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('商品列表直接展示单位换算列，不需要进入编辑弹窗查找', async () => {
    mockRoutes()
    const { container, root } = render(<InternalSupplyChainProductsPage />)
    await waitFor(() => container.textContent?.includes('土豆') ?? false)

    expect(Array.from(container.querySelectorAll('th')).some(th => th.textContent === '单位换算')).toBe(true)
    expect(container.textContent).toContain('历史换算未核验')
    expect(container.textContent).not.toContain('1 kg = 1 kg')

    cleanup(container, root)
  })

  it('编辑商品时分类字段渲染为单一组合框，预填当前分类且不再重复渲染下拉', async () => {
    mockRoutes()

    const { container, root } = render(<InternalSupplyChainProductsPage />)
    await waitFor(() => container.textContent?.includes('土豆') ?? false)

    await act(async () => { findButton(container, '编辑')?.click() })
    await waitFor(() => container.textContent?.includes('编辑「土豆」') ?? false)

    const label = getCategoryLabel(container)
    // 组合框只有一个可编辑输入框，不再叠加重复的 select
    expect(label.querySelector('select')).toBeNull()
    expect(label.querySelectorAll('input').length).toBe(1)

    const input = label.querySelector('input') as HTMLInputElement
    // 编辑时预填商品当前分类
    expect(input.value).toBe('蔬菜')

    // 下拉候选列出已有分类
    const optionValues = Array.from(label.querySelectorAll('datalist option')).map(
      o => (o as HTMLOptionElement).value,
    )
    expect(optionValues).toContain('蔬菜')
    expect(optionValues).toContain('冻品')

    cleanup(container, root)
  })

  it('在组合框中选择/输入其他分类后同步到表单，可正常保存', async () => {
    mockRoutes()

    const { container, root } = render(<InternalSupplyChainProductsPage />)
    await waitFor(() => container.textContent?.includes('土豆') ?? false)

    await act(async () => { findButton(container, '编辑')?.click() })
    await waitFor(() => container.textContent?.includes('编辑「土豆」') ?? false)

    const label = getCategoryLabel(container)
    const input = label.querySelector('input') as HTMLInputElement
    act(() => { Simulate.change(input, { target: { value: '冻品' } as any }) })

    await waitFor(() => (label.querySelector('input') as HTMLInputElement).value === '冻品')
    expect((label.querySelector('input') as HTMLInputElement).value).toBe('冻品')

    cleanup(container, root)
  })

  it('输入新分类名时仍显示「创建并选用」入口（保留内联新建能力）', async () => {
    mockRoutes()

    const { container, root } = render(<InternalSupplyChainProductsPage />)
    await waitFor(() => container.textContent?.includes('土豆') ?? false)

    await act(async () => { findButton(container, '编辑')?.click() })
    await waitFor(() => container.textContent?.includes('编辑「土豆」') ?? false)

    const label = getCategoryLabel(container)
    const input = label.querySelector('input') as HTMLInputElement
    act(() => { Simulate.change(input, { target: { value: '调料' } as any }) })

    await waitFor(() => container.textContent?.includes('创建并选用「调料」') ?? false)
    expect(container.textContent).toContain('创建并选用「调料」')

    cleanup(container, root)
  })

  it('点击分类字段右侧箭头可弹出候选列表，点选后同步到表单（修复下拉点击无响应）', async () => {
    mockRoutes()

    const { container, root } = render(<InternalSupplyChainProductsPage />)
    await waitFor(() => container.textContent?.includes('土豆') ?? false)

    await act(async () => { findButton(container, '编辑')?.click() })
    await waitFor(() => container.textContent?.includes('编辑「土豆」') ?? false)

    const label = getCategoryLabel(container)
    const toggle = label.querySelector('button[aria-label="展开分类列表"]') as HTMLButtonElement
    expect(toggle).not.toBeNull()

    // 点击箭头弹出候选列表（不依赖原生 datalist）
    act(() => toggle.click())
    await waitFor(() => label.textContent?.includes('冻品') ?? false)

    const option = Array.from(label.querySelectorAll('button')).find(b => b.textContent?.includes('冻品'))
    expect(option).toBeTruthy()
    act(() => option!.click())

    await waitFor(() => (label.querySelector('input') as HTMLInputElement).value === '冻品')
    expect((label.querySelector('input') as HTMLInputElement).value).toBe('冻品')

    cleanup(container, root)
  })
})

describe('商品管理 PC 页面 · 供应商业务口径', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('区分后台履约主体和页面采购来源，不再把履约主体当商品供应商展示', async () => {
    mockRoutes()

    const { container, root } = render(<InternalSupplyChainProductsPage />)
    await waitFor(() => container.textContent?.includes('土豆') ?? false)

    const supplierCalls = mockFetch.mock.calls
      .map(call => String(call[0]))
      .filter(url => url.startsWith('/api/suppliers'))
    expect(supplierCalls).toContain('/api/suppliers?status=ENABLED&businessScope=STORE_FULFILLER')
    expect(supplierCalls).toContain('/api/suppliers?status=ENABLED&businessScope=WAREHOUSE_UPSTREAM')
    expect(container.textContent).not.toContain('门店供货主体')
    expect(container.textContent).not.toContain('全部供货主体')
    expect(container.textContent).toContain('采购来源')
    expect(container.textContent).toContain('尚未维护')

    cleanup(container, root)
  })

  it('可为商品添加上游采购来源并提交独立关联', async () => {
    mockRoutes()

    const { container, root } = render(<InternalSupplyChainProductsPage />)
    await waitFor(() => container.textContent?.includes('添加来源') ?? false)

    act(() => findButton(container, '添加来源')!.click())
    await waitFor(() => container.textContent?.includes('采购来源 · 土豆') ?? false)
    await waitFor(() => Boolean(findButton(container, '＋ 添加采购来源')))
    act(() => findButton(container, '＋ 添加采购来源')!.click())
    await waitFor(() => container.textContent?.includes('主供应商') ?? false)
    act(() => findButton(container, '保存采购来源')!.click())

    await waitFor(() => mockFetch.mock.calls.some(call => (
      String(call[0]) === '/api/product-upstream-sources/p1'
      && (call[1] as RequestInit | undefined)?.method === 'PUT'
    )))
    const putCall = mockFetch.mock.calls.find(call => (
      String(call[0]) === '/api/product-upstream-sources/p1'
      && (call[1] as RequestInit | undefined)?.method === 'PUT'
    ))
    expect(JSON.parse(String((putCall?.[1] as RequestInit).body))).toMatchObject({
      sources: [{ supplierId: 'sup-1', isPrimary: true, purchaseUnit: 'kg' }],
    })

    cleanup(container, root)
  })

  it('新增商品时可在加大的供应商选择框内模糊搜索并添加供应商', async () => {
    mockRoutes()

    const { container, root } = render(<InternalSupplyChainProductsPage />)
    await waitFor(() => Boolean(findButton(container, '＋ 新增商品')))

    act(() => findButton(container, '＋ 新增商品')!.click())
    await waitFor(() => container.textContent?.includes('新增商品') ?? false)
    await waitFor(() => Boolean(findButton(container, '＋ 添加供应商') && !findButton(container, '＋ 添加供应商')!.disabled))

    act(() => findButton(container, '＋ 添加供应商')!.click())
    await waitFor(() => Boolean(container.querySelector(
      'input[placeholder="搜索供应商名称、编码、联系人或电话"]',
    )))
    const search = container.querySelector(
      'input[placeholder="搜索供应商名称、编码、联系人或电话"]',
    ) as HTMLInputElement | null
    expect(search).not.toBeNull()

    act(() => { Simulate.change(search!, { target: { value: '蔬菜批' } as any }) })
    await waitFor(() => Boolean(Array.from(container.querySelectorAll('[role="option"]')).find(option => (
      option.textContent?.includes('昆明蔬菜批发')
    ))))

    const option = Array.from(container.querySelectorAll('[role="option"]')).find(item => (
      item.textContent?.includes('昆明蔬菜批发')
    )) as HTMLButtonElement | undefined
    expect(option).toBeTruthy()
    act(() => option!.click())

    await waitFor(() => container.textContent?.includes('上游供应商 *') ?? false)
    expect(container.textContent).toContain('昆明蔬菜批发')
    expect(container.querySelector('[role="listbox"]')).toBeNull()

    cleanup(container, root)
  })
})

describe('商品管理 PC 页面 · 分类计数与列表筛选口径对齐', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  // 服务端分类计数恒按「全部状态」统计；列表默认带「状态=供应中」。
  // 模拟一个已停售的菌类商品：分类主数据计数为 1，但供应中筛选下列表为空。
  const ALL_PRODUCTS = [
    { ...PRODUCT, id: 'p1', name: '土豆', category: '蔬菜', status: 'ENABLED' },
    { id: 'p2', name: '香菇', code: 'P002', category: '菌类', unit: 'kg', price: 8, status: 'DISABLED', spec: null, shelfDays: 7, stock: 0, minStock: 0, minOrderQty: 1, stepQty: 1, imageUrl: null, supplier: { id: 'sup-1', name: '昆明蔬菜批发' } },
  ]

  function mockFilterAwareRoutes() {
    mockFetch.mockImplementation(path => {
      const url = String(path)
      if (url.startsWith('/api/products/categories')) {
        // 主数据计数按全部状态：蔬菜 1、菌类 1
        return Promise.resolve([
          { name: '蔬菜', count: 1 },
          { name: '菌类', count: 1 },
        ])
      }
      if (url.startsWith('/api/suppliers')) return Promise.resolve(SUPPLIERS)
      if (url.startsWith('/api/products')) {
        const status = new URL(url, 'http://localhost').searchParams.get('status')
        const matched = status ? ALL_PRODUCTS.filter(p => p.status === status) : ALL_PRODUCTS
        if (!url.includes('page=')) return Promise.resolve(matched)
        return Promise.resolve({ items: matched, total: matched.length, page: 1, pageSize: 20 })
      }
      return Promise.resolve([])
    })
  }

  function findSelectByOptionText(container: HTMLElement, optionText: string): HTMLSelectElement {
    const select = Array.from(container.querySelectorAll('select')).find(sel =>
      Array.from(sel.querySelectorAll('option')).some(o => o.textContent?.trim() === optionText),
    )
    if (!select) throw new Error(`Select with option "${optionText}" not found`)
    return select as HTMLSelectElement
  }

  it('左侧分类计数与顶部分类(N)跟随状态筛选联动，不再显示有商品却列表为空', async () => {
    mockFilterAwareRoutes()

    const { container, root } = render(<InternalSupplyChainProductsPage />)

    // 默认「状态=供应中」：菌类商品已停售，分类计数应联动为 0（而非服务端全状态的 1）
    await waitFor(() => getSidebarCategoryCount(container, '菌类') === '0')
    expect(getSidebarCategoryCount(container, '菌类')).toBe('0')
    expect(getSidebarCategoryCount(container, '蔬菜')).toBe('1')

    // 顶部分类下拉的 (N) 同样对齐到当前筛选
    const categorySelect = findSelectByOptionText(container, '全部分类')
    const junOption = Array.from(categorySelect.querySelectorAll('option')).find(o =>
      o.textContent?.trim().startsWith('菌类'),
    )
    expect(junOption?.textContent?.trim()).toBe('菌类 (0)')

    // 清空状态筛选后，停售商品重新计入，分类计数恢复为 1
    const statusSelect = findSelectByOptionText(container, '供应中')
    act(() => { Simulate.change(statusSelect, { target: { value: '' } as any }) })
    await waitFor(() => getSidebarCategoryCount(container, '菌类') === '1')
    expect(getSidebarCategoryCount(container, '菌类')).toBe('1')
    expect(getSidebarCategoryCount(container, '蔬菜')).toBe('1')

    cleanup(container, root)
  })
})

describe('商品管理 PC 页面 · 门店端分类隔离', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  const STORE_CATEGORIES = [
    { name: '蔬菜', count: 3 },
    { name: '冻品', count: 2 },
    { name: '前厅调料', count: 1 },
    { name: '水吧', count: 1 },
    { name: '素菜岗', count: 4 },
    { name: '菌菇岗', count: 2 },
    { name: 'BOM待采购映射', count: 5 },
  ]

  function mockStoreCategoryRoutes() {
    mockFetch.mockImplementation(path => {
      const url = String(path)
      if (url.startsWith('/api/products/categories')) return Promise.resolve(STORE_CATEGORIES)
      if (url.startsWith('/api/suppliers')) return Promise.resolve(SUPPLIERS)
      if (url.startsWith('/api/products')) {
        if (!url.includes('page=')) return Promise.resolve([PRODUCT])
        return Promise.resolve({ items: [PRODUCT], total: 1, page: 1, pageSize: 20 })
      }
      return Promise.resolve([])
    })
  }

  it('左侧分类栏不展示门店端分类（前厅调料/水吧/xx岗/BOM待采购映射）', async () => {
    mockStoreCategoryRoutes()

    const { container, root } = render(<InternalSupplyChainProductsPage />)
    await waitFor(() => container.textContent?.includes('土豆') ?? false)
    await waitFor(() => getSidebarCategoryCount(container, '蔬菜') !== null)

    expect(getSidebarCategoryCount(container, '蔬菜')).not.toBeNull()
    expect(getSidebarCategoryCount(container, '冻品')).not.toBeNull()

    expect(getSidebarCategoryCount(container, '前厅调料')).toBeNull()
    expect(getSidebarCategoryCount(container, '水吧')).toBeNull()
    expect(getSidebarCategoryCount(container, '素菜岗')).toBeNull()
    expect(getSidebarCategoryCount(container, '菌菇岗')).toBeNull()
    expect(getSidebarCategoryCount(container, 'BOM待采购映射')).toBeNull()

    cleanup(container, root)
  })

  it('顶部分类下拉同样不展示门店端分类', async () => {
    mockStoreCategoryRoutes()

    const { container, root } = render(<InternalSupplyChainProductsPage />)
    await waitFor(() => container.textContent?.includes('土豆') ?? false)
    await waitFor(() => getSidebarCategoryCount(container, '蔬菜') !== null)

    const categorySelect = Array.from(container.querySelectorAll('select')).find(sel =>
      Array.from(sel.querySelectorAll('option')).some(o => o.textContent?.trim() === '全部分类'),
    )
    expect(categorySelect).toBeTruthy()
    const optionTexts = Array.from(categorySelect!.querySelectorAll('option')).map(o => o.textContent?.trim() ?? '')
    expect(optionTexts.some(t => t.startsWith('蔬菜'))).toBe(true)
    expect(optionTexts.some(t => t.startsWith('前厅调料'))).toBe(false)
    expect(optionTexts.some(t => t.startsWith('素菜岗'))).toBe(false)
    expect(optionTexts.some(t => t.startsWith('BOM待采购映射'))).toBe(false)

    cleanup(container, root)
  })
})


describe('单位换算列表不伪造1:1', () => {
  it.each(['PENDING', 'VERIFIED'])('原始状态%s分别显示待核或真实比例', async status => {
    mockRoutes()
    const original = mockFetch.getMockImplementation()!
    const product = { ...PRODUCT, unitConversionStatus: status, purchaseUnit: '箱', inventoryUnit: '瓶', orderUnit: '箱', costUnit: '瓶', inventoryUnitsPerPurchaseUnit: status === 'PENDING' ? null : 10, inventoryUnitsPerOrderUnit: status === 'PENDING' ? null : 10, inventoryUnitsPerCostUnit: 1 }
    mockFetch.mockImplementation((path, init) => String(path).startsWith('/api/products') && !String(path).startsWith('/api/products/categories')
      ? Promise.resolve(String(path).includes('page=') ? { items: [product], total: 1, page: 1, pageSize: 20 } : [product])
      : original(path, init))
    const { container, root } = render(<InternalSupplyChainProductsPage />)
    await waitFor(() => container.textContent?.includes('土豆') ?? false)
    if (status === 'PENDING') {
      expect(container.textContent).toContain('换算待核验')
      expect(container.textContent).not.toContain('1 箱 = 1 瓶')
    } else expect(container.textContent).toContain('1 箱 = 10 瓶')
    cleanup(container, root)
  })
})


describe('旧商品编辑不把缺失因子补成1', () => {
  function mockPending(overrides: Record<string, unknown> = {}) {
    mockFetch.mockReset()
    mockRoutes()
    const original = mockFetch.getMockImplementation()!
    const product = { ...PRODUCT, unitConversionStatus: 'PENDING', purchaseUnit: 'kg', inventoryUnit: 'kg', orderUnit: 'kg', costUnit: 'kg', inventoryUnitsPerPurchaseUnit: null, inventoryUnitsPerOrderUnit: null, inventoryUnitsPerCostUnit: null, ...overrides }
    mockFetch.mockImplementation((path, init) => String(path).startsWith('/api/products') && !String(path).startsWith('/api/products/categories') && !init?.method
      ? Promise.resolve(String(path).includes('page=') ? { items: [product], total: 1, page: 1, pageSize: 20 } : [product])
      : original(path, init))
  }
  function inputFor(container: Element, labelText: string) {
    const label = Array.from(container.querySelectorAll('label')).find(label => label.textContent?.trim() === labelText)
    if (!label) throw new Error(`missing label ${labelText}`)
    return label.querySelector('input')!
  }
  it('缺换算编辑留空，单独改名称不回填单位因子', async () => {
    mockPending()
    const { container, root } = render(<InternalSupplyChainProductsPage />)
    await waitFor(() => container.textContent?.includes('土豆') ?? false)
    await act(async () => findButton(container, '编辑')!.click())
    expect(inputFor(container, '1 kg = ？kg').value).toBe('')
    expect(container.textContent).toContain('换算待补齐或核验')
    act(() => Simulate.change(inputFor(container, '名称 *'), { target: { value: '土豆改名' } as any }))
    await act(async () => findButton(container, '保存修改')!.click())
    const patch = mockFetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!
    expect(JSON.parse(String(patch[1]!.body))).toEqual({ name: '土豆改名' })
    cleanup(container, root)
  })
  it('人工输入1后发送完整合同，不能因默认值diff漏掉补齐', async () => {
    mockPending()
    const { container, root } = render(<InternalSupplyChainProductsPage />)
    await waitFor(() => container.textContent?.includes('土豆') ?? false)
    await act(async () => findButton(container, '编辑')!.click())
    act(() => Simulate.change(inputFor(container, '1 kg = ？kg'), { target: { value: '1' } as any }))
    act(() => Simulate.change(inputFor(container, '1 kg = ？kg（起订量换算）'), { target: { value: '1' } as any }))
    await act(async () => findButton(container, '保存修改')!.click())
    const patch = mockFetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!
    expect(JSON.parse(String(patch[1]!.body))).toMatchObject({ purchaseUnit: 'kg', inventoryUnit: 'kg', orderUnit: 'kg', costUnit: 'kg', inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1, inventoryUnitsPerCostUnit: 1, unit: 'kg' })
    cleanup(container, root)
  })
  it('不同订货单位的缺比例不跟随采购因子，必须分别补齐', async () => {
    mockPending({ orderUnit: '盒', unit: '盒' })
    const { container, root } = render(<InternalSupplyChainProductsPage />)
    await waitFor(() => container.textContent?.includes('土豆') ?? false)
    await act(async () => findButton(container, '编辑')!.click())
    act(() => Simulate.change(inputFor(container, '1 采购单位 = ？库存单位'), { target: { value: '1' } as any }))
    expect(inputFor(container, '1 订货单位 = ？库存单位').value).toBe('')
    await act(async () => findButton(container, '保存修改')!.click())
    expect(mockFetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
    expect(container.textContent).toContain('换算因子必填')
    act(() => Simulate.change(inputFor(container, '1 订货单位 = ？库存单位'), { target: { value: '2' } as any }))
    await act(async () => findButton(container, '保存修改')!.click())
    const patch = mockFetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!
    expect(JSON.parse(String(patch[1]!.body))).toMatchObject({ orderUnit: '盒', inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 2, inventoryUnitsPerCostUnit: 1 })
    cleanup(container, root)
  })

})

it('新建商品输入采购单价，显示最小单位和起订金额，并按成本单位价格提交',async()=>{
 mockRoutes();const original=mockFetch.getMockImplementation()!;mockFetch.mockImplementation((path,init)=>init?.method==='POST'&&path==='/api/products'?Promise.resolve({id:'new'}):original(path,init))
 const {container,root}=render(<InternalSupplyChainProductsPage />)
 try{
  await waitFor(()=>!!findButton(container,'＋ 新增商品'));await act(async()=>findButton(container,'＋ 新增商品')!.click())
  const field=(label:string)=>Array.from(container.querySelectorAll('label')).find(item=>item.textContent?.includes(label))!.querySelector('input')!
  const change=(input:HTMLInputElement,value:string)=>act(()=>Simulate.change(input,{target:{value} as any}))
  change(field('名称'),'单位换算测试');change(field('采购单位（'),'kg');change(field('库存最小单位'),'g');change(field('1 kg ='),'1000');change(field('最小下单量单位'),'kg');change(field('起订量换算'),'1000')
  change(container.querySelector('[aria-label="商品输入单价"]')!,'95');change(container.querySelector('[aria-label="商品最小下单量"]')!,'2')
  const preview=container.querySelector('[aria-label="单价与起订量换算"]')!
  expect(preview.textContent).toContain('0.095 元 / g');expect(preview.textContent).toContain('95 元 / kg');expect(preview.textContent).toContain('2000 g');expect(preview.textContent).toContain('190 元')
  await act(async()=>findButton(container,'新增')!.click())
  const write=mockFetch.mock.calls.find(([path,init])=>path==='/api/products'&&init?.method==='POST')!
  expect(JSON.parse(String(write[1]?.body))).toMatchObject({price:0.095,costUnit:'g',inventoryUnit:'g',orderUnit:'kg',minOrderQty:2,inventoryUnitsPerPurchaseUnit:1000,inventoryUnitsPerOrderUnit:1000,inventoryUnitsPerCostUnit:1})
 }finally{cleanup(container,root)}
})

it('三种单位独立换算，起订量位于单位区且编码自动填写不可手改',async()=>{
 mockRoutes();const original=mockFetch.getMockImplementation()!;mockFetch.mockImplementation((path,init)=>init?.method==='POST'&&path==='/api/products'?Promise.resolve({id:'new'}):original(path,init))
 const {container,root}=render(<InternalSupplyChainProductsPage />)
 try{
  await waitFor(()=>!!findButton(container,'＋ 新增商品'));await act(async()=>findButton(container,'＋ 新增商品')!.click())
  const section=container.querySelector('[aria-label="单位换算设置"]')!
  expect(section.querySelector('[aria-label="商品最小下单量"]')).not.toBeNull()
  const code=container.querySelector('[aria-label="自动生成商品编码"]') as HTMLInputElement
  expect(code.value).toBe('TEN0-AUTOCODE01');expect(code.readOnly).toBe(true)
  const field=(label:string)=>Array.from(container.querySelectorAll('label')).find(item=>item.textContent?.includes(label))!.querySelector('input')!
  const change=(input:HTMLInputElement,value:string)=>act(()=>Simulate.change(input,{target:{value} as any}))
  change(field('名称'),'独立单位');change(field('采购单位（'),'箱');change(field('库存最小单位'),'g');change(field('1 箱 ='),'2000');change(field('最小下单量单位'),'kg');change(field('起订量换算'),'1000')
  change(container.querySelector('[aria-label="商品输入单价"]')!,'10');change(section.querySelector('[aria-label="商品最小下单量"]')!,'2')
  const preview=container.querySelector('[aria-label="单价与起订量换算"]')!
  expect(preview.textContent).toContain('0.005 元 / g');expect(preview.textContent).toContain('5 元 / kg');expect(preview.textContent).toContain('10 元')
  await act(async()=>findButton(container,'新增')!.click())
  const write=mockFetch.mock.calls.find(([path,init])=>path==='/api/products'&&init?.method==='POST')!
  expect(JSON.parse(String(write[1]?.body))).toMatchObject({code:'TEN0-AUTOCODE01',purchaseUnit:'箱',orderUnit:'kg',inventoryUnit:'g',inventoryUnitsPerPurchaseUnit:2000,inventoryUnitsPerOrderUnit:1000,minOrderQty:2,price:0.005})
 }finally{cleanup(container,root)}
})
