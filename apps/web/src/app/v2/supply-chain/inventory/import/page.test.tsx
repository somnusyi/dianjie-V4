// @vitest-environment jsdom
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'

import InternalInventoryImportPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/v2', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span data-chip="true">{children}</span>,
}))

vi.mock('@/lib/v2-auth', () => ({
  apiFetch: vi.fn(),
}))

vi.mock('xlsx', () => ({
  read: vi.fn(() => ({
    SheetNames: ['Sheet1'],
    Sheets: {
      Sheet1: {},
    },
  })),
  utils: {
    sheet_to_json: vi.fn(() => [
      ['商品编码', '商品名称', '入库数量'],
      ['APL', '苹果', 5],
    ]),
  },
}))

import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

const SUPPLIERS = [
  { id: 'sup-1', no: 'SUP001', name: '昆明蔬菜批发' },
]

const PRODUCTS = [
  { id: 'p1', code: 'APL', name: '苹果', unit: 'kg', inventoryUnit: 'kg' },
]

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
    return Promise.resolve({})
  })
}

function createExcelFile(name = 'inbound.xlsx') {
  const content = new Uint8Array([1, 2, 3, 4])
  return new File([content], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

describe('Excel 批量入库页', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('提交时 URL 同时携带 supplierId 与 warehouseId=default', async () => {
    mockWithInboundResponse({ ok: true, count: 1, warehouseId: 'wh-real-001', warehouse: { id: 'wh-real-001', name: '默认总仓' } })

    const { container, root } = render(<InternalInventoryImportPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => Simulate.change(fileInput, { target: { files: [createExcelFile()] } as any }))
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '确认增量入库 1 行')?.click())
    await waitFor(() => container.textContent?.includes('已增量入库 1 个商品（默认总仓）') ?? false)

    const url = lastInboundUrl()
    expect(url.searchParams.get('supplierId')).toBe('sup-1')
    expect(url.searchParams.get('warehouseId')).toBe('default')

    const body = lastInboundBody()
    expect(body).toMatchObject({
      source: 'EXCEL',
      items: [{ productId: 'p1', qty: 5 }],
    })

    cleanup(container, root)
  })

  it('成功响应使用服务端返回的仓库名称', async () => {
    mockWithInboundResponse({ ok: true, count: 1, warehouseId: 'wh-north', warehouse: { id: 'wh-north', name: '城北仓' } })

    const { container, root } = render(<InternalInventoryImportPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => Simulate.change(fileInput, { target: { files: [createExcelFile()] } as any }))
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '确认增量入库 1 行')?.click())
    await waitFor(() => container.textContent?.includes('已增量入库 1 个商品（城北仓）') ?? false)

    cleanup(container, root)
  })

  it('响应仍返回 default 别名时视为失败，不清空 Excel 预览', async () => {
    mockWithInboundResponse({ ok: true, count: 1, warehouseId: 'default', warehouse: { id: 'default', name: '默认仓' } })

    const { container, root } = render(<InternalInventoryImportPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => Simulate.change(fileInput, { target: { files: [createExcelFile('bad.xlsx')] } as any }))
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '确认增量入库 1 行')?.click())
    await waitFor(() => container.textContent?.includes('入库响应未返回真实仓库 ID') ?? false)

    expect(container.textContent).not.toContain('已增量入库')
    expect(container.textContent).toContain('苹果')

    cleanup(container, root)
  })

  it('响应仓库 ID 不一致时视为失败，保留用户输入的说明与文件名', async () => {
    mockWithInboundResponse({ ok: true, count: 1, warehouseId: 'wh-a', warehouse: { id: 'wh-b', name: '问题仓' } })

    const { container, root } = render(<InternalInventoryImportPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => Simulate.change(fileInput, { target: { files: [createExcelFile('mismatch.xlsx')] } as any }))
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    const reasonInput = getInputByLabel(container, '整批入库说明') as HTMLInputElement
    act(() => setInputValue(reasonInput, '测试说明'))

    act(() => findButton(container, '确认增量入库 1 行')?.click())
    await waitFor(() => container.textContent?.includes('入库响应仓库 ID 不一致') ?? false)

    expect(container.textContent).toContain('mismatch.xlsx')
    expect(reasonInput.value).toBe('测试说明')

    cleanup(container, root)
  })

  it('切换供应商后提交使用新的 supplierId', async () => {
    const twoSuppliers = [
      { id: 'sup-1', no: 'SUP001', name: '昆明蔬菜批发' },
      { id: 'sup-2', no: 'SUP002', name: '大理水产' },
    ]
    mockFetch.mockImplementation((path, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && String(path).startsWith('/api/supplier/stock/inbound')) {
        return Promise.resolve({ ok: true, count: 1, warehouseId: 'wh-real-001', warehouse: { id: 'wh-real-001', name: '默认总仓' } })
      }
      if (method !== 'GET') return Promise.resolve({})
      if (path === '/api/suppliers?status=ENABLED') return Promise.resolve(twoSuppliers)
      if (String(path).startsWith('/api/supplier/stock?page=')) return Promise.resolve({ items: PRODUCTS })
      return Promise.resolve({})
    })

    const { container, root } = render(<InternalInventoryImportPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const supplierSelect = Array.from(container.querySelectorAll('select')).find(
      s => Array.from(s.options).some(o => o.value === 'sup-2'),
    )!
    act(() => setInputValue(supplierSelect, 'sup-2'))
    await waitFor(() => mockFetch.mock.calls.some(([path]) => String(path).includes('supplierId=sup-2')))

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => Simulate.change(fileInput, { target: { files: [createExcelFile()] } as any }))
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '确认增量入库 1 行')?.click())
    await waitFor(() => container.textContent?.includes('已增量入库') ?? false)

    expect(lastInboundUrl().searchParams.get('supplierId')).toBe('sup-2')

    cleanup(container, root)
  })
})
