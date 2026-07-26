// @vitest-environment jsdom
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'

import InternalSupplyChainInventoryPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/v2', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span data-chip="true">{children}</span>,
}))

vi.mock('@/lib/v2-auth', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

const SUPPLIERS = [
  { id: 'sup-1', no: 'SUP001', name: '昆明蔬菜批发' },
  { id: 'sup-2', no: 'SUP002', name: '大理水产' },
]

const PRODUCTS = [
  { id: 'p1', code: 'APL', name: '苹果', unit: 'kg', inventoryUnit: 'kg', stock: 100, reservedStock: 0, availableStock: 100, minStock: 10, statusFlag: 'OK' as const },
]

const SUMMARY = {
  inventoryMode: 'STRICT' as const,
  totalSku: 1,
  lowStock: 0,
  outOfStock: 0,
  totalValue: 500,
  warehouse: { id: 'wh-real-001', name: '默认总仓' },
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
  const input = label.querySelector('input, select')
  if (!input) throw new Error(`Input not found for label: ${labelText}`)
  return input as HTMLInputElement | HTMLSelectElement
}

function setInputValue(input: HTMLInputElement | HTMLSelectElement, value: string) {
  Simulate.change(input, { target: { value } as any })
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  Simulate.change(select, { target: { value } as any })
}

function lastInboundCall() {
  const call = [...mockFetch.mock.calls]
    .reverse()
    .find(([path, init]) => String(path).startsWith('/api/supplier/stock/inbound') && (init?.method ?? 'GET').toUpperCase() === 'POST')
  return call
}

function lastInboundUrl() {
  const call = lastInboundCall()
  if (!call) throw new Error('No inbound POST call found')
  return new URL(String(call[0]), 'http://localhost')
}

function lastInboundBody() {
  const call = lastInboundCall()
  if (!call) return undefined
  const init = call[1]
  if (typeof init?.body !== 'string') return undefined
  try { return JSON.parse(init.body) } catch { return undefined }
}

function mockWithInboundResponse(inboundResponse: any) {
  mockFetch.mockImplementation((path, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'POST' && String(path).startsWith('/api/supplier/stock/inbound')) {
      return Promise.resolve(inboundResponse)
    }
    if (method !== 'GET') return Promise.resolve({})
    if (path === '/api/suppliers?status=ENABLED') return Promise.resolve(SUPPLIERS)
    if (String(path).startsWith('/api/supplier/stock?page=')) return Promise.resolve({ items: PRODUCTS })
    if (String(path).startsWith('/api/supplier/stock/summary')) return Promise.resolve(SUMMARY)
    if (String(path).startsWith('/api/supplier/stock/movements')) return Promise.resolve([])
    return Promise.resolve({})
  })
}

