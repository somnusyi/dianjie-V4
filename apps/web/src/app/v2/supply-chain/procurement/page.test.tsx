// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import UpstreamProcurementPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

const postedReceipt = {
  id: 'receipt-1', no: 'URC202609000001', status: 'POSTED', payableAmount: 120,
  postedAt: '2026-09-16T04:00:00.000Z', createdAt: '2026-09-16T03:00:00.000Z',
  supplier: { id: 'supplier-1', no: 'SUP001', name: '测试供应商' },
  purchaseOrder: { id: 'order-1', no: 'UPO202609000001', status: 'RECEIVED' },
  shipment: { id: 'shipment-1', no: 'USH202609000001', status: 'RECEIVED' },
  _count: { lines: 1, claims: 0 },
}

const receiptDetail = {
  ...postedReceipt,
  supplier: { ...postedReceipt.supplier, postReceiptClaimHours: 48 },
  purchaseOrder: {
    ...postedReceipt.purchaseOrder,
    lines: [{
      id: 'order-line-1', productNameSnapshot: '人工见手青', productSpecSnapshot: '件/1000g',
      purchaseUnit: 'kg', orderedQty: 10, confirmedQty: null, shippedQty: 10, receivedQty: 10, unitPrice: 12,
    }],
  },
  lines: [{
    id: 'receipt-line-1', purchaseOrderLineId: 'order-line-1', acceptedQty: 10, purchaseUnit: 'kg',
    purchaseOrderLine: {
      productCodeSnapshot: 'P001', productNameSnapshot: '人工见手青', productSpecSnapshot: '件/1000g',
    },
  }],
}

const changeOrder = {
  id: 'order-1', no: 'UPO202609000001', status: 'CHANGE_PROPOSED', totalAmount: 300,
  hasTemporaryPrice: false, expectedArrivalAt: '2026-09-18T00:00:00.000Z',
  supplierId: 'supplier-1', supplier: postedReceipt.supplier,
  warehouse: { id: 'warehouse-1', code: 'WH001', name: '供应链总仓' },
  _count: { lines: 2, shipments: 0, receipts: 0 },
}

const changeOrderDetail = {
  ...changeOrder,
  lines: [
    { id: 'line-1', productNameSnapshot: '云南小土豆', productSpecSnapshot: '10kg/箱', purchaseUnit: '箱', orderedQty: 10, confirmedQty: null, shippedQty: 0, receivedQty: 0, unitPrice: 10 },
    { id: 'line-2', productNameSnapshot: '赤松茸A', productSpecSnapshot: '件/2250g', purchaseUnit: '件', orderedQty: 5, confirmedQty: null, shippedQty: 0, receivedQty: 0, unitPrice: 40 },
  ],
  revisions: [{
    id: 'revision-1', status: 'PENDING', revisionNo: 1, reason: '供应商现货数量变化',
    beforeSnapshot: { expectedArrivalAt: '2026-09-18T00:00:00.000Z', lines: [{ id: 'line-1', quantity: 10 }, { id: 'line-2', quantity: 5 }] },
    afterSnapshot: { expectedArrivalAt: '2026-09-19T00:00:00.000Z', lines: [{ id: 'line-1', quantity: 8 }, { id: 'line-2', quantity: 4 }] },
  }],
}

const contract = {
  id: 'contract-1', supplierId: 'supplier-1', contractNo: 'HT202609-01', version: 1,
  title: '2026年菌菇供货合同', status: 'ACTIVE', startsAt: '2026-09-01T00:00:00.000Z',
  endsAt: null, settlementCycle: 'MONTHLY', settlementDays: 30, taxInclusive: false,
  currency: 'CNY', paymentMethod: '银行转账', supplier: postedReceipt.supplier,
  lines: [{
    id: 'contract-line-1', supplierId: 'supplier-1', purchaseUnit: '件', quotedUnitPrice: 150,
    inventoryUnitsPerPurchaseUnit: 2.25, productNameSnapshot: '赤松茸A', productCodeSnapshot: 'P004',
    productSpecSnapshot: '件/2250g', supplierSkuSnapshot: 'SUP-P004', inventoryUnit: 'kg',
    unitPrice: 150, taxRate: 0.09, minOrderQty: 1, packageMultiple: 1, leadTimeDays: 2,
    shortTolerancePct: 0, overTolerancePct: 0, startsAt: '2026-09-01T00:00:00.000Z',
    product: { id: 'product-4', code: 'P004', name: '赤松茸A', spec: '件/2250g', inventoryUnit: 'kg', unit: '件' },
  }],
}

