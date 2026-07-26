// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'

import InternalStockDetailPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const PRODUCT_ID = 'p1'

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: PRODUCT_ID }),
}))

vi.mock('@/components/v2', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span data-chip="true">{children}</span>,
}))

vi.mock('@/lib/v2-auth', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

const STOCK_ITEM = {
  id: PRODUCT_ID,
  code: 'APL',
  name: '苹果',
  spec: '大果',
  unit: '箱',
  inventoryUnit: 'kg',
  physicalStock: 100,
  reservedStock: 10,
  availableStock: 90,
  minStock: 20,
}

function renderWithSearch(search: string) {
  const url = `http://localhost/v2/supply-chain/inventory/${PRODUCT_ID}${search ? `?${search}` : ''}`
  ;(globalThis as any).jsdom?.reconfigure?.({ url })

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<InternalStockDetailPage />))
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

function findButton(container: HTMLElement, text: string) {
  return Array.from((container.getRootNode() as Document | ShadowRoot).querySelectorAll('button')).find(
    b => b.textContent?.trim() === text,
  )
}

function getInputByLabel(container: HTMLElement, labelText: string) {
  const label = Array.from(container.querySelectorAll('label')).find(
    l => l.querySelector('span')?.textContent?.trim() === labelText,
  )
  if (!label) throw new Error(`Label not found: ${labelText}`)
  const input = label.querySelector('input')
  if (!input) throw new Error(`Input not found for label: ${labelText}`)
  return input as HTMLInputElement
}

function setInputValue(input: HTMLInputElement, value: string) {
  Simulate.change(input, { target: { value } as any })
}

function lastWriteCall(action: 'adjust' | 'loss') {
  return [...mockFetch.mock.calls]
    .reverse()
    .find(([path, init]) => String(path).startsWith(`/api/supplier/stock/${action}`) && (init?.method ?? 'GET').toUpperCase() === 'POST')
}

function lastWriteUrl(action: 'adjust' | 'loss') {
  const call = lastWriteCall(action)
  if (!call) throw new Error(`No ${action} POST call found`)
  return new URL(String(call[0]), 'http://localhost')
}

function lastWriteBody(action: 'adjust' | 'loss') {
  const call = lastWriteCall(action)
  if (!call) return undefined
  const init = call[1]
  if (typeof init?.body !== 'string') return undefined
  try { return JSON.parse(init.body) } catch { return undefined }
}

function mockWithDetailResponse(writeResponse: any, status = 200) {
  mockFetch.mockImplementation((path, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const pathStr = String(path)
    if (method === 'POST' && (pathStr.startsWith('/api/supplier/stock/adjust') || pathStr.startsWith('/api/supplier/stock/loss'))) {
      if (status >= 400) {
        const error = Object.assign(new Error('库存已变动，请刷新后重试'), { status })
        return Promise.reject(error)
      }
      return Promise.resolve(writeResponse)
    }
    if (method !== 'GET') return Promise.resolve({})
    if (pathStr.startsWith('/api/supplier/stock?')) return Promise.resolve({ items: [STOCK_ITEM] })
    if (pathStr.startsWith('/api/supplier/stock/movements')) return Promise.resolve([])
    if (pathStr.startsWith('/api/supplier/stock/reservations')) return Promise.resolve([])
    if (pathStr.startsWith('/api/supplier/stock/batches')) return Promise.resolve([])
    return Promise.resolve({})
  })
}

