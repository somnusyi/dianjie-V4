// @vitest-environment jsdom
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import HomePage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const STORES = [
  { id: 'store-1', no: 'S01', name: '瑶海店' },
  { id: 'store-2', no: 'S02', name: '政务店' },
]

const ORDERS = [
  {
    id: 'o-1',
    no: 'PO-001',
    status: 'SUBMITTED',
    totalAmount: 1200,
    createdAt: '2026-08-01T08:00:00Z',
    expectedDate: '2026-08-03',
    store: { id: 'store-1', name: '瑶海店' },
    supplier: { id: 'sup-1', name: '昆明蔬菜批发' },
    items: [{ productNameSnapshot: '土豆' }, { productNameSnapshot: '白菜' }],
  },
  {
    id: 'o-2',
    no: 'PO-002',
    status: 'CONFIRMED',
    totalAmount: 3400,
    createdAt: '2026-08-01T09:00:00Z',
    expectedDate: '2026-08-04',
    store: { id: 'store-2', name: '政务店' },
    supplier: { id: 'sup-2', name: '大理水产' },
    items: [{ productNameSnapshot: '鲈鱼' }],
  },
  {
    id: 'o-3',
    no: 'PO-003',
    status: 'DELIVERING',
    totalAmount: 5600,
    createdAt: '2026-08-01T10:00:00Z',
    expectedDate: '2026-08-02',
    store: { id: 'store-1', name: '瑶海店' },
    supplier: { id: 'sup-1', name: '昆明蔬菜批发' },
    items: [{ productNameSnapshot: '番茄' }, { productNameSnapshot: '黄瓜' }],
  },
  {
    id: 'o-4',
    no: 'PO-004',
    status: 'PENDING_CONFIRM',
    totalAmount: 890,
    createdAt: '2026-08-01T07:00:00Z',
    expectedDate: '2026-08-01',
    store: { id: 'store-2', name: '政务店' },
    supplier: { id: 'sup-3', name: '曲靖肉禽' },
    items: [{ productNameSnapshot: '鸡胸肉' }],
  },
]

const DIFFS = [
  {
    id: 'd-1',
    no: 'DF-001',
    status: 'PENDING',
    createdAt: '2026-08-01T11:00:00Z',
    store: { name: '瑶海店' },
    supplier: { name: '昆明蔬菜批发' },
  },
]

vi.mock('@/components/v2', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span data-chip="true">{children}</span>,
  TodoCard: ({ tone, chips, title, sub, primary }: {
    tone: string
    chips?: { label: string; tone?: string }[]
    title: string
    sub?: string
    primary?: { label: string; onClick: () => void }
  }) => (
    <div data-todo-tone={tone} data-todo-title={title}>
      {chips?.map((c, i) => <span key={i} data-chip-tone={c.tone}>{c.label}</span>)}
      {sub && <span data-todo-sub={sub} />}
      {primary && <button data-todo-action={primary.label} onClick={primary.onClick}>{primary.label}</button>}
    </div>
  ),
}))

vi.mock('@/components/v2/glance-strip', () => ({
  GlanceStrip: (props: any) => (
    <div data-glance="true">
      <span data-glance-label={props.label} />
      <span data-glance-value={props.value} />
      {props.stats?.map((s: any, i: number) => (
        <span key={i} data-stat-label={s.label} data-stat-value={s.value} />
      ))}
    </div>
  ),
}))

vi.mock('@/components/v2/user-menu', () => ({
  UserMenu: () => <button data-user-menu="true">用户</button>,
}))

