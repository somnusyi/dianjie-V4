// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SupplierUpstreamPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)
const order = {
  id: 'order-1', no: 'CG-001', status: 'SUBMITTED_TO_SUPPLIER', totalAmount: 120,
  expectedArrivalAt: '2026-09-29', warehouse: { id: 'warehouse-1', name: '总仓' }, _count: { lines: 1, shipments: 0, receipts: 0 },
}
const statement = {
  id: 'statement-1', no: 'DZ-001', status: 'SENT_TO_SUPPLIER', periodStart: '2026-09-01', periodEnd: '2026-09-30',
  receiptAmount: 120, deductionAmount: 5, payableAmount: 115, version: 1, _count: { lines: 1, invoiceAllocations: 0 },
}

function installApi(acceptResult: () => Promise<unknown> = () => Promise.resolve({ ok: true })) {
  mockFetch.mockImplementation((path, init) => {
    const url = String(path)
    if (url === '/api/upstream/purchase-orders' && !init) return Promise.resolve([order])
    if (url === '/api/upstream/shipments' && !init) return Promise.resolve([])
    if (url === '/api/upstream/arrival-claims' && !init) return Promise.resolve([])
    if (url === '/api/upstream/settlement-statements' && !init) return Promise.resolve([statement])
    if (url === '/api/upstream/purchase-orders/order-1/accept' && init?.method === 'POST') return acceptResult()
    if (url === '/api/upstream/settlement-statements/statement-1/dispute' && init?.method === 'POST') return Promise.resolve({ ok: true })
    return Promise.reject(new Error(`unexpected API: ${url}`))
  })
}

function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<SupplierUpstreamPage />))
  return { container, root }
}

async function waitFor(predicate: () => boolean, timeout = 1000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

function setTextarea(textarea: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

  beforeEach(() => {
    mockFetch.mockReset()
    Element.prototype.scrollIntoView = vi.fn()
    window.location.hash = ''
  })

describe('供应商上游确认层', () => {

  it('取消不接单，确认双击也只提交一次', async () => {
    installApi()
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('CG-001') ?? false)

    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认接单')?.click())
    const backdrop = container.querySelector('[data-testid="confirm-sheet-backdrop"]') as HTMLElement
    act(() => (backdrop.querySelectorAll('button')[0] as HTMLButtonElement).click())
    expect(mockFetch.mock.calls.filter(([path]) => String(path).endsWith('/accept'))).toHaveLength(0)

    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认接单')?.click())
    const confirm = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认接单' && button.closest('[role="dialog"]')) as HTMLButtonElement
    await act(async () => { confirm.click(); confirm.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path]) => String(path).endsWith('/accept')))
    expect(mockFetch.mock.calls.filter(([path]) => String(path).endsWith('/accept'))).toHaveLength(1)

    act(() => root.unmount())
    container.remove()
  })

  it('后端失败原因直接显示在当前确认层', async () => {
    installApi(() => Promise.reject(new Error('供应商账号已停用')))
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('CG-001') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认接单')?.click())
    const confirm = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认接单' && button.closest('[role="dialog"]')) as HTMLButtonElement
    await act(async () => { confirm.click() })
    await waitFor(() => container.querySelector('[role="dialog"] [role="alert"]')?.textContent?.includes('供应商账号已停用') ?? false)

    act(() => root.unmount())
    container.remove()
  })

  it('对账异议必须填写理由并原样提交', async () => {
    installApi()
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('CG-001') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '月度对账')?.click())
    await waitFor(() => container.textContent?.includes('DZ-001') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '提出异议')?.click())
    const submit = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '提交异议') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    act(() => setTextarea(container.querySelector('textarea') as HTMLTextAreaElement, '扣款金额需要复核'))
    await act(async () => { submit.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path]) => String(path).endsWith('/dispute')))
    const call = mockFetch.mock.calls.find(([path]) => String(path).endsWith('/dispute'))
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ reason: '扣款金额需要复核' })

    act(() => root.unmount())
    container.remove()
  })
})

it('在长列表中打开明细会滚动到展开面板，不再留在列表底部', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  installApi()
  const base = mockFetch.getMockImplementation()!
  mockFetch.mockImplementation((path, init) => String(path) === '/api/upstream/purchase-orders/order-1' ? Promise.resolve({ ...order, lines: [] }) : base(path, init))
  const { container, root } = renderPage()
  try {
    await waitFor(() => Boolean(container.querySelector('[aria-label="查看采购单 CG-001 明细"]')))
    await act(async () => (container.querySelector('[aria-label="查看采购单 CG-001 明细"]') as HTMLButtonElement).click())
    await waitFor(() => Boolean(container.textContent?.includes('采购单明细 · CG-001')))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
  } finally { act(() => root.unmount()); container.remove() }
})

it('手机底栏同页切换及浏览器返回时同步显示对应业务页签', async () => {
  installApi()
  const { container, root } = renderPage()
  try {
    await waitFor(() => Boolean(container.textContent?.includes('CG-001')))
    await act(async () => { window.location.hash = '#settlements'; window.dispatchEvent(new Event('hashchange')) })
    await waitFor(() => Boolean(container.textContent?.includes('DZ-001')))
    await act(async () => { window.location.hash = '#orders'; window.dispatchEvent(new Event('hashchange')) })
    await waitFor(() => Boolean(container.textContent?.includes('CG-001')))
  } finally { act(() => root.unmount()); container.remove() }
})