const statement = {
  id: 'statement-1', no: 'UST202609000001', status: 'DRAFT', supplierId: 'supplier-1',
  supplier: postedReceipt.supplier, periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-09-30T00:00:00.000Z',
  receiptAmount: 21645, deductionAmount: 50, payableAmount: 21595, version: 1,
  _count: { lines: 2, invoiceAllocations: 0 },
}

const statementDetail = {
  ...statement,
  lines: [
    {
      id: 'statement-line-receipt', sourceType: 'RECEIPT', sourceNo: postedReceipt.no,
      businessDate: '2026-09-16T00:00:00.000Z', description: '收货入账', originalAmount: 21645,
      adjustmentAmount: 0, payableAmount: 21645,
      receiptLine: { receipt: { id: postedReceipt.id, no: postedReceipt.no, purchaseOrder: { id: changeOrder.id, no: changeOrder.no } } },
      claim: null,
    },
    {
      id: 'statement-line-claim', sourceType: 'CLAIM', sourceNo: 'UCL202609000001',
      businessDate: '2026-09-17T00:00:00.000Z', description: '差异扣款', originalAmount: 0,
      adjustmentAmount: -50, payableAmount: -50, receiptLine: null,
      claim: {
        id: 'claim-1', no: 'UCL202609000001',
        purchaseOrder: { id: changeOrder.id, no: changeOrder.no },
        receipt: { id: postedReceipt.id, no: postedReceipt.no },
      },
    },
  ],
}

function installPageMock(options: {
  orders?: any[]
  receipts?: any[]
  contracts?: any[]
  statements?: any[]
  orderDetail?: any
  receiptDetailValue?: any
  statementDetailValue?: any
} = {}) {
  const orders = options.orders ?? []
  const receipts = options.receipts ?? []
  const contracts = options.contracts ?? []
  const statements = options.statements ?? []
  mockFetch.mockImplementation((path, init) => {
    const url = String(path)
    if (url === '/api/upstream/purchase-orders' && !init) return Promise.resolve(orders)
    if (url === '/api/upstream/shipments') return Promise.resolve([])
    if (url === '/api/upstream/receipts') return Promise.resolve(receipts)
    if (url === '/api/upstream/arrival-claims') return Promise.resolve([])
    if (url === '/api/upstream/settlement-statements') return Promise.resolve(statements)
    if (url === '/api/upstream/contracts') return Promise.resolve(contracts)
    if (url === '/api/upstream/setup-options') return Promise.resolve({ suppliers: [postedReceipt.supplier], warehouses: [] })
    if (url === '/api/upstream/purchase-orders/order-1') return Promise.resolve(options.orderDetail)
    if (url === '/api/upstream/receipts/receipt-1') return Promise.resolve(options.receiptDetailValue)
    if (url === '/api/upstream/settlement-statements/statement-1') return Promise.resolve(options.statementDetailValue)
    if (url === '/api/upstream/purchase-orders/order-1/revisions/revision-1/review' && init?.method === 'POST') return Promise.resolve({ success: true })
    if (url === '/api/upstream/receipts/receipt-1/confirm' && init?.method === 'POST') return Promise.resolve({ success: true })
    return Promise.reject(new Error(`unexpected API: ${url}`))
  })
}

function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<UpstreamProcurementPage />))
  return { container, root }
}

