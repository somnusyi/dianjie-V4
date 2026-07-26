// @vitest-environment jsdom
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'

import InternalInventorySnapshotPage from './page'

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
    Sheets: { Sheet1: {} },
  })),
  utils: {
    sheet_to_json: vi.fn(() => []),
  },
}))

import * as XLSX from 'xlsx'
import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)
const mockXlsxUtils = vi.mocked(XLSX.utils)

const SUPPLIERS = [
  { id: 'sup-1', no: 'SUP001', name: '昆明蔬菜批发' },
  { id: 'sup-2', no: 'SUP002', name: '大理水产' },
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

function setSelectValue(select: HTMLSelectElement, value: string) {
  Simulate.change(select, { target: { value } as any })
}

function lastSnapshotCall() {
  const call = [...mockFetch.mock.calls]
    .reverse()
    .find(([path, init]) => String(path).startsWith('/api/supplier/stock/import-snapshot') && (init?.method ?? 'GET').toUpperCase() === 'POST')
  return call
}

function lastSnapshotUrl() {
  const call = lastSnapshotCall()
  if (!call) throw new Error('No snapshot POST call found')
  return new URL(String(call[0]), 'http://localhost')
}

function lastSnapshotBody() {
  const call = lastSnapshotCall()
  if (!call) return undefined
  const init = call[1]
  if (typeof init?.body !== 'string') return undefined
  try { return JSON.parse(init.body) } catch { return undefined }
}

function mockWithSnapshotResponse(snapshotResponse: any) {
  mockFetch.mockImplementation((path, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'POST' && String(path).startsWith('/api/supplier/stock/import-snapshot')) {
      return Promise.resolve(snapshotResponse)
    }
    if (method !== 'GET') return Promise.resolve({})
    if (path === '/api/suppliers?status=ENABLED') return Promise.resolve(SUPPLIERS)
    return Promise.resolve({})
  })
}

