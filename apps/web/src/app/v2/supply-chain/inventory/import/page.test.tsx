// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WarehouseSnapshotImportPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/v2', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span data-chip="true">{children}</span>,
}))

vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

const product = {
  id: 'product-1', code: 'DJ001', name: '测试袋装品', status: 'ENABLED', unit: '箱',
  purchaseUnit: '箱', inventoryUnit: '袋', stock: 400, supplierId: 'supplier-1',
  supplier: { id: 'supplier-1', name: '测试供应商' },
}

function importRecord(resolved = false) {
  return {
    id: 'import-1', no: 'WSI-20260731-ABCDEF12', source: 'MEITUAN', sourceFilename: '供应链7.31日库存.xlsx',
    sourceWarehouseName: '供应链总仓', snapshotDate: '2026-07-31', status: 'STAGED', itemCount: 1,
    ignoredRowCount: 0, matchedCount: resolved ? 1 : 0, blockingCount: resolved ? 0 : 1, warningCount: 0,
    detailTotalAmount: 100, sourceTotalAmount: 100, rowVersion: resolved ? 1 : 0,
    warehouse: { id: 'warehouse-1', name: '默认仓', code: 'default' },
    items: [{
      id: 'item-1', rowNumber: 4, externalCode: 'ZBWP0950', externalName: '测试袋装品',
      sourceSpec: '8袋/箱', sourceCategory: '干货', purchaseUnit: '箱', conversionText: '1箱=8袋',
      sourceQuantity: 54.875, inventoryAmount: 100, inventoryUnit: '袋', conversionFactor: 8,
      normalizedQuantity: 439, matchSource: resolved ? 'EXTERNAL_MAPPING' : 'NAME_SUGGESTION', product,
      issues: resolved ? [] : [{ code: 'EXTERNAL_CODE_REVIEW_REQUIRED', message: '名称相同仅作为候选' }], warnings: [],
    }],
  }
}

function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<WarehouseSnapshotImportPage />))
  return { container, root }
}

async function waitFor(predicate: () => boolean, timeout = 1000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

describe('美团期初库存基线导入页面', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    Object.defineProperty(window, 'confirm', {
      configurable: true,
      writable: true,
      value: vi.fn(() => true),
    })
    let current = importRecord(false)
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url === '/api/products') return Promise.resolve([product])
      if (url === '/api/warehouse-inventory-imports') return Promise.resolve({ items: [current] })
      if (url.endsWith('/resolve-name-suggestions') && init?.method === 'POST') {
        current = importRecord(true)
        return Promise.resolve(current)
      }
      if (url === '/api/warehouse-inventory-imports/import-1') return Promise.resolve(current)
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
  })

  it('clearly separates source receiving units from normalized inventory units', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('测试袋装品') ?? false)

    expect(container.textContent).toContain('“入库单位”是什么意思？')
    expect(container.textContent).toContain('54.875 箱 × 8 袋/箱 = 439 袋')
    expect(container.textContent).toContain('54.875 箱')
    expect(container.textContent).toContain('439 袋')
    expect(container.textContent).toContain('当前 400 袋')
    expect(container.textContent).toContain('调整 +39')

    act(() => root.unmount())
    container.remove()
  })

  it('requires explicit bulk confirmation before saving exact-name external-code mappings', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('批量确认同名候选 1') ?? false)

    const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.includes('批量确认同名候选'))
    await act(async () => { button?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path]) => String(path).endsWith('/resolve-name-suggestions')))

    const call = mockFetch.mock.calls.find(([path]) => String(path).endsWith('/resolve-name-suggestions'))
    expect(call?.[1]?.method).toBe('POST')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ rowVersion: 0 })

    act(() => root.unmount())
    container.remove()
  })

  it('applies an eligible staged import through the baseline endpoint and reloads durable state', async () => {
    let current: any = importRecord(true)
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url === '/api/products') return Promise.resolve([product])
      if (url === '/api/warehouse-inventory-imports') return Promise.resolve({ items: [current] })
      if (url === '/api/warehouse-inventory-imports/import-1') return Promise.resolve(current)
      if (url === '/api/warehouse-inventory-imports/import-1/baseline' && init?.method === 'POST') {
        current = { ...current, status: 'CONFIRMED', rowVersion: 2, confirmedAt: '2026-08-02T10:00:00.000Z' }
        return Promise.resolve({
          ok: true,
          importId: current.id,
          importNo: current.no,
          warehouseId: 'warehouse-1',
          snapshotAt: '2026-07-31T15:59:59.999Z',
          createdCount: 1,
          adjustedCount: 0,
          items: [],
        })
      }
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })

    const { container, root } = renderPage()
    let button: HTMLButtonElement | undefined
    await waitFor(() => {
      button = Array.from(container.querySelectorAll('button'))
        .find(item => item.textContent?.includes('建立期初基线'))
      return Boolean(button && !button.disabled)
    })

    await act(async () => { button!.click() })
    expect(vi.mocked(window.confirm)).toHaveBeenCalledWith(expect.stringContaining('期初基线'))
    await waitFor(() => mockFetch.mock.calls.some(([path]) => String(path).endsWith('/baseline')))
    await waitFor(() => container.textContent?.includes('期初基线已生效') ?? false)

    const call = mockFetch.mock.calls.find(([path]) => String(path).endsWith('/baseline'))
    expect(call?.[1]?.method).toBe('POST')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ rowVersion: 1 })
    expect(mockFetch.mock.calls.some(([path]) => String(path).endsWith('/confirm'))).toBe(false)
    expect(container.textContent).toContain('已生效')

    act(() => root.unmount())
    container.remove()
  })
})