async function waitFor(predicate: () => boolean, timeout = 1500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('上游采购收货后补报', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url === '/api/upstream/purchase-orders') return Promise.resolve([])
      if (url === '/api/upstream/shipments') return Promise.resolve([])
      if (url === '/api/upstream/receipts') return Promise.resolve([postedReceipt])
      if (url === '/api/upstream/arrival-claims') return Promise.resolve([])
      if (url === '/api/upstream/settlement-statements') return Promise.resolve([])
      if (url === '/api/upstream/contracts') return Promise.resolve([])
      if (url === '/api/upstream/setup-options') return Promise.resolve({ suppliers: [postedReceipt.supplier], warehouses: [] })
      if (url === '/api/upstream/receipts/receipt-1') return Promise.resolve(receiptDetail)
      if (url === '/api/upload?category=loss-claims' && init?.method === 'POST') return Promise.resolve({ url: 'https://example.invalid/evidence.jpg' })
      if (url === '/api/upstream/receipts/receipt-1/post-receipt-claims' && init?.method === 'POST') return Promise.resolve({ id: 'claim-1' })
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
  })

  it('requires evidence and sends a stable idempotency key with the original receipt line', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('上游采购与供应商协同') ?? false)
    const receiptTab = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '到货验收')
    act(() => receiptTab?.click())
    await waitFor(() => container.textContent?.includes('收货后补报异常') ?? false)

    const openButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '收货后补报异常')
    await act(async () => { openButton?.click() })
    await waitFor(() => container.textContent?.includes('人工见手青') ?? false)

    change(container.querySelector('textarea') as HTMLTextAreaElement, '拆包后发现内部品质异常')
    const quantity = container.querySelector('input[type="number"][max="10"]') as HTMLInputElement
    change(quantity, '0.5')

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['evidence'], 'evidence.jpg', { type: 'image/jpeg' })
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
    await act(async () => { fileInput.dispatchEvent(new Event('change', { bubbles: true })) })
    await waitFor(() => container.textContent?.includes('evidence.jpg') ?? false)

    const submitButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '提交补报')
    await act(async () => { submitButton?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path, init]) =>
      String(path) === '/api/upstream/receipts/receipt-1/post-receipt-claims' && init?.method === 'POST'))

    const call = mockFetch.mock.calls.find(([path, init]) =>
      String(path) === '/api/upstream/receipts/receipt-1/post-receipt-claims' && init?.method === 'POST')
    const payload = JSON.parse(String(call?.[1]?.body))
    expect(payload.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i)
    expect(payload.type).toBe('POST_RECEIPT_DAMAGE')
    expect(payload.lines).toEqual([{ purchaseOrderLineId: 'order-line-1', receiptLineId: 'receipt-line-1', affectedQty: 0.5 }])
    expect(payload.evidence).toEqual([{ url: 'https://example.invalid/evidence.jpg', name: 'evidence.jpg' }])

    act(() => root.unmount())
    container.remove()
  })

  it('补报页显示原采购单全部商品并可同时提交三个少发商品', async () => {
    const allOrderLines = [
      { id: 'order-line-1', productNameSnapshot: '云南小土豆', productSpecSnapshot: '10kg/箱', purchaseUnit: '箱', orderedQty: 10, confirmedQty: null, shippedQty: 5, receivedQty: 5, unitPrice: 10 },
      { id: 'order-line-2', productNameSnapshot: '见手青', productSpecSnapshot: 'KG', purchaseUnit: 'KG', orderedQty: 10, confirmedQty: null, shippedQty: 8, receivedQty: 8, unitPrice: 100 },
      { id: 'order-line-3', productNameSnapshot: '羊肚菌', productSpecSnapshot: 'kg', purchaseUnit: 'kg', orderedQty: 15, confirmedQty: null, shippedQty: 15, receivedQty: 15, unitPrice: 120 },
      { id: 'order-line-4', productNameSnapshot: '赤松茸A', productSpecSnapshot: '件/2250g', purchaseUnit: '件', orderedQty: 5, confirmedQty: null, shippedQty: 0, receivedQty: 0, unitPrice: 150 },
    ]
    const detail = {
      ...receiptDetail,
      purchaseOrder: { ...receiptDetail.purchaseOrder, lines: allOrderLines },
      lines: [
        { ...receiptDetail.lines[0], purchaseOrderLineId: 'order-line-1', acceptedQty: 5, purchaseUnit: '箱' },
        { ...receiptDetail.lines[0], id: 'receipt-line-2', purchaseOrderLineId: 'order-line-2', acceptedQty: 8, purchaseUnit: 'KG' },
        { ...receiptDetail.lines[0], id: 'receipt-line-3', purchaseOrderLineId: 'order-line-3', acceptedQty: 15, purchaseUnit: 'kg' },
      ],
    }
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url === '/api/upstream/purchase-orders') return Promise.resolve([])
      if (url === '/api/upstream/shipments') return Promise.resolve([])
      if (url === '/api/upstream/receipts') return Promise.resolve([postedReceipt])
      if (url === '/api/upstream/arrival-claims') return Promise.resolve([])
      if (url === '/api/upstream/settlement-statements') return Promise.resolve([])
      if (url === '/api/upstream/contracts') return Promise.resolve([])
      if (url === '/api/upstream/setup-options') return Promise.resolve({ suppliers: [postedReceipt.supplier], warehouses: [] })
      if (url === '/api/upstream/receipts/receipt-1') return Promise.resolve(detail)
      if (url === '/api/upload?category=loss-claims' && init?.method === 'POST') return Promise.resolve({ url: 'https://example.invalid/evidence.jpg' })
      if (url === '/api/upstream/receipts/receipt-1/post-receipt-claims' && init?.method === 'POST') return Promise.resolve({ id: 'claim-1' })
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })

    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('上游采购与供应商协同') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '到货验收')?.click())
    await waitFor(() => container.textContent?.includes('收货后补报异常') ?? false)
    const openClaim = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '收货后补报异常')
    expect(openClaim).toBeTruthy()
    await act(async () => { openClaim!.click() })
    await waitFor(() => container.textContent?.includes('赤松茸A') ?? false)

    for (const name of ['云南小土豆', '见手青', '羊肚菌', '赤松茸A']) expect(container.textContent).toContain(name)
    const type = container.querySelector('select.input') as HTMLSelectElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(type, 'SHORTAGE')
      type.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const quantities = Array.from(container.querySelectorAll('input[type="number"]')) as HTMLInputElement[]
    change(quantities[0], '5')
    change(quantities[1], '2')
    change(quantities[3], '5')
    change(container.querySelector('textarea') as HTMLTextAreaElement, '对应三个商品少发')
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [new File(['evidence'], 'evidence.jpg', { type: 'image/jpeg' })] })
    await act(async () => { fileInput.dispatchEvent(new Event('change', { bubbles: true })) })
    await waitFor(() => container.textContent?.includes('evidence.jpg') ?? false)
    await act(async () => { Array.from(container.querySelectorAll('button')).find(button => button.textContent === '提交补报')?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path, init]) => String(path).includes('post-receipt-claims') && init?.method === 'POST'))
    const request = mockFetch.mock.calls.find(([path, init]) => String(path).includes('post-receipt-claims') && init?.method === 'POST')
    const payload = JSON.parse(String(request?.[1]?.body))
    expect(payload.type).toBe('SHORTAGE')
    expect(payload.lines).toEqual([
      { purchaseOrderLineId: 'order-line-1', receiptLineId: 'receipt-line-1', affectedQty: 5 },
      { purchaseOrderLineId: 'order-line-2', receiptLineId: 'receipt-line-2', affectedQty: 2 },
      { purchaseOrderLineId: 'order-line-4', affectedQty: 5 },
    ])

    act(() => root.unmount())
    container.remove()
  })

  it('采购单号可直接打开完整商品明细', async () => {
    installPageMock({ orders: [changeOrder], orderDetail: changeOrderDetail })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes(changeOrder.no) ?? false)

    const orderLink = container.querySelector(`button[aria-label="查看采购单 ${changeOrder.no} 明细"]`) as HTMLButtonElement
    await act(async () => { orderLink.click() })
    await waitFor(() => container.textContent?.includes(`采购单明细 · ${changeOrder.no}`) ?? false)

    expect(container.textContent).toContain('云南小土豆')
    expect(container.textContent).toContain('赤松茸A')
    expect(container.textContent).toContain('采购单位')
    expect(container.textContent).toContain('已发数量')
    expect(container.textContent).toContain('已收数量')
    expect(container.textContent).toContain('小计')

    act(() => root.unmount())
    container.remove()
  })

  it('改单必须先看原数量和新数量，之后才能接受', async () => {
    installPageMock({ orders: [changeOrder], orderDetail: changeOrderDetail })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('查看改单内容') ?? false)
    expect(container.textContent).not.toContain('确认接受改单')

    const reviewButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '查看改单内容')
    await act(async () => { reviewButton?.click() })
    await waitFor(() => container.textContent?.includes(`改单审核 · ${changeOrder.no}`) ?? false)

    expect(container.textContent).toContain('供应商现货数量变化')
    expect(container.textContent).toContain('原数量')
    expect(container.textContent).toContain('新数量')
    expect(container.textContent).toContain('期望到货日')
    expect(mockFetch.mock.calls.some(([path, init]) => String(path).includes('/review') && init?.method === 'POST')).toBe(false)

    const acceptButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '确认接受改单')
    await act(async () => { acceptButton?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path, init]) =>
      String(path) === '/api/upstream/purchase-orders/order-1/revisions/revision-1/review' && init?.method === 'POST'))

    act(() => root.unmount())
    container.remove()
  })

  it('验收确认前先展示采购金额和全部收货明细', async () => {
    const inspecting = { ...postedReceipt, status: 'INSPECTING', purchaseOrder: { ...postedReceipt.purchaseOrder, totalAmount: 21645 } }
    const detail = { ...receiptDetail, ...inspecting, purchaseOrder: inspecting.purchaseOrder }
    installPageMock({ receipts: [inspecting], receiptDetailValue: detail, orderDetail: changeOrderDetail })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('到货验收') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '到货验收')?.click())
    await waitFor(() => container.textContent?.includes('查看明细并验收') ?? false)

    const open = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '查看明细并验收')
    await act(async () => { open?.click() })
    await waitFor(() => container.textContent?.includes(`收货单明细 · ${postedReceipt.no}`) ?? false)

    expect(container.textContent).toContain('采购单金额')
    expect(container.textContent).toContain('¥21,645.00')
    expect(container.textContent).toContain('人工见手青')
    expect(container.textContent).toContain('确认验收并提交')
    expect(mockFetch.mock.calls.some(([path, init]) => String(path).endsWith('/confirm') && init?.method === 'POST')).toBe(false)

    const purchaseOrderLink = container.querySelector(`button[aria-label="查看采购单 ${changeOrder.no} 全部内容"]`) as HTMLButtonElement
    await act(async () => { purchaseOrderLink.click() })
    await waitFor(() => container.textContent?.includes(`采购单明细 · ${changeOrder.no}`) ?? false)
    expect(container.textContent).toContain('赤松茸A')

    act(() => root.unmount())
    container.remove()
  })

  it('合同名称可进入合同内容并查看逐商品价格字段', async () => {
    installPageMock({ contracts: [contract] })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('合同与价格') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '合同与价格')?.click())
    await waitFor(() => container.textContent?.includes('查看合同内容') ?? false)

    const open = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '查看合同内容')
    act(() => open?.click())
    await waitFor(() => container.textContent?.includes('合同内容 · 2026年菌菇供货合同') ?? false)

    expect(container.textContent).toContain('赤松茸A')
    expect(container.textContent).toContain('供应商编码')
    expect(container.textContent).toContain('合同单价')
    expect(container.textContent).toContain('不含税价')
    expect(container.textContent).toContain('月结 · 30 天')

    act(() => root.unmount())
    container.remove()
  })

  it('对账来源同时显示采购单、收货单和差异单', async () => {
    installPageMock({
      statements: [statement],
      statementDetailValue: statementDetail,
      orderDetail: changeOrderDetail,
      receiptDetailValue: receiptDetail,
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('月度对账') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === '月度对账')?.click())
    await waitFor(() => container.textContent?.includes('查看来源明细') ?? false)

    const open = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '查看来源明细')
    await act(async () => { open?.click() })
    await waitFor(() => container.textContent?.includes(`对账单明细 · ${statement.no}`) ?? false)

    expect(container.textContent).toContain(changeOrder.no)
    expect(container.textContent).toContain(`收货单 ${postedReceipt.no}`)
    expect(container.textContent).toContain('差异单 UCL202609000001')

    act(() => root.unmount())
    container.remove()
  })
})