function createExcelFile(name = 'snapshot.xlsx') {
  const content = new Uint8Array([1, 2, 3, 4])
  return new File([content], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

function setSheetData(data: unknown[][]) {
  mockXlsxUtils.sheet_to_json.mockReturnValue(data)
}

describe('全量库存盘点导入页', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation((path) => {
      if (path === '/api/suppliers?status=ENABLED') return Promise.resolve(SUPPLIERS)
      return Promise.resolve({})
    })
    mockXlsxUtils.sheet_to_json.mockReset()
    mockXlsxUtils.sheet_to_json.mockReturnValue([])
  })

  it('提交时 URL 显式携带 supplierId 与 warehouseId=default', async () => {
    setSheetData([
      ['商品名称', '规格', '分类', '单位', '目标数量'],
      ['苹果', '一级', '水果', 'kg', 12],
    ])
    mockWithSnapshotResponse({
      ok: true,
      summary: { total: 1, adjusted: 1, skipped: 0, failed: 0 },
      details: { adjusted: [{ row: 2, name: '苹果', oldStock: 5, newStock: 12 }], skipped: [], failed: [] },
      warehouseId: 'wh-real-001',
      warehouse: { id: 'wh-real-001', name: '默认总仓' },
    })

    const { container, root } = render(<InternalInventorySnapshotPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => Simulate.change(fileInput, { target: { files: [createExcelFile()] } as any }))
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '确认全量盘点导入 1 行')?.click())
    await waitFor(() => container.textContent?.includes('全量盘点导入成功') ?? false)

    const url = lastSnapshotUrl()
    expect(url.searchParams.get('supplierId')).toBe('sup-1')
    expect(url.searchParams.get('warehouseId')).toBe('default')

    const body = lastSnapshotBody()
    expect(body).toMatchObject({
      reason: expect.stringContaining('snapshot'),
      items: [{ name: '苹果', spec: '一级', category: '水果', unit: 'kg', qty: 12 }],
    })
    expect(body).not.toHaveProperty('warehouseId')

    cleanup(container, root)
  })

  it('body 不把仓库 alias 放进去', async () => {
    setSheetData([
      ['商品名称', '目标数量'],
      ['土豆', 20],
    ])
    mockWithSnapshotResponse({
      ok: true,
      summary: { total: 1, adjusted: 1, skipped: 0, failed: 0 },
      details: { adjusted: [{ row: 2, name: '土豆', oldStock: 0, newStock: 20 }] },
      warehouseId: 'wh-real-001',
      warehouse: { id: 'wh-real-001', name: '默认总仓' },
    })

    const { container, root } = render(<InternalInventorySnapshotPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => Simulate.change(fileInput, { target: { files: [createExcelFile()] } as any }))
    await waitFor(() => container.textContent?.includes('土豆') ?? false)

    act(() => findButton(container, '确认全量盘点导入 1 行')?.click())
    await waitFor(() => container.textContent?.includes('全量盘点导入成功') ?? false)

    const body = lastSnapshotBody()
    expect(body).toEqual({
      reason: expect.any(String),
      items: [{ name: '土豆', qty: 20 }],
    })

    cleanup(container, root)
  })

  it('解析并预览商品名称、规格、分类、单位和目标数量', async () => {
    setSheetData([
      ['商品名称', '规格', '分类', '单位', '数量'],
      ['香蕉', '二级', '水果', 'kg', 8.5],
      ['西红柿', '', '', '', 3],
    ])

    const { container, root } = render(<InternalInventorySnapshotPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => Simulate.change(fileInput, { target: { files: [createExcelFile('preview.xlsx')] } as any }))
    await waitFor(() => container.textContent?.includes('西红柿') ?? false)

    expect(container.textContent).toContain('香蕉')
    expect(container.textContent).toContain('二级')
    expect(container.textContent).toContain('水果')
    expect(container.textContent).toContain('kg')
    expect(container.textContent).toContain('8.5')
    expect(container.textContent).toContain('3')

    cleanup(container, root)
  })

  it('真实仓成功时显示仓名、adjusted/skipped 并清空预览', async () => {
    setSheetData([
      ['商品名称', '目标数量'],
      ['苹果', 10],
      ['梨', 20],
    ])
    mockWithSnapshotResponse({
      ok: true,
      summary: { total: 2, adjusted: 1, skipped: 1, failed: 0 },
      details: {
        adjusted: [{ row: 2, name: '苹果', oldStock: 0, newStock: 10 }],
        skipped: [{ row: 3, name: '梨', stock: 20 }],
        failed: [],
      },
      warehouseId: 'wh-real-002',
      warehouse: { id: 'wh-real-002', name: '城南仓' },
    })

    const { container, root } = render(<InternalInventorySnapshotPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => Simulate.change(fileInput, { target: { files: [createExcelFile('success.xlsx')] } as any }))
    await waitFor(() => container.textContent?.includes('梨') ?? false)

    act(() => findButton(container, '确认全量盘点导入 2 行')?.click())
    await waitFor(() => container.textContent?.includes('城南仓') ?? false)

    expect(container.textContent).toContain('全量盘点导入成功（城南仓）')
    expect(container.textContent).toContain('已调整 1 个 SKU')
    expect(container.textContent).toContain('跳过 1 个已是目标值的 SKU')
    expect(container.textContent).not.toContain('梨')

    cleanup(container, root)
  })

  it('部分失败时显示警告和每行 row/name/error，保留文件名、说明和全部预览', async () => {
    setSheetData([
      ['商品名称', '目标数量'],
      ['正常品', 30],
      ['漂移品', 90],
    ])
    mockWithSnapshotResponse({
      ok: true,
      summary: { total: 2, adjusted: 1, skipped: 0, failed: 1 },
      details: {
        adjusted: [{ row: 2, name: '正常品', oldStock: 10, newStock: 30 }],
        skipped: [],
        failed: [{ row: 2, name: '漂移品', error: 'Product.stock 与 WarehouseStock.physicalQty 不一致' }],
      },
      warehouseId: 'wh-real-001',
      warehouse: { id: 'wh-real-001', name: '默认总仓' },
    })

    const { container, root } = render(<InternalInventorySnapshotPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => Simulate.change(fileInput, { target: { files: [createExcelFile('partial.xlsx')] } as any }))
    await waitFor(() => container.textContent?.includes('漂移品') ?? false)

    const reasonInput = getInputByLabel(container, '本次盘点说明') as HTMLInputElement
    act(() => setInputValue(reasonInput, '月末盘点'))

    act(() => findButton(container, '确认全量盘点导入 2 行')?.click())
    await waitFor(() => container.textContent?.includes('部分导入失败') ?? false)

    expect(container.textContent).not.toContain('全量盘点导入成功')
    expect(container.textContent).toContain('partial.xlsx')
    expect(reasonInput.value).toBe('月末盘点')
    expect(container.textContent).toContain('正常品')
    expect(container.textContent).toContain('漂移品')
    expect(container.textContent).toContain('行 3 · 漂移品')
    expect(container.textContent).toContain('不一致')

    cleanup(container, root)
  })

  it('未建档 409 保留用户输入/预览，不显示成功', async () => {
    setSheetData([
      ['商品名称', '目标数量'],
      ['未知商品', 15],
    ])
    mockFetch.mockImplementation((path, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && String(path).startsWith('/api/supplier/stock/import-snapshot')) {
        const error = Object.assign(new Error('1 个品名尚未建档，请先在商品档案中建立并审批 SKU，库存未写入'), {
          status: 409,
          data: { code: 'UNMATCHED_STOCK_SKU' },
        })
        return Promise.reject(error)
      }
      if (path === '/api/suppliers?status=ENABLED') return Promise.resolve(SUPPLIERS)
      return Promise.resolve({})
    })

    const { container, root } = render(<InternalInventorySnapshotPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => Simulate.change(fileInput, { target: { files: [createExcelFile('unmatched.xlsx')] } as any }))
    await waitFor(() => container.textContent?.includes('未知商品') ?? false)

    act(() => findButton(container, '确认全量盘点导入 1 行')?.click())
    await waitFor(() => container.textContent?.includes('尚未建档') ?? false)

    expect(container.textContent).not.toContain('全量盘点导入成功')
    expect(container.textContent).toContain('未知商品')
    expect(container.textContent).toContain('unmatched.xlsx')

    cleanup(container, root)
  })

  it('响应仍返回 default 别名时视为失败，不清空预览', async () => {
    setSheetData([
      ['商品名称', '目标数量'],
      ['土豆', 50],
    ])
    mockWithSnapshotResponse({
      ok: true,
      summary: { total: 1, adjusted: 1, skipped: 0, failed: 0 },
      warehouseId: 'default',
      warehouse: { id: 'default', name: '默认仓' },
    })

    const { container, root } = render(<InternalInventorySnapshotPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => Simulate.change(fileInput, { target: { files: [createExcelFile('alias.xlsx')] } as any }))
    await waitFor(() => container.textContent?.includes('土豆') ?? false)

    act(() => findButton(container, '确认全量盘点导入 1 行')?.click())
    await waitFor(() => container.textContent?.includes('响应未返回真实仓库 ID') ?? false)

    expect(container.textContent).not.toContain('全量盘点导入成功')
    expect(container.textContent).toContain('土豆')

    cleanup(container, root)
  })

  it('响应仓库 ID 不一致时视为失败，保留用户输入', async () => {
    setSheetData([
      ['商品名称', '目标数量'],
      ['土豆', 50],
    ])
    mockWithSnapshotResponse({
      ok: true,
      summary: { total: 1, adjusted: 1, skipped: 0, failed: 0 },
      warehouseId: 'wh-a',
      warehouse: { id: 'wh-b', name: '问题仓' },
    })

    const { container, root } = render(<InternalInventorySnapshotPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => Simulate.change(fileInput, { target: { files: [createExcelFile('mismatch.xlsx')] } as any }))
    await waitFor(() => container.textContent?.includes('土豆') ?? false)

    const reasonInput = getInputByLabel(container, '本次盘点说明') as HTMLInputElement
    act(() => setInputValue(reasonInput, '测试说明'))

    act(() => findButton(container, '确认全量盘点导入 1 行')?.click())
    await waitFor(() => container.textContent?.includes('响应仓库 ID 不一致') ?? false)

    expect(container.textContent).not.toContain('全量盘点导入成功')
    expect(container.textContent).toContain('mismatch.xlsx')
    expect(reasonInput.value).toBe('测试说明')

    cleanup(container, root)
  })

  it('响应汇总数量不守恒时视为失败，保留预览且不宣称成功', async () => {
    setSheetData([
      ['商品名称', '目标数量'],
      ['土豆', 50],
    ])
    mockWithSnapshotResponse({
      ok: true,
      summary: { total: 2, adjusted: 1, skipped: 0, failed: 0 },
      warehouseId: 'wh-real-001',
      warehouse: { id: 'wh-real-001', name: '默认总仓' },
    })

    const { container, root } = render(<InternalInventorySnapshotPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => Simulate.change(fileInput, { target: { files: [createExcelFile('invalid-summary.xlsx')] } as any }))
    await waitFor(() => container.textContent?.includes('土豆') ?? false)

    act(() => findButton(container, '确认全量盘点导入 1 行')?.click())
    await waitFor(() => container.textContent?.includes('盘点响应汇总无效') ?? false)

    expect(container.textContent).not.toContain('全量盘点导入成功')
    expect(container.textContent).toContain('invalid-summary.xlsx')
    expect(container.textContent).toContain('土豆')

    cleanup(container, root)
  })

  it('重复品名、空名、非法数量在提交前阻断', async () => {
    setSheetData([
      ['商品名称', '目标数量'],
      ['苹果', -5],
      ['', 0],
      ['苹果', 7],
      ['梨', 1.234],
    ])

    const { container, root } = render(<InternalInventorySnapshotPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => Simulate.change(fileInput, { target: { files: [createExcelFile('invalid.xlsx')] } as any }))
    await waitFor(() => container.textContent?.includes('梨') ?? false)

    expect(container.textContent).toContain('目标数量不能为负数')
    expect(container.textContent).toContain('商品名称不能为空')
    expect(container.textContent).toContain('品名重复，同一商品只能保留一行')
    expect(container.textContent).toContain('目标数量最多保留 2 位小数')

    const submitButton = findButton(container, '确认全量盘点导入 0 行')
    expect(submitButton?.hasAttribute('disabled')).toBe(true)

    cleanup(container, root)
  })

  it('切换供应商后提交使用新的 supplierId', async () => {
    setSheetData([
      ['商品名称', '目标数量'],
      ['苹果', 10],
    ])
    mockFetch.mockImplementation((path, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && String(path).startsWith('/api/supplier/stock/import-snapshot')) {
        return Promise.resolve({
          ok: true,
          summary: { total: 1, adjusted: 1, skipped: 0, failed: 0 },
          details: { adjusted: [{ row: 2, name: '苹果', oldStock: 0, newStock: 10 }] },
          warehouseId: 'wh-real-001',
          warehouse: { id: 'wh-real-001', name: '默认总仓' },
        })
      }
      if (method !== 'GET') return Promise.resolve({})
      if (path === '/api/suppliers?status=ENABLED') return Promise.resolve(SUPPLIERS)
      return Promise.resolve({})
    })

    const { container, root } = render(<InternalInventorySnapshotPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const supplierSelect = Array.from(container.querySelectorAll('select')).find(
      s => Array.from(s.options).some(o => o.value === 'sup-2'),
    )!
    act(() => setSelectValue(supplierSelect, 'sup-2'))

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => Simulate.change(fileInput, { target: { files: [createExcelFile()] } as any }))
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    act(() => findButton(container, '确认全量盘点导入 1 行')?.click())
    await waitFor(() => container.textContent?.includes('全量盘点导入成功') ?? false)

    expect(lastSnapshotUrl().searchParams.get('supplierId')).toBe('sup-2')

    cleanup(container, root)
  })

  it('提交中禁用重复提交', async () => {
    setSheetData([
      ['商品名称', '目标数量'],
      ['苹果', 10],
    ])
    let callCount = 0
    mockFetch.mockImplementation((path, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && String(path).startsWith('/api/supplier/stock/import-snapshot')) {
        callCount++
        return new Promise(resolve => {
          setTimeout(() => {
            resolve({
              ok: true,
              summary: { total: 1, adjusted: 1, skipped: 0, failed: 0 },
              details: { adjusted: [{ row: 2, name: '苹果', oldStock: 0, newStock: 10 }] },
              warehouseId: 'wh-real-001',
              warehouse: { id: 'wh-real-001', name: '默认总仓' },
            })
          }, 100)
        })
      }
      if (path === '/api/suppliers?status=ENABLED') return Promise.resolve(SUPPLIERS)
      return Promise.resolve({})
    })

    const { container, root } = render(<InternalInventorySnapshotPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    act(() => Simulate.change(fileInput, { target: { files: [createExcelFile()] } as any }))
    await waitFor(() => container.textContent?.includes('苹果') ?? false)

    const submitButton = findButton(container, '确认全量盘点导入 1 行')
    act(() => submitButton?.click())
    act(() => submitButton?.click())

    await waitFor(() => container.textContent?.includes('全量盘点导入成功') ?? false)
    expect(callCount).toBe(1)

    cleanup(container, root)
  })
})
