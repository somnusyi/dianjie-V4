// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BillingPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/v2', () => ({
  Chip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

async function waitFor(predicate: () => boolean) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status })
}

afterEach(() => {
  document.body.replaceChildren()
  vi.clearAllMocks()
})

// ── 测试数据（金额沿用后端 Decimal 字符串形态）──────────────────
const scheduleList = [
  { id: 's1', amount: 600, status: 'PAID', dueAt: '2026-06-13', paidAt: '2026-06-12', supplier: { name: '供应商A' }, receipt: { no: 'RK001', deliveryDate: '2026-05-14', store: { name: '门店一' } } },
  { id: 's2', amount: 400, status: 'PENDING', dueAt: '2026-07-01', paidAt: null, supplier: { name: '供应商B' }, receipt: { no: 'RK002', deliveryDate: '2026-05-20', store: { name: '门店二' } } },
]
const scheduleDetailS1 = {
  id: 's1', amount: '600', status: 'PAID', dueAt: '2026-06-13T00:00:00.000Z', paidAt: '2026-06-12T00:00:00.000Z',
  supplier: { id: 'sup-a', name: '供应商A' },
  receipt: { id: 'r1', no: 'RK001', deliveryDate: '2026-05-14T00:00:00.000Z', totalAmount: '600', store: { id: 'st1', name: '门店一' } },
}
const scheduleDetailS2 = {
  id: 's2', amount: '400', status: 'PENDING', dueAt: '2026-07-01T00:00:00.000Z', paidAt: null,
  supplier: { id: 'sup-b', name: '供应商B' },
  receipt: { id: 'r2', no: 'RK002', deliveryDate: '2026-05-20T00:00:00.000Z', totalAmount: '400', store: { id: 'st2', name: '门店二' } },
}
const reconciliationList = [
  { id: 'rec1', no: 'DC2026050001', totalAmount: 1000, status: 'DRAFT', periodStart: '2026-05-01', periodEnd: '2026-05-31', supplier: { name: '供应商A', no: 'SUP001' } },
]
const reconciliationDetail = {
  id: 'rec1', no: 'DC2026050001', periodStart: '2026-05-01T00:00:00.000Z', periodEnd: '2026-05-31T00:00:00.000Z',
  status: 'DRAFT', totalAmount: '1000', supplier: { id: 'sup-a', name: '供应商A', no: 'SUP001' },
  items: [
    { receiptId: 'r1', amount: '600', receipt: { id: 'r1', no: 'RK001', deliveryDate: '2026-05-14T00:00:00.000Z', totalAmount: '600' } },
    { receiptId: 'r2', amount: '400', receipt: { id: 'r2', no: 'RK002', deliveryDate: '2026-05-20T00:00:00.000Z', totalAmount: '400' } },
  ],
}
const invoiceList = [
  { id: 'inv1', invoiceNo: 'FP001', amount: 1000, status: 'VERIFIED', issueDate: '2026-06-01', supplier: { name: '供应商A' }, receipts: [{ id: 'r1' }, { id: 'r2' }] },
]
const invoiceDetail = {
  id: 'inv1', invoiceNo: 'FP001', invoiceCode: null, amount: '1000', amountWithoutTax: '943.4',
  taxRate: '0.06', taxAmount: '56.6', issueDate: '2026-06-01T00:00:00.000Z', status: 'VERIFIED', note: null,
  fileUrl: 'https://files.example.com/inv.pdf', fileType: 'pdf',
  supplier: { id: 'sup-a', name: '供应商A' },
  receipts: [
    { id: 'r1', no: 'RK001', deliveryDate: '2026-05-14T00:00:00.000Z', totalAmount: '600', store: { name: '门店一' } },
    { id: 'r2', no: 'RK002', deliveryDate: '2026-05-20T00:00:00.000Z', totalAmount: '400', store: { name: '门店二' } },
  ],
}
const receiptDetail = (id: string, no: string, productName: string) => ({
  id, no, deliveryDate: '2026-05-14T00:00:00.000Z', status: 'ACCOUNTED', totalAmount: '600',
  store: { name: '门店一' }, supplier: { name: '供应商A' },
  items: [{ id: 'ri1', productCodeSnapshot: 'P001', productNameSnapshot: productName, productSpecSnapshot: '5kg/箱', productUnitSnapshot: '箱', quantity: '10', unitPrice: '60', amount: '600', product: { code: 'P001', name: productName, spec: '5kg/箱', unit: '箱' } }],
})