vi.mock('@/components/v2/use-dashboard', () => ({
  useDashboard: () => ({
    data: {
      role: 'SUPPLY_CHAIN',
      user: { id: 'u-1', name: '测试用户', role: 'SUPPLY_CHAIN' },
      supplyChain: {
        readOnly: true,
        stores: STORES,
        counts: { orders: 4, deliveries: 1, receipts: 3 },
      },
    },
    error: null,
  }),
  LoadingScreen: () => <div data-loading="true">加载中</div>,
  ErrorScreen: ({ message }: { message: string }) => <div data-error="true">{message}</div>,
  greetingFor: (name?: string) => ({
    greeting: `早上好，${name || '用户'}`,
    today: '周一 · 08/02',
  }),
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

async function waitFor(predicate: () => boolean, timeout = 1000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

function resourceCalls(prefix: string) {
  return mockFetch.mock.calls.filter(([path]) => String(path).startsWith(prefix))
}

describe('内部供应链移动端工作台', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation(async (path) => {
      if (String(path).startsWith('/api/orders')) return { items: ORDERS }
      if (String(path).startsWith('/api/loss-claims')) return { items: DIFFS }
      if (String(path).startsWith('/api/warehouse-inventory')) {
        return {
          summary: { totalSku: 120 },
          items: [
            { statusFlag: 'LOW' }, { statusFlag: 'LOW' }, { statusFlag: 'LOW' },
            { statusFlag: 'OUT' }, { statusFlag: 'OK' },
          ],
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })
  })

  it('加载时请求订单、差异、库存摘要', async () => {
    const { container, root } = render(<HomePage />)
    await waitFor(() => resourceCalls('/api/orders').length >= 1)

    expect(resourceCalls('/api/orders').length).toBe(1)
    expect(resourceCalls('/api/loss-claims').length).toBe(1)
    expect(resourceCalls('/api/warehouse-inventory').length).toBe(1)

    cleanup(container, root)
  })

  it('渲染紧凑问候与标题，不渲染巨大标题', async () => {
    const { container, root } = render(<HomePage />)
    await waitFor(() => container.textContent?.includes('供应链工作台') ?? false)

    expect(container.textContent).toContain('早上好，测试用户')
    expect(container.textContent).toContain('供应链工作台')
    expect(container.textContent).toContain('周一 · 08/02')

    // 不应有旧版巨大标题
    expect(container.textContent).not.toContain('内部供应链工作台')

    cleanup(container, root)
  })

  it('渲染 GlanceStrip 与关键统计', async () => {
    const { container, root } = render(<HomePage />)
    await waitFor(() => container.querySelector('[data-glance="true"]') !== null)

    const glance = container.querySelector('[data-glance="true"]')
    expect(glance).not.toBeNull()

    cleanup(container, root)
  })

  it('待办区渲染订单待办与差异待办', async () => {
    const { container, root } = render(<HomePage />)
    await waitFor(() => container.querySelectorAll('[data-todo-tone]').length > 0)

    const todos = container.querySelectorAll('[data-todo-tone]')
    expect(todos.length).toBeGreaterThanOrEqual(1)

    // 应包含待接单、待发货、配送中
    const titles = Array.from(todos).map(el => el.getAttribute('data-todo-title'))
    expect(titles.some(t => t?.includes('昆明蔬菜批发'))).toBe(true)
    expect(titles.some(t => t?.includes('大理水产'))).toBe(true)

    cleanup(container, root)
  })

  it('待办计数显示为红色提示', async () => {
    const { container, root } = render(<HomePage />)
    await waitFor(() => container.textContent?.includes('项需处理') ?? false)

    // 3 单待处理 (submitted + confirmed + delivering)
    expect(container.textContent).toContain('3 项需处理')

    cleanup(container, root)
  })

  it('常用入口 2×2 网格包含 4 个真实路由', async () => {
    const { container, root } = render(<HomePage />)
    await waitFor(() => container.textContent?.includes('订单中心') ?? false)

    const links = Array.from(container.querySelectorAll('a'))
    const hrefs = links.map(a => a.getAttribute('href'))

    expect(hrefs).toContain('/v2/supply-chain/fulfillment')
    expect(hrefs).toContain('/v2/supply-chain/stores')
    expect(hrefs).toContain('/v2/supply-chain/inventory')
    expect(hrefs).toContain('/v2/supply-chain/products')

    cleanup(container, root)
  })

  it('更多区包含二级功能真实路由', async () => {
    const { container, root } = render(<HomePage />)
    await waitFor(() => container.textContent?.includes('到货差异') ?? false)

    const links = Array.from(container.querySelectorAll('a'))
    const hrefs = links.map(a => a.getAttribute('href'))

    expect(hrefs).toContain('/v2/supply-chain/differences')
    expect(hrefs).toContain('/v2/supply-chain/suppliers')
    expect(hrefs).toContain('/v2/supply-chain/billing')
    expect(hrefs).toContain('/v2/supply-chain/analytics')
    expect(hrefs).toContain('/v2/supply-chain/receipts')
    expect(hrefs).toContain('/v2/supply-chain/orders')

    cleanup(container, root)
  })

  it('库存健康摘要渲染低库存与缺货', async () => {
    const { container, root } = render(<HomePage />)
    await waitFor(() => container.textContent?.includes('库存健康') ?? false)

    expect(container.textContent).toContain('120 个 SKU')
    expect(container.textContent).toContain('3 个低库存')
    expect(container.textContent).toContain('1 个缺货')

    cleanup(container, root)
  })

  it('页面本身不渲染底部导航，由供应链壳层统一提供', async () => {
    const { container, root } = render(<HomePage />)
    await waitFor(() => resourceCalls('/api/orders').length >= 1)

    expect(container.querySelector('[data-bottom-nav="true"]')).toBeNull()

    cleanup(container, root)
  })

  it('空待办时展示无加急提示', async () => {
    mockFetch.mockImplementation(async (path) => {
      if (String(path).startsWith('/api/orders')) return { items: [] }
      if (String(path).startsWith('/api/loss-claims')) return { items: [] }
      if (String(path).startsWith('/api/warehouse-inventory')) {
        return { summary: { totalSku: 120 }, items: [{ statusFlag: 'OK' }] }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const { container, root } = render(<HomePage />)
    await waitFor(() => container.textContent?.includes('今日无加急') ?? false)

    expect(container.textContent).toContain('今日无加急')

    cleanup(container, root)
  })
})