describe('仓库库存页 · 手工入库', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('打开弹窗并提交时 URL 同时携带 supplierId 与 warehouseId=default', async () => {
    mockWithInboundResponse({ ok: true, count: 1, warehouseId: 'wh-real-001', warehouse: { id: 'wh-real-001', name: '默认总仓' } })

    const { container, root } = render(<InternalSupplyChainInventoryPage />)
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '+ 手工入库')?.click())
    await waitFor(() => container.textContent?.includes('确认入库') ?? false)

    const productSelect = getInputByLabel(container, '商品') as HTMLSelectElement
    act(() => setSelectValue(productSelect, 'p1'))

    const qtyInput = getInputByLabel(container, '入库数量（库存单位）') as HTMLInputElement
    act(() => setInputValue(qtyInput, '10'))

    act(() => findButton(container, '确认入库')?.click())
    await waitFor(() => container.textContent?.includes('入库成功（默认总仓）') ?? false)

    const url = lastInboundUrl()
    expect(url.searchParams.get('supplierId')).toBe('sup-1')
    expect(url.searchParams.get('warehouseId')).toBe('default')

    const body = lastInboundBody()
    expect(body).toMatchObject({
      source: 'MANUAL',
      items: [{ productId: 'p1', qty: 10 }],
    })

    cleanup(container, root)
  })

  it('成功响应使用服务端返回的仓库名称', async () => {
    mockWithInboundResponse({ ok: true, count: 1, warehouseId: 'wh-south', warehouse: { id: 'wh-south', name: '城南仓' } })

    const { container, root } = render(<InternalSupplyChainInventoryPage />)
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '+ 手工入库')?.click())
    await waitFor(() => container.textContent?.includes('确认入库') ?? false)

    act(() => setSelectValue(getInputByLabel(container, '商品') as HTMLSelectElement, 'p1'))
    act(() => setInputValue(getInputByLabel(container, '入库数量（库存单位）') as HTMLInputElement, '5'))

    act(() => findButton(container, '确认入库')?.click())
    await waitFor(() => container.textContent?.includes('入库成功（城南仓）') ?? false)

    cleanup(container, root)
  })

  it('响应仍返回 default 别名时视为失败，不清空弹窗输入', async () => {
    mockWithInboundResponse({ ok: true, count: 1, warehouseId: 'default', warehouse: { id: 'default', name: '默认仓' } })

    const { container, root } = render(<InternalSupplyChainInventoryPage />)
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '+ 手工入库')?.click())
    await waitFor(() => container.textContent?.includes('确认入库') ?? false)

    act(() => setSelectValue(getInputByLabel(container, '商品') as HTMLSelectElement, 'p1'))
    act(() => setInputValue(getInputByLabel(container, '入库数量（库存单位）') as HTMLInputElement, '8'))

    act(() => findButton(container, '确认入库')?.click())
    await waitFor(() => container.textContent?.includes('入库响应未返回真实仓库 ID') ?? false)

    expect(container.textContent).not.toContain('入库成功')
    expect((getInputByLabel(container, '商品') as HTMLSelectElement).value).toBe('p1')
    expect((getInputByLabel(container, '入库数量（库存单位）') as HTMLInputElement).value).toBe('8')

    cleanup(container, root)
  })

  it('响应缺失仓库元数据时视为失败，不关闭弹窗', async () => {
    mockWithInboundResponse({ ok: true, count: 1, warehouseId: 'wh-real-001' })

    const { container, root } = render(<InternalSupplyChainInventoryPage />)
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '+ 手工入库')?.click())
    await waitFor(() => container.textContent?.includes('确认入库') ?? false)

    act(() => setSelectValue(getInputByLabel(container, '商品') as HTMLSelectElement, 'p1'))
    act(() => setInputValue(getInputByLabel(container, '入库数量（库存单位）') as HTMLInputElement, '3'))

    act(() => findButton(container, '确认入库')?.click())
    await waitFor(() => container.textContent?.includes('入库响应缺少仓库元数据') ?? false)

    expect(container.textContent).toContain('手工入库')

    cleanup(container, root)
  })

  it('提供指向全量盘点导入页的清晰入口，URL 携带当前 supplierId', async () => {
    mockWithInboundResponse({ ok: true, count: 1, warehouseId: 'wh-real-001', warehouse: { id: 'wh-real-001', name: '默认总仓' } })

    const { container, root } = render(<InternalSupplyChainInventoryPage />)
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    const link = Array.from(container.querySelectorAll('a')).find(a => a.textContent?.trim() === '全量盘点导入')
    expect(link).toBeTruthy()
    expect(link?.getAttribute('href')).toBe('/v2/supply-chain/inventory/snapshot?supplierId=sup-1')

    cleanup(container, root)
  })

  it('切换供应商后提交使用新的 supplierId', async () => {
    mockWithInboundResponse({ ok: true, count: 1, warehouseId: 'wh-real-001', warehouse: { id: 'wh-real-001', name: '默认总仓' } })

    const { container, root } = render(<InternalSupplyChainInventoryPage />)
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    const supplierSelect = Array.from(container.querySelectorAll('select')).find(
      s => Array.from(s.options).some(o => o.value === 'sup-2'),
    )!
    act(() => setSelectValue(supplierSelect, 'sup-2'))
    await waitFor(() =>
      mockFetch.mock.calls.some(([path]) => String(path).includes('supplierId=sup-2')),
    )

    act(() => findButton(container, '+ 手工入库')?.click())
    await waitFor(() => container.textContent?.includes('确认入库') ?? false)

    act(() => setSelectValue(getInputByLabel(container, '商品') as HTMLSelectElement, 'p1'))
    act(() => setInputValue(getInputByLabel(container, '入库数量（库存单位）') as HTMLInputElement, '2'))

    act(() => findButton(container, '确认入库')?.click())
    await waitFor(() => container.textContent?.includes('入库成功') ?? false)

    expect(lastInboundUrl().searchParams.get('supplierId')).toBe('sup-2')
    await act(async () => { await sleep(0) })

    cleanup(container, root)
  })
})
