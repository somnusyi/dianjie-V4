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
    if (url.startsWith('/api/products/categories')) return Promise.resolve(CATEGORIES)
    if (url.startsWith('/api/suppliers')) return Promise.resolve(SUPPLIERS)
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
