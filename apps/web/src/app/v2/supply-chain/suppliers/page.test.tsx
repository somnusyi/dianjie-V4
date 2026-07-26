// @vitest-environment jsdom
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'

import SuppliersPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/v2', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span data-chip="true">{children}</span>,
}))

vi.mock('@/components/v2/skeleton', () => ({
  SkeletonList: ({ count }: { count?: number }) => <div data-skeleton="true">骨架 ×{count}</div>,
  EmptyState: ({ title, hint }: { title: string; hint?: string }) => (
    <div data-empty="true">
      <div data-empty-title="true">{title}</div>
      {hint && <div data-empty-hint="true">{hint}</div>}
    </div>
  ),
  FriendlyError: ({ message, onRetry }: { message?: string; onRetry?: () => void }) => (
    <div data-error="true">
      <span data-error-message="true">{message}</span>
      {onRetry && (
        <button data-retry="true" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  ),
}))

vi.mock('@/components/v2/confirm-sheet', () => ({
  useConfirmSheet: () => [
    { open: false, title: '', close: vi.fn() },
    vi.fn(),
  ],
  ConfirmSheet: () => null,
}))

vi.mock('@/lib/v2-auth', () => ({
  apiFetch: vi.fn(),
}))

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
  return Array.from(container.querySelectorAll('button')).find(
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

function setInputValue(input: HTMLInputElement, value: string) {
  Simulate.change(input, { target: { value } as any })
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  Simulate.change(select, { target: { value } as any })
}

function resourceCalls(prefix: string) {
  return mockFetch.mock.calls.filter(([path]) => String(path).startsWith(prefix))
}

const SUPPLIERS = [
  {
    id: 'sup-1',
    no: 'SUP001',
    name: '昆明蔬菜批发',
    status: 'ENABLED',
    contactName: '张三',
    contactPhone: '13800138000',
    creditType: 'FIXED_DAYS',
    creditDays: 30,
    category: '蔬菜',
    createdAt: '2026-07-01T00:00:00Z',
  },
  {
    id: 'sup-2',
    no: 'SUP002',
    name: '大理水产',
    status: 'DISABLED',
    contactName: null,
    contactPhone: null,
    creditType: 'FIXED_DAYS',
    creditDays: null,
    category: null,
    createdAt: '2026-07-02T00:00:00Z',
  },
]

const SENSITIVE_SUBSTRINGS = ['银行', '账号', '密钥', 'autoPay', '付款', '对账']

describe('供应商管理 PC 页面', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('首次加载请求 /api/suppliers 并渲染编号、名称、状态、联系人、电话、账期', async () => {
    mockFetch.mockResolvedValue(SUPPLIERS)

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const calls = resourceCalls('/api/suppliers')
    expect(calls.length).toBe(1)
    expect(String(calls[0][0])).toBe('/api/suppliers')

    expect(container.textContent).toContain('SUP001')
    expect(container.textContent).toContain('昆明蔬菜批发')
    expect(container.textContent).toContain('启用中')
    expect(container.textContent).toContain('张三')
    expect(container.textContent).toContain('13800138000')
    expect(container.textContent).toContain('30 天')

    expect(container.textContent).toContain('SUP002')
    expect(container.textContent).toContain('大理水产')
    expect(container.textContent).toContain('已停用')

    cleanup(container, root)
  })

  it('按名称搜索后本地过滤，不重新请求', async () => {
    mockFetch.mockResolvedValue(SUPPLIERS)

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    mockFetch.mockClear()
    const keywordInput = getInputByLabel(container, '关键字') as HTMLInputElement
    act(() => { setInputValue(keywordInput, '水产') })

    await waitFor(() => !container.textContent?.includes('昆明蔬菜批发'))
    expect(container.textContent).toContain('大理水产')
    expect(resourceCalls('/api/suppliers')).toHaveLength(0)

    cleanup(container, root)
  })

  it('按状态筛选后本地过滤，不重新请求', async () => {
    mockFetch.mockResolvedValue(SUPPLIERS)

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('大理水产') ?? false)

    mockFetch.mockClear()
    const statusSelect = getInputByLabel(container, '状态') as HTMLSelectElement
    act(() => { setSelectValue(statusSelect, 'ENABLED') })

    await waitFor(() => !container.textContent?.includes('大理水产'))
    expect(container.textContent).toContain('昆明蔬菜批发')
    expect(resourceCalls('/api/suppliers')).toHaveLength(0)

    cleanup(container, root)
  })

  it('缺失联系人与账期时展示占位符', async () => {
    mockFetch.mockResolvedValue([SUPPLIERS[1]])

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('大理水产') ?? false)

    const cells = Array.from(container.querySelectorAll('td'))
    const contactCell = cells.find(td => td.textContent?.includes('联系人') === false && td.textContent?.trim() === '—')
    expect(contactCell).toBeDefined()
    expect(container.textContent).toContain('—')

    cleanup(container, root)
  })

  it('点击列表行展示详情区，商品数量显示“待接入”', async () => {
    mockFetch.mockResolvedValue(SUPPLIERS)

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const row = Array.from(container.querySelectorAll('tr')).find(
      tr => tr.textContent?.includes('昆明蔬菜批发'),
    )!
    act(() => { Simulate.click(row) })

    await waitFor(() => container.textContent?.includes('供应商档案'))
    expect(container.textContent).toContain('商品数量')
    expect(container.textContent).toContain('待接入')

    cleanup(container, root)
  })

  it('不渲染银行账号、密钥、付款等敏感字段', async () => {
    mockFetch.mockResolvedValue([
      {
        ...SUPPLIERS[0],
        bankName: '测试银行',
        bankAccount: 'TEST-FAKE-ACCOUNT-NUMBER',
        bankAccountName: '测试户名',
        bankCode: 'TEST-FAKE-CODE',
        autoPay: true,
      },
    ])

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const text = container.textContent ?? ''
    for (const term of SENSITIVE_SUBSTRINGS) {
      expect(text).not.toContain(term)
    }
    expect(text).not.toContain('6222')
    expect(text).not.toContain('测试银行')

    cleanup(container, root)
  })

  it('空列表展示空态', async () => {
    mockFetch.mockResolvedValue([])

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.querySelector('[data-empty-title]') !== null)
    expect(container.querySelector('[data-empty-title]')?.textContent).toContain('暂无供应商')

    cleanup(container, root)
  })

  it('搜索无匹配时展示空态并提示调整筛选', async () => {
    mockFetch.mockResolvedValue(SUPPLIERS)

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    const keywordInput = getInputByLabel(container, '关键字') as HTMLInputElement
    act(() => { setInputValue(keywordInput, '不存在') })

    await waitFor(() => container.querySelector('[data-empty-title]') !== null)
    expect(container.querySelector('[data-empty-title]')?.textContent).toContain('没有匹配的供应商')
    expect(container.querySelector('[data-empty-hint]')?.textContent).toContain('调整筛选条件')

    cleanup(container, root)
  })

  it('加载失败展示错误态并可重试', async () => {
    let shouldFail = true
    mockFetch.mockImplementation(() => {
      if (shouldFail) return Promise.reject(new Error('network failure'))
      return Promise.resolve(SUPPLIERS)
    })

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => container.querySelector('[data-error-message]') !== null)
    expect(container.querySelector('[data-error-message]')?.textContent).toContain('network failure')

    shouldFail = false
    act(() => (container.querySelector('[data-retry]') as HTMLButtonElement).click())
    await waitFor(() => container.textContent?.includes('昆明蔬菜批发') ?? false)

    expect(resourceCalls('/api/suppliers').length).toBeGreaterThanOrEqual(2)

    cleanup(container, root)
  })

  it('卸载时取消未完成的请求', async () => {
    let abortReason: string | undefined
    mockFetch.mockImplementation((_path, init) => {
      const signal = init?.signal
      if (signal?.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'))
      }
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          abortReason = String(signal.reason)
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    })

    const { container, root } = render(<SuppliersPage />)
    await waitFor(() => resourceCalls('/api/suppliers').length >= 1)

    cleanup(container, root)
    await sleep(30)
    expect(abortReason).toBeDefined()
  })
})
