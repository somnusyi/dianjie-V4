// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import InternalSupplyChainInventoryPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/v2', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

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

async function waitFor(predicate: () => boolean, timeout = 1000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

describe('内部供应链仓库库存', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation(async path => {
      const url = String(path)
      if (url === '/api/suppliers?status=ENABLED') {
        return [{ id: 'supplier-1', no: 'SUP001', name: '测试供应商' }]
      }
      if (url.startsWith('/api/supplier/stock?page=')) {
        return {
          items: [{
            id: 'product-1', code: 'SKU001', name: '香菇', unit: 'kg', inventoryUnit: 'g',
            stock: 0, reservedStock: 0, availableStock: 0, minStock: 0, statusFlag: 'OUT',
          }],
        }
      }
      if (url.startsWith('/api/supplier/stock/summary?')) {
        return {
          inventoryMode: 'NOT_TRACKED', totalSku: 1, lowStock: 0, outOfStock: 1,
          totalValue: 0, warehouse: { id: 'default', name: '默认仓' },
        }
      }
      if (url.startsWith('/api/supplier/stock/movements?')) return []
      throw new Error(`unexpected path: ${path}`)
    })
  })

  it('库存尚未严格启用时仍允许手工和 Excel 建账入库', async () => {
    const { container, root } = render(<InternalSupplyChainInventoryPage />)
    await waitFor(() => container.textContent?.includes('当前处于库存建账阶段') ?? false)

    const manualButton = Array.from(container.querySelectorAll('button')).find(
      button => button.textContent?.trim() === '+ 手工入库',
    ) as HTMLButtonElement
    expect(manualButton).toBeTruthy()
    expect(manualButton.disabled).toBe(false)

    const excelLink = Array.from(container.querySelectorAll('a')).find(
      link => link.textContent?.trim() === 'Excel 批量入库',
    ) as HTMLAnchorElement
    expect(excelLink.getAttribute('aria-disabled')).toBe('false')
    expect(excelLink.className).not.toContain('pointer-events-none')
    expect(excelLink.getAttribute('href')).toBe('/v2/supply-chain/inventory/import?supplierId=supplier-1')

    act(() => manualButton.click())
    expect(container.textContent).toContain('确认入库')
    expect(container.textContent).toContain('SKU001 · 香菇')

    cleanup(container, root)
  })
})
