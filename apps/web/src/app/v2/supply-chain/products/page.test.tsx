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
      return Promise.resolve({ items: [PRODUCT], total: 1, page: 1, pageSize: 20 })
    }
    return Promise.resolve([])
  })
}

describe('商品管理 PC 页面 · 编辑弹窗分类组合框', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('编辑商品时分类字段渲染为单一组合框，预填当前分类且不再重复渲染下拉', async () => {
    mockRoutes()

    const { container, root } = render(<InternalSupplyChainProductsPage />)
    await waitFor(() => container.textContent?.includes('土豆') ?? false)

    act(() => findButton(container, '编辑')?.click())
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

    act(() => findButton(container, '编辑')?.click())
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

    act(() => findButton(container, '编辑')?.click())
    await waitFor(() => container.textContent?.includes('编辑「土豆」') ?? false)

    const label = getCategoryLabel(container)
    const input = label.querySelector('input') as HTMLInputElement
    act(() => { Simulate.change(input, { target: { value: '调料' } as any }) })

    await waitFor(() => container.textContent?.includes('创建并选用「调料」') ?? false)
    expect(container.textContent).toContain('创建并选用「调料」')

    cleanup(container, root)
  })
})