/** 路由表：path → 响应值 / Promise / 惰性函数（每次请求时求值）；未命中返回 [] */
function routing(routes: Record<string, unknown>, fallback: unknown = []) {
  return (path: string) => {
    if (!(path in routes)) return fallback
    const value = routes[path]
    return typeof value === 'function' ? (value as (p: string) => unknown)(path) : value
  }
}

const defaultRoutes = () => ({
  '/api/schedules': scheduleList,
  '/api/schedules/s1': scheduleDetailS1,
  '/api/schedules/s2': scheduleDetailS2,
  '/api/reconciliations': reconciliationList,
  '/api/reconciliations/rec1': reconciliationDetail,
  '/api/invoices': invoiceList,
  '/api/invoices/inv1': invoiceDetail,
  '/api/receipts/r1': receiptDetail('r1', 'RK001', '土豆'),
  '/api/receipts/r2': receiptDetail('r2', 'RK002', '白菜'),
})

async function renderBilling(handler: (path: string) => unknown) {
  mockFetch.mockImplementation(((path: string) => Promise.resolve(handler(path))) as any)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<BillingPage />))
  return { container, root }
}

function viewButtons(container: HTMLElement) {
  return Array.from(container.querySelectorAll('button')).filter(button => button.textContent === '查看')
}

function buttonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll('button')).find(button => button.textContent === text)
}

function dialog(container: HTMLElement) {
  return container.querySelector('[role="dialog"]') as HTMLElement | null
}