describe('内部供应链库存详情页 · 盘点调整与报损登记', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('盘点调整提交 URL 携带 supplierId 与 warehouseId=default，body 不含 warehouseId', async () => {
    mockWithDetailResponse({ warehouseId: 'wh-real-001', warehouse: { id: 'wh-real-001', name: '默认总仓' } })

    const { container, root } = renderWithSearch('supplierId=sup-1')
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '⇄ 盘点调整')?.click())
    await waitFor(() => container.textContent?.includes('盘点调整') ?? false)

    const qtyInput = getInputByLabel(container, '盘点后数量（库存单位）')
    act(() => setInputValue(qtyInput, '88.5'))

    const reasonInput = getInputByLabel(container, '原因')
    act(() => setInputValue(reasonInput, '月末盘点'))

    act(() => findButton(container, '确认提交')?.click())
    await waitFor(() => container.textContent?.includes('盘点调整成功（默认总仓）') ?? false)

    const url = lastWriteUrl('adjust')
    expect(url.searchParams.get('supplierId')).toBe('sup-1')
    expect(url.searchParams.get('warehouseId')).toBe('default')

    const body = lastWriteBody('adjust')
    expect(body).toEqual({ productId: PRODUCT_ID, newQty: 88.5, reason: '月末盘点' })

    cleanup(container, root)
  })

  it('报损登记提交 URL 携带 supplierId 与 warehouseId=default，body 不含 warehouseId', async () => {
    mockWithDetailResponse({ warehouseId: 'wh-real-001', warehouse: { id: 'wh-real-001', name: '默认总仓' } })

    const { container, root } = renderWithSearch('supplierId=sup-1')
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '⊖ 报损登记')?.click())
    await waitFor(() => container.textContent?.includes('报损登记') ?? false)

    const qtyInput = getInputByLabel(container, '报损数量（库存单位）')
    act(() => setInputValue(qtyInput, '5.5'))

    const reasonInput = getInputByLabel(container, '原因')
    act(() => setInputValue(reasonInput, '蔬菜腐烂'))

    act(() => findButton(container, '确认提交')?.click())
    await waitFor(() => container.textContent?.includes('报损登记成功（默认总仓）') ?? false)

    const url = lastWriteUrl('loss')
    expect(url.searchParams.get('supplierId')).toBe('sup-1')
    expect(url.searchParams.get('warehouseId')).toBe('default')

    const body = lastWriteBody('loss')
    expect(body).toEqual({ productId: PRODUCT_ID, qty: 5.5, reason: '蔬菜腐烂' })

    cleanup(container, root)
  })

  it('成功响应使用服务端返回的真实仓库名称', async () => {
    mockWithDetailResponse({ warehouseId: 'wh-south', warehouse: { id: 'wh-south', name: '城南仓' } })

    const { container, root } = renderWithSearch('supplierId=sup-1')
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '⇄ 盘点调整')?.click())
    await waitFor(() => container.textContent?.includes('盘点调整') ?? false)

    act(() => setInputValue(getInputByLabel(container, '盘点后数量（库存单位）'), '95'))
    act(() => setInputValue(getInputByLabel(container, '原因'), '临时盘点'))
    act(() => findButton(container, '确认提交')?.click())

    await waitFor(() => container.textContent?.includes('盘点调整成功（城南仓）') ?? false)
    cleanup(container, root)
  })

  it('库存明细使用 inventoryUnit 而不是采购/计价单位', async () => {
    mockWithDetailResponse({ warehouseId: 'wh-real-001', warehouse: { id: 'wh-real-001', name: '默认总仓' } })

    const { container, root } = renderWithSearch('supplierId=sup-1')
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    expect(container.textContent).toContain('100 kg')
    expect(container.textContent).not.toContain('100 箱')

    act(() => findButton(container, '⇄ 盘点调整')?.click())
    await waitFor(() => container.textContent?.includes('盘点调整') ?? false)
    expect(container.textContent).toContain('库存单位：kg')

    cleanup(container, root)
  })

  it('空数量、空原因、负数量与超两位小数均阻止提交并保留输入', async () => {
    mockWithDetailResponse({ warehouseId: 'wh-real-001', warehouse: { id: 'wh-real-001', name: '默认总仓' } })

    const { container, root } = renderWithSearch('supplierId=sup-1')
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '⊖ 报损登记')?.click())
    await waitFor(() => container.textContent?.includes('报损登记') ?? false)

    const qtyInput = getInputByLabel(container, '报损数量（库存单位）')
    const reasonInput = getInputByLabel(container, '原因')

    act(() => setInputValue(qtyInput, ''))
    act(() => setInputValue(reasonInput, 'test'))
    act(() => findButton(container, '确认提交')?.click())
    await waitFor(() => container.textContent?.includes('请填写数量') ?? false)
    expect(lastWriteCall('loss')).toBeUndefined()

    act(() => setInputValue(qtyInput, '-1'))
    act(() => findButton(container, '确认提交')?.click())
    await waitFor(() => container.textContent?.includes('数量不能为负数') ?? false)
    expect(qtyInput.value).toBe('-1')

    act(() => setInputValue(qtyInput, '0'))
    act(() => findButton(container, '确认提交')?.click())
    await waitFor(() => container.textContent?.includes('数量必须大于 0') ?? false)

    act(() => setInputValue(qtyInput, '1.234'))
    act(() => findButton(container, '确认提交')?.click())
    await waitFor(() => container.textContent?.includes('最多两位小数') ?? false)
    expect(qtyInput.value).toBe('1.234')

    act(() => setInputValue(qtyInput, '1.5'))
    act(() => setInputValue(reasonInput, ''))
    act(() => findButton(container, '确认提交')?.click())
    await waitFor(() => container.textContent?.includes('请填写原因') ?? false)
    expect(qtyInput.value).toBe('1.5')

    cleanup(container, root)
  })

  it('盘点调整允许 0 但不允许负数', async () => {
    mockWithDetailResponse({ warehouseId: 'wh-real-001', warehouse: { id: 'wh-real-001', name: '默认总仓' } })

    const { container, root } = renderWithSearch('supplierId=sup-1')
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '⇄ 盘点调整')?.click())
    await waitFor(() => container.textContent?.includes('盘点调整') ?? false)

    act(() => setInputValue(getInputByLabel(container, '盘点后数量（库存单位）'), '-0.1'))
    act(() => setInputValue(getInputByLabel(container, '原因'), '盘亏'))
    act(() => findButton(container, '确认提交')?.click())
    await waitFor(() => container.textContent?.includes('数量不能为负数') ?? false)

    act(() => setInputValue(getInputByLabel(container, '盘点后数量（库存单位）'), '0'))
    act(() => findButton(container, '确认提交')?.click())
    await waitFor(() => container.textContent?.includes('盘点调整成功') ?? false)

    expect(lastWriteBody('adjust')).toMatchObject({ newQty: 0, reason: '盘亏' })

    cleanup(container, root)
  })

  it('缺 supplierId 时不展示操作按钮且不会提交', async () => {
    mockWithDetailResponse({ warehouseId: 'wh-real-001', warehouse: { id: 'wh-real-001', name: '默认总仓' } })

    const { container, root } = renderWithSearch('')
    await waitFor(() => container.textContent?.includes('库存详情') ?? false)

    expect(findButton(container, '⇄ 盘点调整')).toBeUndefined()
    expect(findButton(container, '⊖ 报损登记')).toBeUndefined()
    expect(mockFetch.mock.calls.every(([path, init]) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const pathStr = String(path)
      return !(method === 'POST' && (pathStr.startsWith('/api/supplier/stock/adjust') || pathStr.startsWith('/api/supplier/stock/loss')))
    })).toBe(true)

    cleanup(container, root)
  })

  it('HTTP 409 时显示明确错误，保留弹层与表单值，不显示成功提示、不刷新', async () => {
    mockWithDetailResponse({ message: '库存已变动，请刷新后重试' }, 409)

    const { container, root } = renderWithSearch('supplierId=sup-1')
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '⇄ 盘点调整')?.click())
    await waitFor(() => container.textContent?.includes('盘点调整') ?? false)

    act(() => setInputValue(getInputByLabel(container, '盘点后数量（库存单位）'), '80'))
    act(() => setInputValue(getInputByLabel(container, '原因'), '盘点冲突'))

    const detailCallsBefore = mockFetch.mock.calls.filter(([path]) => String(path).startsWith('/api/supplier/stock?')).length

    act(() => findButton(container, '确认提交')?.click())
    await waitFor(() => container.textContent?.includes('库存已变动，请刷新后重试') ?? false)

    expect(container.textContent).not.toContain('盘点调整成功')
    expect(container.textContent).toContain('盘点调整')
    expect(container.querySelector('.fixed')?.textContent).toContain('库存已变动，请刷新后重试')
    expect(getInputByLabel(container, '盘点后数量（库存单位）').value).toBe('80')
    expect(getInputByLabel(container, '原因').value).toBe('盘点冲突')

    const detailCallsAfter = mockFetch.mock.calls.filter(([path]) => String(path).startsWith('/api/supplier/stock?')).length
    expect(detailCallsAfter).toBe(detailCallsBefore)

    cleanup(container, root)
  })

  it('响应仍返回 default 别名时视为失败，保留弹层与输入', async () => {
    mockWithDetailResponse({ warehouseId: 'default', warehouse: { id: 'default', name: '默认仓' } })

    const { container, root } = renderWithSearch('supplierId=sup-1')
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '⊖ 报损登记')?.click())
    await waitFor(() => container.textContent?.includes('报损登记') ?? false)

    act(() => setInputValue(getInputByLabel(container, '报损数量（库存单位）'), '3'))
    act(() => setInputValue(getInputByLabel(container, '原因'), '过期'))

    act(() => findButton(container, '确认提交')?.click())
    await waitFor(() => container.textContent?.includes('响应未返回真实仓库 ID') ?? false)

    expect(container.textContent).not.toContain('报损登记成功')
    expect(container.textContent).toContain('报损登记')
    expect(getInputByLabel(container, '报损数量（库存单位）').value).toBe('3')
    expect(getInputByLabel(container, '原因').value).toBe('过期')

    cleanup(container, root)
  })

  it('响应仓库 id 与 warehouseId 不一致时视为失败，保留弹层与输入', async () => {
    mockWithDetailResponse({ warehouseId: 'wh-real-001', warehouse: { id: 'wh-other', name: '错仓' } })

    const { container, root } = renderWithSearch('supplierId=sup-1')
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '⇄ 盘点调整')?.click())
    await waitFor(() => container.textContent?.includes('盘点调整') ?? false)

    act(() => setInputValue(getInputByLabel(container, '盘点后数量（库存单位）'), '70'))
    act(() => setInputValue(getInputByLabel(container, '原因'), 'id 不一致'))

    act(() => findButton(container, '确认提交')?.click())
    await waitFor(() => container.textContent?.includes('响应仓库 ID 不一致') ?? false)

    expect(container.textContent).not.toContain('盘点调整成功')
    expect(getInputByLabel(container, '盘点后数量（库存单位）').value).toBe('70')
    expect(getInputByLabel(container, '原因').value).toBe('id 不一致')

    cleanup(container, root)
  })

  it('提交中禁用重复提交', async () => {
    let resolvePost: (value: any) => void
    const postPromise = new Promise(resolve => { resolvePost = resolve })

    mockFetch.mockImplementation((path, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const pathStr = String(path)
      if (method === 'POST' && pathStr.startsWith('/api/supplier/stock/loss')) {
        return postPromise
      }
      if (method !== 'GET') return Promise.resolve({})
      if (pathStr.startsWith('/api/supplier/stock?')) return Promise.resolve({ items: [STOCK_ITEM] })
      if (pathStr.startsWith('/api/supplier/stock/movements')) return Promise.resolve([])
      if (pathStr.startsWith('/api/supplier/stock/reservations')) return Promise.resolve([])
      if (pathStr.startsWith('/api/supplier/stock/batches')) return Promise.resolve([])
      return Promise.resolve({})
    })

    const { container, root } = renderWithSearch('supplierId=sup-1')
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '⊖ 报损登记')?.click())
    await waitFor(() => container.textContent?.includes('报损登记') ?? false)

    act(() => setInputValue(getInputByLabel(container, '报损数量（库存单位）'), '2'))
    act(() => setInputValue(getInputByLabel(container, '原因'), '破损'))

    act(() => findButton(container, '确认提交')?.click())
    await waitFor(() => findButton(container, '正在提交…') !== undefined)

    const submitBtn = findButton(container, '正在提交…')
    expect(submitBtn?.hasAttribute('disabled')).toBe(true)

    act(() => resolvePost!({ warehouseId: 'wh-real-001', warehouse: { id: 'wh-real-001', name: '默认总仓' } }))
    await waitFor(() => container.textContent?.includes('报损登记成功') ?? false)

    cleanup(container, root)
  })
})