describe('账务查询详情', () => {
  it('账期行提供可点击查看入口并经真实详情请求展示完整详情', async () => {
    const { container, root } = await renderBilling(routing(defaultRoutes()))
    await waitFor(() => container.textContent?.includes('RK001') ?? false)

    act(() => viewButtons(container)[0].click())
    expect(dialog(container)?.textContent).toContain('账期详情')
    expect(dialog(container)?.textContent).toContain('正在加载详情')
    await waitFor(() => (dialog(container)?.textContent?.includes('门店一') ?? false))
    const text = dialog(container)!.textContent!
    expect(text).toContain('供应商A')
    expect(text).toContain('门店一')
    expect(mockFetch).toHaveBeenCalledWith('/api/schedules/s1')

    act(() => root.unmount())
  })

  it('账期详情对应单张来源入库并可下钻商品快照后返回', async () => {
    const { container, root } = await renderBilling(routing(defaultRoutes()))
    await waitFor(() => container.textContent?.includes('RK001') ?? false)
    act(() => viewButtons(container)[0].click())
    await waitFor(() => (dialog(container)?.textContent?.includes('来源入库单') ?? false))

    const sourceText = dialog(container)!.textContent!
    expect(sourceText).toContain('RK001')
    expect(sourceText).not.toContain('RK002') // 账期只对应单张入库
    expect(sourceText).toContain('原单金额')
    expect(sourceText).toContain('无可用附件') // 来源入库无独立附件证据时不造链接

    act(() => buttonByText(dialog(container)!, '查看商品明细')!.click())
    await waitFor(() => (dialog(container)?.textContent?.includes('土豆') ?? false))
    const panel = dialog(container)!.textContent!
    expect(panel).toContain('P001')
    expect(panel).toContain('5kg/箱')
    expect(panel).toContain('¥60')
    expect(panel).toContain('¥600')

    act(() => buttonByText(dialog(container)!, '返回来源列表')!.click())
    await waitFor(() => (dialog(container)?.textContent?.includes('来源入库单') ?? false))
    expect(dialog(container)!.textContent).not.toContain('土豆')

    act(() => root.unmount())
  })

  it('对账单展示全部组成单据（两单合计1000）并逐张下钻不同商品', async () => {
    const { container, root } = await renderBilling(routing(defaultRoutes()))
    await waitFor(() => container.textContent?.includes('RK001') ?? false)
    act(() => buttonByText(container, '对账单 1')!.click())
    await waitFor(() => container.textContent?.includes('DC2026050001') ?? false)
    act(() => viewButtons(container)[0].click())
    await waitFor(() => (dialog(container)?.textContent?.includes('组成单据') ?? false))

    const text = dialog(container)!.textContent!
    expect(text).toContain('组成单据（2 张）')
    expect(text).toContain('RK001')
    expect(text).toContain('RK002')
    expect(text).toContain('¥600')
    expect(text).toContain('¥400')
    expect(text).toContain('¥1,000') // 对账总金额
    expect(text).not.toContain('不一致') // 600+400=1000，组成完整无缺口提示

    const drillButtons = Array.from(dialog(container)!.querySelectorAll('button'))
      .filter(button => button.textContent === '查看商品明细')
    expect(drillButtons).toHaveLength(2)

    act(() => drillButtons[0].click())
    await waitFor(() => (dialog(container)?.textContent?.includes('土豆') ?? false))
    act(() => buttonByText(dialog(container)!, '返回来源列表')!.click())
    await waitFor(() => (dialog(container)?.textContent?.includes('组成单据') ?? false))
    const drillAgain = Array.from(dialog(container)!.querySelectorAll('button'))
      .filter(button => button.textContent === '查看商品明细')
    act(() => drillAgain[1].click())
    await waitFor(() => (dialog(container)?.textContent?.includes('白菜') ?? false))

    act(() => root.unmount())
  })

  it('对账组成金额缺口时明确提示而不是补0或重算', async () => {
    const incomplete = {
      ...reconciliationDetail,
      items: [reconciliationDetail.items[0]], // 只剩600，总金额仍1000
    }
    const { container, root } = await renderBilling(routing({
      ...defaultRoutes(),
      '/api/reconciliations/rec1': incomplete,
    }))
    await waitFor(() => container.textContent?.includes('RK001') ?? false)
    act(() => buttonByText(container, '对账单 1')!.click())
    await waitFor(() => container.textContent?.includes('DC2026050001') ?? false)
    act(() => viewButtons(container)[0].click())
    await waitFor(() => (dialog(container)?.textContent?.includes('组成单据') ?? false))
    const text = dialog(container)!.textContent!
    expect(text).toContain('不一致')
    expect(text).toContain('¥600')
    expect(text).toContain('¥1,000')

    act(() => root.unmount())
  })

  it('发票展示票面资料、已授权附件与关联入库单，且不出现付款审核按钮', async () => {
    const { container, root } = await renderBilling(routing(defaultRoutes()))
    await waitFor(() => container.textContent?.includes('RK001') ?? false)
    act(() => buttonByText(container, '发票 1')!.click())
    await waitFor(() => container.textContent?.includes('FP001') ?? false)
    act(() => viewButtons(container)[0].click())
    await waitFor(() => (dialog(container)?.textContent?.includes('关联入库单') ?? false))

    const text = dialog(container)!.textContent!
    expect(text).toContain('FP001')
    expect(text).toContain('¥1,000')
    expect(text).toContain('¥943.4')
    expect(text).toContain('6%')
    expect(text).toContain('¥56.6')
    expect(text).toContain('关联入库单（2 张）')

    const link = dialog(container)!.querySelector('a[href="https://files.example.com/inv.pdf"]')
    expect(link).not.toBeNull()
    expect(link!.textContent).toContain('查看附件')

    const allButtons = Array.from(dialog(container)!.querySelectorAll('button')).map(button => button.textContent)
    expect(allButtons).not.toContain('付款')
    expect(allButtons.join(',')).not.toContain('审核')
    expect(allButtons.join(',')).not.toContain('银行')

    act(() => root.unmount())
  })

  it('发票缺附件时明确显示无可用附件', async () => {
    const { container, root } = await renderBilling(routing({
      ...defaultRoutes(),
      '/api/invoices/inv1': { ...invoiceDetail, fileUrl: '' },
    }))
    await waitFor(() => container.textContent?.includes('RK001') ?? false)
    act(() => buttonByText(container, '发票 1')!.click())
    await waitFor(() => container.textContent?.includes('FP001') ?? false)
    act(() => viewButtons(container)[0].click())
    await waitFor(() => (dialog(container)?.textContent?.includes('关联入库单') ?? false))
    expect(dialog(container)!.textContent).toContain('无可用附件')
    expect(dialog(container)!.querySelector('a')).toBeNull()

    act(() => root.unmount())
  })

  it('A慢B快：快速换单后只呈现B，A的迟到返回不写入', async () => {
    const slowA = deferred<unknown>()
    const { container, root } = await renderBilling(routing({
      ...defaultRoutes(),
      '/api/schedules/s1': slowA.promise,
    }))
    await waitFor(() => container.textContent?.includes('RK001') ?? false)

    act(() => viewButtons(container)[0].click()) // A：s1 慢
    expect(dialog(container)?.textContent).toContain('正在加载详情')
    const closeButton = dialog(container)!.querySelector('button[aria-label="关闭"]') as HTMLButtonElement
    act(() => closeButton.click()) // 关闭后立即点B
    expect(dialog(container)).toBeNull()
    act(() => viewButtons(container)[1].click()) // B：s2 快
    await waitFor(() => (dialog(container)?.textContent?.includes('供应商B') ?? false))

    await act(async () => { slowA.resolve(scheduleDetailS1) }) // A 迟到返回
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    const text = dialog(container)!.textContent!
    expect(text).toContain('供应商B')
    expect(text).not.toContain('供应商A')
    expect(mockFetch).toHaveBeenCalledWith('/api/schedules/s1')
    expect(mockFetch).toHaveBeenCalledWith('/api/schedules/s2')

    act(() => root.unmount())
  })

  it('切页签关闭详情，迟到返回不会重新弹窗', async () => {
    const slow = deferred<unknown>()
    const { container, root } = await renderBilling(routing({
      ...defaultRoutes(),
      '/api/schedules/s1': slow.promise,
    }))
    await waitFor(() => container.textContent?.includes('RK001') ?? false)
    act(() => viewButtons(container)[0].click())
    expect(dialog(container)).not.toBeNull()
    act(() => buttonByText(container, '对账单 1')!.click())
    expect(dialog(container)).toBeNull()

    await act(async () => { slow.resolve(scheduleDetailS1) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    expect(dialog(container)).toBeNull() // 迟到返回不重新弹窗

    act(() => root.unmount())
  })

  it('详情网络失败保留重试按钮，重试后恢复显示', async () => {
    let failMode = true
    const { container, root } = await renderBilling(routing({
      ...defaultRoutes(),
      // 惰性函数：重试时按 failMode 重新求值
      '/api/schedules/s1': () => (failMode ? Promise.reject(new Error('网络断开')) : scheduleDetailS1),
    }))
    await waitFor(() => container.textContent?.includes('RK001') ?? false)

    act(() => viewButtons(container)[0].click())
    await waitFor(() => (dialog(container)?.textContent?.includes('详情加载失败') ?? false))
    expect(dialog(container)!.textContent).toContain('网络断开')

    failMode = false
    act(() => buttonByText(dialog(container)!, '重试')!.click())
    await waitFor(() => (dialog(container)?.textContent?.includes('来源入库单') ?? false))
    expect(dialog(container)!.textContent).toContain('供应商A')

    act(() => root.unmount())
  })

  it('详情404与403分别明确提示，不显示另一单缓存', async () => {
    const { container, root } = await renderBilling(routing({
      ...defaultRoutes(),
      '/api/schedules/s1': scheduleDetailS1,
      '/api/schedules/s2': () => Promise.reject(httpError(404, '账期不存在')),
      '/api/reconciliations/rec1': () => Promise.reject(httpError(403, '无权查看对账单')),
    }))
    await waitFor(() => container.textContent?.includes('RK001') ?? false)

    act(() => viewButtons(container)[1].click()) // s2 → 404
    await waitFor(() => (dialog(container)?.textContent?.includes('记录不存在或已被删除') ?? false))
    expect(dialog(container)!.textContent).not.toContain('供应商A')
    const closeButton = dialog(container)!.querySelector('button[aria-label="关闭"]') as HTMLButtonElement
    act(() => closeButton.click())

    act(() => buttonByText(container, '对账单 1')!.click())
    await waitFor(() => container.textContent?.includes('DC2026050001') ?? false)
    act(() => viewButtons(container)[0].click()) // rec1 → 403
    await waitFor(() => (dialog(container)?.textContent?.includes('无权限查看该记录') ?? false))
    expect(dialog(container)!.textContent).not.toContain('供应商A')

    act(() => root.unmount())
  })

  it('来源下钻403/404逐项提示，其他来源仍可查看', async () => {
    let secondAttempts = 0
    const { container, root } = await renderBilling(routing({
      ...defaultRoutes(),
      '/api/receipts/r1': () => Promise.reject(httpError(403, '无权查看入库单')),
      '/api/receipts/r2': () => ++secondAttempts === 1
        ? Promise.reject(httpError(404, '入库单不存在'))
        : receiptDetail('r2', 'RK002', '白菜'),
    }))
    await waitFor(() => container.textContent?.includes('RK001') ?? false)
    act(() => buttonByText(container, '对账单 1')!.click())
    await waitFor(() => container.textContent?.includes('DC2026050001') ?? false)
    act(() => viewButtons(container)[0].click())
    await waitFor(() => (dialog(container)?.textContent?.includes('组成单据') ?? false))

    const drill = () => Array.from(dialog(container)!.querySelectorAll('button'))
      .filter(button => button.textContent === '查看商品明细')
    act(() => drill()[0].click()) // r1 → 403
    await waitFor(() => (dialog(container)?.textContent?.includes('无权限查看该来源入库单') ?? false))
    expect(dialog(container)!.textContent).toContain('组成单据') // 整单仍真实呈现，不伪造成功

    act(() => buttonByText(dialog(container)!, '返回来源列表')!.click())
    await waitFor(() => (dialog(container)?.textContent?.includes('组成单据') ?? false))
    act(() => drill()[1].click()) // r2 → 404
    await waitFor(() => (dialog(container)?.textContent?.includes('来源入库单不存在') ?? false))
    act(() => buttonByText(dialog(container)!, '重试')!.click())
    await waitFor(() => (dialog(container)?.textContent?.includes('白菜') ?? false))
    expect(dialog(container)!.textContent).not.toContain('无权限查看该来源入库单')

    act(() => root.unmount())
  })

  it('缺少历史快照时标记待核，不冒用当前商品主数据', async () => {
    const legacy = receiptDetail('r1', 'RK001', '当前商品名称')
    const { container, root } = await renderBilling(routing({
      ...defaultRoutes(), '/api/receipts/r1': {
        ...legacy, items: legacy.items.map(item => ({ ...item,
          productCodeSnapshot: null, productNameSnapshot: null,
          productSpecSnapshot: null, productUnitSnapshot: null,
        })),
      },
    }))
    await waitFor(() => container.textContent?.includes('RK001') ?? false)
    act(() => viewButtons(container)[0].click())
    await waitFor(() => !!buttonByText(dialog(container)!, '查看商品明细'))
    act(() => buttonByText(dialog(container)!, '查看商品明细')!.click())
    await waitFor(() => dialog(container)?.textContent?.includes('历史商品快照缺失') ?? false)
    expect(dialog(container)!.textContent).not.toContain('当前商品名称')
    expect(dialog(container)!.textContent).toContain('待核')
    expect(dialog(container)!.textContent).toContain('¥600')
    act(() => root.unmount())
  })

  it('合法0金额与缺失字段明确区分，不为缺失补0', async () => {
    const { container, root } = await renderBilling(routing({
      ...defaultRoutes(),
      '/api/schedules/s1': {
        ...scheduleDetailS1, amount: '0', paidAt: null, receipt: null,
      },
      '/api/invoices/inv1': {
        ...invoiceDetail, amount: '0', amountWithoutTax: null, taxAmount: null, taxRate: null,
      },
    }))
    await waitFor(() => container.textContent?.includes('RK001') ?? false)

    act(() => viewButtons(container)[0].click())
    await waitFor(() => (dialog(container)?.textContent?.includes('¥0') ?? false))
    const text = dialog(container)!.textContent!
    expect(text).toContain('¥0') // 合法0金额照常显示
    expect(text).toContain('无来源入库单关联，不可下钻') // 缺来源不用金额0冒充
    expect(dialog(container)!.textContent).not.toContain('查看商品明细')
    const closeButton = dialog(container)!.querySelector('button[aria-label="关闭"]') as HTMLButtonElement
    act(() => closeButton.click())

    act(() => buttonByText(container, '发票 1')!.click())
    await waitFor(() => container.textContent?.includes('FP001') ?? false)
    act(() => viewButtons(container)[0].click())
    await waitFor(() => (dialog(container)?.textContent?.includes('关联入库单') ?? false))
    const invoiceText = dialog(container)!.textContent!
    expect(invoiceText).toContain('¥0')
    expect(invoiceText).toContain('—') // 缺失税额显示—而非¥0

    act(() => root.unmount())
  })

  it('列表筛选与CSV导出入口保持原有行为', async () => {
    const { container, root } = await renderBilling(routing(defaultRoutes()))
    await waitFor(() => container.textContent?.includes('RK001') ?? false)

    const storeSelect = container.querySelector('select') as HTMLSelectElement
    expect(storeSelect).not.toBeNull()
    act(() => {
      storeSelect.value = '门店二'
      storeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await waitFor(() => (container.textContent?.includes('筛选后 1 笔') ?? false))
    expect(container.textContent).toContain('RK002')
    expect(container.textContent).not.toContain('RK001')

    const csvButton = buttonByText(container, '导出当前账期 CSV')
    expect(csvButton).not.toBeNull()
    expect(csvButton!.hasAttribute('disabled')).toBe(false)

    act(() => root.unmount())
  })
})
