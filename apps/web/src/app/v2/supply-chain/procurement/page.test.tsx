// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import UpstreamProcurementPage from './page'
import { printSheet } from './print-sheet'
import { SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT } from '@/components/v2/supply-chain-shell'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

const postedReceipt = {
  id: 'receipt-1',
  no: 'URC202609000001',
  status: 'POSTED',
  payableAmount: 120,
  postedAt: '2026-09-16T04:00:00.000Z',
  createdAt: '2026-09-16T03:00:00.000Z',
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
    lines: [
      {
        id: 'order-line-1',
        productNameSnapshot: '人工见手青',
        productSpecSnapshot: '件/1000g',
        purchaseUnit: 'kg',
        orderedQty: 10,
        confirmedQty: null,
        shippedQty: 10,
        receivedQty: 10,
        unitPrice: 12,
      },
    ],
  },
  lines: [
    {
      id: 'receipt-line-1',
      purchaseOrderLineId: 'order-line-1',
      acceptedQty: 10,
      purchaseUnit: 'kg',
      purchaseOrderLine: {
        productCodeSnapshot: 'P001',
        productNameSnapshot: '人工见手青',
        productSpecSnapshot: '件/1000g',
      },
    },
  ],
}

const changeOrder = {
  id: 'order-1',
  no: 'UPO202609000001',
  status: 'CHANGE_PROPOSED',
  totalAmount: 300,
  hasTemporaryPrice: false,
  expectedArrivalAt: '2026-09-18T00:00:00.000Z',
  supplierId: 'supplier-1',
  supplier: postedReceipt.supplier,
  warehouse: { id: 'warehouse-1', code: 'WH001', name: '供应链总仓' },
  _count: { lines: 2, shipments: 0, receipts: 0 },
}

const changeOrderDetail = {
  ...changeOrder,
  lines: [
    {
      id: 'line-1',
      productNameSnapshot: '云南小土豆',
      productSpecSnapshot: '10kg/箱',
      purchaseUnit: '箱',
      orderedQty: 10,
      confirmedQty: null,
      shippedQty: 0,
      receivedQty: 0,
      unitPrice: 10,
    },
    {
      id: 'line-2',
      productNameSnapshot: '赤松茸A',
      productSpecSnapshot: '件/2250g',
      purchaseUnit: '件',
      orderedQty: 5,
      confirmedQty: null,
      shippedQty: 0,
      receivedQty: 0,
      unitPrice: 40,
    },
  ],
  revisions: [
    {
      id: 'revision-1',
      status: 'PENDING',
      revisionNo: 1,
      reason: '供应商现货数量变化',
      beforeSnapshot: {
        expectedArrivalAt: '2026-09-18T00:00:00.000Z',
        lines: [
          { id: 'line-1', quantity: 10 },
          { id: 'line-2', quantity: 5 },
        ],
      },
      afterSnapshot: {
        expectedArrivalAt: '2026-09-19T00:00:00.000Z',
        lines: [
          { id: 'line-1', quantity: 8 },
          { id: 'line-2', quantity: 4 },
        ],
      },
    },
  ],
}

const contract = {
  id: 'contract-1',
  supplierId: 'supplier-1',
  contractNo: 'HT202609-01',
  version: 1,
  title: '2026年菌菇供货合同',
  status: 'ACTIVE',
  startsAt: '2026-09-01T00:00:00.000Z',
  endsAt: null,
  settlementCycle: 'MONTHLY',
  settlementDays: 30,
  taxInclusive: false,
  currency: 'CNY',
  paymentMethod: '银行转账',
  supplier: postedReceipt.supplier,
  lines: [
    {
      id: 'contract-line-1',
      supplierId: 'supplier-1',
      purchaseUnit: '件',
      quotedUnitPrice: 150,
      inventoryUnitsPerPurchaseUnit: 2.25,
      productNameSnapshot: '赤松茸A',
      productCodeSnapshot: 'P004',
      productSpecSnapshot: '件/2250g',
      supplierSkuSnapshot: 'SUP-P004',
      inventoryUnit: 'kg',
      unitPrice: 150,
      taxRate: 0.09,
      minOrderQty: 1,
      packageMultiple: 1,
      leadTimeDays: 2,
      shortTolerancePct: 0,
      overTolerancePct: 0,
      startsAt: '2026-09-01T00:00:00.000Z',
      product: {
        id: 'product-4',
        code: 'P004',
        name: '赤松茸A',
        spec: '件/2250g',
        inventoryUnit: 'kg',
        unit: '件',
      },
    },
  ],
}

const statement = {
  id: 'statement-1',
  no: 'UST202609000001',
  status: 'DRAFT',
  supplierId: 'supplier-1',
  supplier: postedReceipt.supplier,
  periodStart: '2026-09-01T00:00:00.000Z',
  periodEnd: '2026-09-30T00:00:00.000Z',
  receiptAmount: 21645,
  deductionAmount: 50,
  payableAmount: 21595,
  version: 1,
  _count: { lines: 2, invoiceAllocations: 0 },
}

const statementDetail = {
  ...statement,
  lines: [
    {
      id: 'statement-line-receipt',
      sourceType: 'RECEIPT',
      sourceNo: postedReceipt.no,
      businessDate: '2026-09-16T00:00:00.000Z',
      description: '收货入账',
      originalAmount: 21645,
      adjustmentAmount: 0,
      payableAmount: 21645,
      receiptLine: {
        receipt: {
          id: postedReceipt.id,
          no: postedReceipt.no,
          purchaseOrder: { id: changeOrder.id, no: changeOrder.no },
        },
      },
      claim: null,
    },
    {
      id: 'statement-line-claim',
      sourceType: 'CLAIM',
      sourceNo: 'UCL202609000001',
      businessDate: '2026-09-17T00:00:00.000Z',
      description: '差异扣款',
      originalAmount: 0,
      adjustmentAmount: -50,
      payableAmount: -50,
      receiptLine: null,
      claim: {
        id: 'claim-1',
        no: 'UCL202609000001',
        purchaseOrder: { id: changeOrder.id, no: changeOrder.no },
        receipt: { id: postedReceipt.id, no: postedReceipt.no },
      },
    },
  ],
}

function installPageMock(
  options: {
    orders?: any[]
    shipments?: any[]
    receipts?: any[]
    purchaseReturns?: any[]
    claims?: any[]
    contracts?: any[]
    statements?: any[]
    orderDetail?: any
    receiptDetailValue?: any
    statementDetailValue?: any
    sources?: any[]
    warehouses?: any[]
  } = {}
) {
  const orders = options.orders ?? []
  const shipments = options.shipments ?? []
  const receipts = options.receipts ?? []
  const purchaseReturns = options.purchaseReturns ?? []
  const claims = options.claims ?? []
  const contracts = options.contracts ?? []
  const statements = options.statements ?? []
  const sources = options.sources ?? []
  const warehouses = options.warehouses ?? []
  mockFetch.mockImplementation((path, init) => {
    const url = String(path)
    if (url === '/api/upstream/purchase-orders' && !init) return Promise.resolve(orders)
    if (url === '/api/upstream/shipments') return Promise.resolve(shipments)
    if (url === '/api/upstream/receipts') return Promise.resolve(receipts)
    if (url === '/api/upstream/purchase-returns') return Promise.resolve(purchaseReturns)
    if (url === '/api/upstream/arrival-claims') return Promise.resolve(claims)
    if (url === '/api/upstream/settlement-statements') return Promise.resolve(statements)
    if (url === '/api/upstream/contracts' && !init) return Promise.resolve(contracts)
    if (url === '/api/upstream/quality-standards?includeArchived=1') return Promise.resolve([])
    if (url === '/api/upstream/price-standards?includeArchived=1') return Promise.resolve([])
    if (url === '/api/upstream/contracts' && init?.method === 'POST')
      return Promise.resolve({
        id: 'contract-created',
        contractNo: 'KJ20260928-SUP001',
        title: '快速合同',
      })
    if (url === '/api/upstream/setup-options')
      return Promise.resolve({
        suppliers: [postedReceipt.supplier],
        warehouses,
      })
    if (url.startsWith('/api/upstream/setup-options?supplierId=')) return Promise.resolve({ sources })
    if (url === '/api/upstream/purchase-orders/order-1') return Promise.resolve(options.orderDetail)
    if (url === '/api/upstream/receipts/receipt-1') return Promise.resolve(options.receiptDetailValue)
    if (url === '/api/upstream/settlement-statements/statement-1') return Promise.resolve(options.statementDetailValue)
    if (url === '/api/upstream/purchase-orders/order-1/revisions/revision-1/review' && init?.method === 'POST') return Promise.resolve({ success: true })
    if (url === '/api/upstream/receipts/receipt-1/confirm' && init?.method === 'POST') return Promise.resolve({ success: true })
    if (url === '/api/upstream/receipts/receipt-1/review-and-post' && init?.method === 'POST') return Promise.resolve({ success: true })
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
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
  it('打印时只创建目标单据副本，并在打印结束后完整清理', () => {
    const sheet = document.createElement('article')
    sheet.id = 'claim-print-test'
    sheet.innerHTML = '<h2>差异单</h2><button data-print-hidden>不打印操作</button>'
    document.body.appendChild(sheet)
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined)

    printSheet(sheet.id)

    expect(print).toHaveBeenCalledOnce()
    expect(document.body.dataset.procurementPrinting).toBe('true')
    const clone = document.body.querySelector('[data-print-clone="true"]')
    expect(clone?.textContent).toContain('差异单')
    expect(clone?.querySelector('[data-print-hidden]')).not.toBeNull()

    window.dispatchEvent(new Event('afterprint'))
    expect(document.body.dataset.procurementPrinting).toBeUndefined()
    expect(document.body.querySelector('[data-print-clone="true"]')).toBeNull()
    sheet.remove()
  })

  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url === '/api/upstream/purchase-orders') return Promise.resolve([])
      if (url === '/api/upstream/shipments') return Promise.resolve([])
      if (url === '/api/upstream/receipts') return Promise.resolve([postedReceipt])
      if (url === '/api/upstream/purchase-returns') return Promise.resolve([])
      if (url === '/api/upstream/arrival-claims') return Promise.resolve([])
      if (url === '/api/upstream/settlement-statements') return Promise.resolve([])
      if (url === '/api/upstream/contracts') return Promise.resolve([])
      if (url === '/api/upstream/quality-standards?includeArchived=1') return Promise.resolve([])
      if (url === '/api/upstream/price-standards?includeArchived=1') return Promise.resolve([])
      if (url === '/api/upstream/setup-options')
        return Promise.resolve({
          suppliers: [postedReceipt.supplier],
          warehouses: [],
        })
      if (url === '/api/upstream/receipts/receipt-1') return Promise.resolve(receiptDetail)
      if (url === '/api/upload?category=loss-claims' && init?.method === 'POST') return Promise.resolve({ url: 'https://example.invalid/evidence.jpg' })
      if (url === '/api/upstream/receipts/receipt-1/post-receipt-claims' && init?.method === 'POST') return Promise.resolve({ id: 'claim-1' })
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
  })

  it('requires evidence and sends a stable idempotency key with the original receipt line', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('上游采购与供应商协同') ?? false)
    const receiptTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '到货验收')
    act(() => receiptTab?.click())
    await waitFor(() => container.textContent?.includes('收货后补报异常') ?? false)

    const openButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '收货后补报异常')
    await act(async () => {
      openButton?.click()
    })
    await waitFor(() => container.textContent?.includes('人工见手青') ?? false)

    change(container.querySelector('textarea') as HTMLTextAreaElement, '拆包后发现内部品质异常')
    const quantity = container.querySelector('input[type="number"][max="10"]') as HTMLInputElement
    change(quantity, '0.5')

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['evidence'], 'evidence.jpg', { type: 'image/jpeg' })
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [file],
    })
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await waitFor(() => container.textContent?.includes('evidence.jpg') ?? false)

    const submitButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '提交补报')
    await act(async () => {
      submitButton?.click()
    })
    await waitFor(() => mockFetch.mock.calls.some(([path, init]) => String(path) === '/api/upstream/receipts/receipt-1/post-receipt-claims' && init?.method === 'POST'))

    const call = mockFetch.mock.calls.find(([path, init]) => String(path) === '/api/upstream/receipts/receipt-1/post-receipt-claims' && init?.method === 'POST')
    const payload = JSON.parse(String(call?.[1]?.body))
    expect(payload.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i)
    expect(payload.type).toBe('POST_RECEIPT_DAMAGE')
    expect(payload.lines).toEqual([
      {
        purchaseOrderLineId: 'order-line-1',
        receiptLineId: 'receipt-line-1',
        affectedQty: 0.5,
      },
    ])
    expect(payload.evidence).toEqual([{ url: 'https://example.invalid/evidence.jpg', name: 'evidence.jpg' }])

    act(() => root.unmount())
    container.remove()
  })

  it('补报页显示原采购单全部商品并可同时提交三个少发商品', async () => {
    const allOrderLines = [
      {
        id: 'order-line-1',
        productNameSnapshot: '云南小土豆',
        productSpecSnapshot: '10kg/箱',
        purchaseUnit: '箱',
        orderedQty: 10,
        confirmedQty: null,
        shippedQty: 5,
        receivedQty: 5,
        unitPrice: 10,
      },
      {
        id: 'order-line-2',
        productNameSnapshot: '见手青',
        productSpecSnapshot: 'KG',
        purchaseUnit: 'KG',
        orderedQty: 10,
        confirmedQty: null,
        shippedQty: 8,
        receivedQty: 8,
        unitPrice: 100,
      },
      {
        id: 'order-line-3',
        productNameSnapshot: '羊肚菌',
        productSpecSnapshot: 'kg',
        purchaseUnit: 'kg',
        orderedQty: 15,
        confirmedQty: null,
        shippedQty: 15,
        receivedQty: 15,
        unitPrice: 120,
      },
      {
        id: 'order-line-4',
        productNameSnapshot: '赤松茸A',
        productSpecSnapshot: '件/2250g',
        purchaseUnit: '件',
        orderedQty: 5,
        confirmedQty: null,
        shippedQty: 0,
        receivedQty: 0,
        unitPrice: 150,
      },
    ]
    const detail = {
      ...receiptDetail,
      purchaseOrder: { ...receiptDetail.purchaseOrder, lines: allOrderLines },
      lines: [
        {
          ...receiptDetail.lines[0],
          purchaseOrderLineId: 'order-line-1',
          acceptedQty: 5,
          purchaseUnit: '箱',
        },
        {
          ...receiptDetail.lines[0],
          id: 'receipt-line-2',
          purchaseOrderLineId: 'order-line-2',
          acceptedQty: 8,
          purchaseUnit: 'KG',
        },
        {
          ...receiptDetail.lines[0],
          id: 'receipt-line-3',
          purchaseOrderLineId: 'order-line-3',
          acceptedQty: 15,
          purchaseUnit: 'kg',
        },
      ],
    }
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url === '/api/upstream/purchase-orders') return Promise.resolve([])
      if (url === '/api/upstream/shipments') return Promise.resolve([])
      if (url === '/api/upstream/receipts') return Promise.resolve([postedReceipt])
      if (url === '/api/upstream/purchase-returns') return Promise.resolve([])
      if (url === '/api/upstream/arrival-claims') return Promise.resolve([])
      if (url === '/api/upstream/settlement-statements') return Promise.resolve([])
      if (url === '/api/upstream/contracts') return Promise.resolve([])
      if (url === '/api/upstream/quality-standards?includeArchived=1') return Promise.resolve([])
      if (url === '/api/upstream/price-standards?includeArchived=1') return Promise.resolve([])
      if (url === '/api/upstream/setup-options')
        return Promise.resolve({
          suppliers: [postedReceipt.supplier],
          warehouses: [],
        })
      if (url === '/api/upstream/receipts/receipt-1') return Promise.resolve(detail)
      if (url === '/api/upload?category=loss-claims' && init?.method === 'POST') return Promise.resolve({ url: 'https://example.invalid/evidence.jpg' })
      if (url === '/api/upstream/receipts/receipt-1/post-receipt-claims' && init?.method === 'POST') return Promise.resolve({ id: 'claim-1' })
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })

    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('上游采购与供应商协同') ?? false)
    act(() =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '到货验收')
        ?.click()
    )
    await waitFor(() => container.textContent?.includes('收货后补报异常') ?? false)
    const openClaim = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '收货后补报异常')
    expect(openClaim).toBeTruthy()
    await act(async () => {
      openClaim!.click()
    })
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
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [new File(['evidence'], 'evidence.jpg', { type: 'image/jpeg' })],
    })
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await waitFor(() => container.textContent?.includes('evidence.jpg') ?? false)
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '提交补报')
        ?.click()
    })
    await waitFor(() => mockFetch.mock.calls.some(([path, init]) => String(path).includes('post-receipt-claims') && init?.method === 'POST'))
    const request = mockFetch.mock.calls.find(([path, init]) => String(path).includes('post-receipt-claims') && init?.method === 'POST')
    const payload = JSON.parse(String(request?.[1]?.body))
    expect(payload.type).toBe('SHORTAGE')
    expect(payload.lines).toEqual([
      {
        purchaseOrderLineId: 'order-line-1',
        receiptLineId: 'receipt-line-1',
        affectedQty: 5,
      },
      {
        purchaseOrderLineId: 'order-line-2',
        receiptLineId: 'receipt-line-2',
        affectedQty: 2,
      },
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
    await act(async () => {
      orderLink.click()
    })
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

    const reviewButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '查看改单内容')
    await act(async () => {
      reviewButton?.click()
    })
    await waitFor(() => container.textContent?.includes(`改单审核 · ${changeOrder.no}`) ?? false)

    expect(container.textContent).toContain('供应商现货数量变化')
    expect(container.textContent).toContain('原数量')
    expect(container.textContent).toContain('新数量')
    expect(container.textContent).toContain('期望到货日')
    expect(mockFetch.mock.calls.some(([path, init]) => String(path).includes('/review') && init?.method === 'POST')).toBe(false)

    const acceptButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '确认接受改单')
    await act(async () => {
      acceptButton?.click()
    })
    await waitFor(() => mockFetch.mock.calls.some(([path, init]) => String(path) === '/api/upstream/purchase-orders/order-1/revisions/revision-1/review' && init?.method === 'POST'))

    act(() => root.unmount())
    container.remove()
  })

  it('验收确认前先展示采购金额和全部收货明细', async () => {
    const inspecting = {
      ...postedReceipt,
      status: 'INSPECTING',
      purchaseOrder: { ...postedReceipt.purchaseOrder, totalAmount: 21645 },
    }
    const detail = {
      ...receiptDetail,
      ...inspecting,
      purchaseOrder: inspecting.purchaseOrder,
    }
    installPageMock({
      receipts: [inspecting],
      receiptDetailValue: detail,
      orderDetail: changeOrderDetail,
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('到货验收') ?? false)
    act(() =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '到货验收')
        ?.click()
    )
    await waitFor(() => container.textContent?.includes('查看明细并验收') ?? false)

    const open = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '查看明细并验收')
    await act(async () => {
      open?.click()
    })
    await waitFor(() => container.textContent?.includes(`收货单明细 · ${postedReceipt.no}`) ?? false)

    expect(container.textContent).toContain('采购单金额')
    expect(container.textContent).toContain('¥21,645.00')
    expect(container.textContent).toContain('人工见手青')
    expect(container.textContent).toContain('确认验收并提交')
    expect(mockFetch.mock.calls.some(([path, init]) => String(path).endsWith('/confirm') && init?.method === 'POST')).toBe(false)

    const purchaseOrderLink = container.querySelector(`button[aria-label="查看采购单 ${changeOrder.no} 全部内容"]`) as HTMLButtonElement
    await act(async () => {
      purchaseOrderLink.click()
    })
    await waitFor(() => container.textContent?.includes(`采购单明细 · ${changeOrder.no}`) ?? false)
    expect(container.textContent).toContain('赤松茸A')

    act(() => root.unmount())
    container.remove()
  })

  it('合同名称可进入合同内容并查看逐商品价格字段', async () => {
    installPageMock({ contracts: [contract] })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('合同与价格') ?? false)
    act(() =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '合同与价格')
        ?.click()
    )
    await waitFor(() => Boolean(container.querySelector(`button[aria-label="查看合同 ${contract.title} 内容"]`)))
    const open = container.querySelector(`button[aria-label="查看合同 ${contract.title} 内容"]`) as HTMLButtonElement
    act(() => open.click())
    await waitFor(() => container.textContent?.includes('合同内容 · 2026年菌菇供货合同') ?? false)

    expect(container.textContent).toContain('赤松茸A')
    expect(container.textContent).toContain('供应商编码')
    expect(container.textContent).toContain('合同单价')
    expect(container.textContent).toContain('不含税价')
    expect(container.textContent).toContain('月结 · 30 天')

    act(() => root.unmount())
    container.remove()
  })

  it('新建采购单按供应商自动带出唯一生效合同', async () => {
    installPageMock({
      contracts: [contract],
      warehouses: [{ id: 'warehouse-1', code: 'WH001', name: '供应链总仓' }],
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('新建采购单') ?? false)
    act(() =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '新建采购单')
        ?.click()
    )
    await waitFor(() => container.textContent?.includes('已自动带出合同') ?? false)

    expect(container.textContent).toContain(contract.contractNo)
    expect(container.textContent).toContain('赤松茸A')
    expect(container.textContent).not.toContain('多份请选')

    act(() => root.unmount())
    container.remove()
  })

  it('多份生效合同才显示合同选择器', async () => {
    const another = {
      ...contract,
      id: 'contract-2',
      contractNo: 'HT202609-02',
      title: '菌菇供货合同二',
    }
    installPageMock({
      contracts: [contract, another],
      warehouses: [{ id: 'warehouse-1', code: 'WH001', name: '供应链总仓' }],
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('新建采购单') ?? false)
    act(() =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '新建采购单')
        ?.click()
    )
    await waitFor(() => container.textContent?.includes('多份请选') ?? false)

    expect(container.textContent).toContain('HT202609-01')
    expect(container.textContent).toContain('HT202609-02')

    act(() => root.unmount())
    container.remove()
  })

  it('无生效合同时可在采购单内快速建合同并带出现行价', async () => {
    const source = {
      id: 'source-1',
      supplierId: postedReceipt.supplier.id,
      purchaseUnit: 'kg',
      quotedUnitPrice: 88,
      minOrderQty: 1,
      inventoryUnitsPerPurchaseUnit: 1,
      product: {
        id: 'product-1',
        code: 'P001',
        name: '人工见手青',
        spec: 'kg',
        inventoryUnit: 'kg',
        unit: 'kg',
      },
    }
    installPageMock({
      sources: [source],
      warehouses: [{ id: 'warehouse-1', code: 'WH001', name: '供应链总仓' }],
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('新建采购单') ?? false)
    act(() =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '新建采购单')
        ?.click()
    )
    await waitFor(() => container.textContent?.includes('快速建合同') ?? false)
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '快速建合同')
        ?.click()
    })
    await waitFor(() => container.textContent?.includes('供应商与现行供货价已带出') ?? false)

    const price = container.querySelector('input[aria-label="人工见手青合同单价"]') as HTMLInputElement
    expect(price.value).toBe('88')
    expect(Array.from(container.querySelectorAll('input')).some((input) => input.value === '测试供应商长期供货框架')).toBe(true)

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '保存合同草稿')
        ?.click()
    })
    await waitFor(() => mockFetch.mock.calls.some(([path, init]) => String(path) === '/api/upstream/contracts' && init?.method === 'POST'))
    const createCall = mockFetch.mock.calls.find(([path, init]) => String(path) === '/api/upstream/contracts' && init?.method === 'POST')
    const payload = JSON.parse(String(createCall?.[1]?.body))
    expect(payload.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i)
    expect(payload.lines).toEqual([expect.objectContaining({ upstreamSourceId: 'source-1', unitPrice: 88 })])

    act(() => root.unmount())
    container.remove()
  })

  it('快速切换供应商时旧货源响应不会覆盖新货源', async () => {
    let resolveFirst!: (value: { sources: any[] }) => void
    let resolveSecond!: (value: { sources: any[] }) => void
    const first = new Promise<{ sources: any[] }>((resolve) => {
      resolveFirst = resolve
    })
    const second = new Promise<{ sources: any[] }>((resolve) => {
      resolveSecond = resolve
    })
    const supplierTwo = { id: 'supplier-2', no: 'SUP002', name: '第二供应商' }
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url === '/api/upstream/purchase-orders' && !init) return Promise.resolve([])
      if (url === '/api/upstream/shipments') return Promise.resolve([])
      if (url === '/api/upstream/receipts') return Promise.resolve([])
      if (url === '/api/upstream/purchase-returns') return Promise.resolve([])
      if (url === '/api/upstream/arrival-claims') return Promise.resolve([])
      if (url === '/api/upstream/settlement-statements') return Promise.resolve([])
      if (url === '/api/upstream/contracts' && !init) return Promise.resolve([])
      if (url === '/api/upstream/quality-standards?includeArchived=1') return Promise.resolve([])
      if (url === '/api/upstream/price-standards?includeArchived=1') return Promise.resolve([])
      if (url === '/api/upstream/setup-options')
        return Promise.resolve({
          suppliers: [postedReceipt.supplier, supplierTwo],
          warehouses: [],
        })
      if (url.endsWith('supplierId=supplier-1')) return first
      if (url.endsWith('supplierId=supplier-2')) return second
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })

    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('新建采购单') ?? false)
    act(() =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '新建采购单')
        ?.click()
    )
    await waitFor(() => container.textContent?.includes('快速建合同') ?? false)
    act(() =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '快速建合同')
        ?.click()
    )

    const supplierSelect = container.querySelector('select') as HTMLSelectElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(supplierSelect, 'supplier-2')
      supplierSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await waitFor(() => container.textContent?.includes('第二供应商') ?? false)
    act(() =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '快速建合同')
        ?.click()
    )

    await act(async () =>
      resolveSecond({
        sources: [
          {
            id: 'source-2',
            supplierId: 'supplier-2',
            purchaseUnit: 'kg',
            quotedUnitPrice: 22,
            minOrderQty: 1,
            inventoryUnitsPerPurchaseUnit: 1,
            product: {
              id: 'product-2',
              code: 'P002',
              name: '新供应商商品',
              spec: 'kg',
              inventoryUnit: 'kg',
              unit: 'kg',
            },
          },
        ],
      })
    )
    await waitFor(() => container.textContent?.includes('新供应商商品') ?? false)
    await act(async () =>
      resolveFirst({
        sources: [
          {
            id: 'source-1',
            supplierId: 'supplier-1',
            purchaseUnit: 'kg',
            quotedUnitPrice: 11,
            minOrderQty: 1,
            inventoryUnitsPerPurchaseUnit: 1,
            product: {
              id: 'product-1',
              code: 'P001',
              name: '旧供应商商品',
              spec: 'kg',
              inventoryUnit: 'kg',
              unit: 'kg',
            },
          },
        ],
      })
    )
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('新供应商商品')
    expect(container.textContent).not.toContain('旧供应商商品')
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
    act(() =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '月度对账')
        ?.click()
    )
    await waitFor(() => container.textContent?.includes(statement.no) ?? false)

    const open = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === statement.no)
    await act(async () => {
      open?.click()
    })
    await waitFor(() => container.textContent?.includes(`对账单明细 · ${statement.no}`) ?? false)

    expect(container.textContent).toContain(changeOrder.no)
    expect(container.textContent).toContain(`收货单 ${postedReceipt.no}`)
    expect(container.textContent).toContain('差异单 UCL202609000001')

    act(() => root.unmount())
    container.remove()
  })

  it('在到货差异页打开来源单据时不离开当前页签', async () => {
    installPageMock({
      claims: [
        {
          id: 'claim-1',
          no: 'UCL202609000001',
          type: 'SHORTAGE',
          status: 'PENDING_SUPPLIER',
          claimedAmount: 50,
          description: '到货短缺',
          supplierId: postedReceipt.supplier.id,
          purchaseOrder: { id: changeOrder.id, no: changeOrder.no },
          receipt: { id: postedReceipt.id, no: postedReceipt.no },
          lines: [
            {
              id: 'claim-line-1',
              affectedQty: 1,
              purchaseUnit: 'kg',
              product: { code: 'P001', name: '人工见手青' },
            },
          ],
        },
      ],
      orderDetail: changeOrderDetail,
      receiptDetailValue: receiptDetail,
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('到货差异') ?? false)
    const claimsTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '到货差异')!
    act(() => claimsTab.click())
    await waitFor(() => container.textContent?.includes('UCL202609000001') ?? false)

    const sourceOrder = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === `采购单 ${changeOrder.no}`)!
    await act(async () => {
      sourceOrder.click()
    })
    await waitFor(() => container.textContent?.includes(`采购单明细 · ${changeOrder.no}`) ?? false)
    expect(claimsTab.className).toContain('bg-gray1')
    expect(container.textContent).toContain('UCL202609000001')

    const close = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '关闭')!
    act(() => close.click())
    const sourceReceipt = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === `收货单 ${postedReceipt.no}`)!
    await act(async () => {
      sourceReceipt.click()
    })
    await waitFor(() => container.textContent?.includes(`收货单明细 · ${postedReceipt.no}`) ?? false)
    expect(claimsTab.className).toContain('bg-gray1')

    act(() => root.unmount())
    container.remove()
  })

  it('采购退货按独立单据展示并明确审批时才扣库存', async () => {
    installPageMock({
      purchaseReturns: [
        {
          id: 'return-1',
          no: 'URT202609000001',
          status: 'PENDING_APPROVAL',
          reason: '质量不合格',
          settlementAmount: 100,
          ledgerCostAmount: 0,
          createdAt: '2026-09-28T01:00:00Z',
          supplier: postedReceipt.supplier,
          warehouse: { id: 'warehouse-1', code: 'WH001', name: '供应链总仓' },
          lines: [
            {
              id: 'return-line-1',
              receiptLineId: 'receipt-line-1',
              purchaseQuantity: 4,
              purchaseUnit: 'kg',
              inventoryQuantity: 4,
              inventoryUnit: 'kg',
              settlementUnitPrice: 25,
              settlementAmount: 100,
              product: {
                id: 'product-1',
                code: 'P001',
                name: '云南小土豆',
                spec: '10kg/箱',
              },
              receiptLine: {
                id: 'receipt-line-1',
                receiptId: postedReceipt.id,
                receipt: { no: postedReceipt.no },
              },
            },
          ],
        },
      ],
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('采购退货') ?? false)
    act(() =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '采购退货')
        ?.click()
    )
    await waitFor(() => container.textContent?.includes('URT202609000001') ?? false)

    expect(container.textContent).toContain(`原收货单 ${postedReceipt.no}`)
    expect(container.textContent).toContain('云南小土豆')
    expect(container.textContent).toContain('待审核')
    expect(container.textContent).toContain('审核并出库')

    act(() => root.unmount())
    container.remove()
  })

  it('有质量标准的到货行必须由验收人显式选择结果', async () => {
    const shipment = {
      id: 'shipment-quality-1',
      no: 'USH-Q-1',
      status: 'SHIPPED',
      supplierId: 'supplier-1',
      purchaseOrder: { id: 'order-1', no: 'UPO-Q-1', status: 'SHIPPED' },
      lines: [{
        id: 'shipment-line-q1',
        purchaseOrderLineId: 'order-line-q1',
        shippedQty: 5,
        purchaseUnit: 'kg',
        receiptLines: [],
        purchaseOrderLine: {
          productId: 'product-1',
          productNameSnapshot: '人工见手青',
          productSpecSnapshot: '5kg/箱',
          unitPrice: 18,
          standardUnitPriceSnapshot: 20,
          priceStandardCurrencySnapshot: 'CNY',
          priceStandardTaxInclusiveSnapshot: true,
          qualityStandardId: 'quality-1',
          qualityStandardVersionSnapshot: 2,
          qualityCriteriaSnapshot: { description: '无异味、无腐烂' },
        },
      }],
    }
    installPageMock({ shipments: [shipment] })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('USH-Q-1') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '登记到货')?.click())
    await waitFor(() => container.textContent?.includes('无异味、无腐烂') ?? false)

    const qualitySelect = Array.from(container.querySelectorAll('select')).find((select) => select.textContent?.includes('合格') && select.textContent?.includes('不合格')) as HTMLSelectElement
    expect(qualitySelect.value).toBe('')
    act(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '生成收货单')?.click())
    await waitFor(() => container.textContent?.includes('必须选择质量验收结果') ?? false)
    expect(mockFetch.mock.calls.some(([path, init]) => String(path).includes('/shipments/shipment-quality-1/receipts') && init?.method === 'POST')).toBe(false)

    act(() => root.unmount())
    container.remove()
  })

  it('质量验收不合格必须填写拒收处置并上传证据', async () => {
    const shipment = {
      id: 'shipment-quality-fail-1',
      no: 'USH-Q-FAIL-1',
      status: 'SHIPPED',
      supplierId: 'supplier-1',
      purchaseOrder: { id: 'order-1', no: 'UPO-Q-FAIL-1', status: 'SHIPPED', currency: 'CNY' },
      lines: [{
        id: 'shipment-line-quality-fail-1',
        purchaseOrderLineId: 'order-line-quality-fail-1',
        shippedQty: 10,
        purchaseUnit: 'kg',
        receiptLines: [],
        purchaseOrderLine: {
          productId: 'product-1',
          productNameSnapshot: '人工见手青',
          productSpecSnapshot: '5kg/箱',
          unitPrice: 18,
          standardUnitPriceSnapshot: 20,
          priceStandardCurrencySnapshot: 'CNY',
          priceStandardTaxInclusiveSnapshot: true,
          qualityStandardId: 'quality-1',
          qualityStandardVersionSnapshot: 2,
          qualityCriteriaSnapshot: { description: '无异味、无腐烂' },
        },
      }],
    }
    installPageMock({ shipments: [shipment] })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('USH-Q-FAIL-1') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '登记到货')?.click())
    await waitFor(() => container.textContent?.includes('无异味、无腐烂') ?? false)

    const qualitySelect = Array.from(container.querySelectorAll('select')).find((select) => select.textContent?.includes('合格') && select.textContent?.includes('不合格')) as HTMLSelectElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(qualitySelect, 'FAIL')
      qualitySelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const quantityInputs = Array.from(container.querySelectorAll('input[type="number"]')) as HTMLInputElement[]
    change(quantityInputs[1], '0')
    change(quantityInputs[3], '10')
    const disposition = Array.from(container.querySelectorAll('textarea')).find((item) => item.placeholder.includes('处置结果'))!
    change(disposition, '整批拒收并退回供应商')
    act(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '生成收货单')?.click())

    await waitFor(() => container.textContent?.includes('不合格时必须上传证据') ?? false)
    expect(mockFetch.mock.calls.some(([path, init]) => String(path).includes('/shipments/shipment-quality-fail-1/receipts') && init?.method === 'POST')).toBe(false)

    act(() => root.unmount())
    container.remove()
  })

  it('超标准价二审必须填写价格例外原因并随请求提交', async () => {
    const pending = {
      ...postedReceipt,
      status: 'PENDING_REVIEW',
      reviewReasons: ['ABOVE_STANDARD_PRICE'],
      _count: { lines: 1, claims: 0 },
    }
    const detail = {
      ...receiptDetail,
      ...pending,
      canApprovePriceException: true,
      lines: [{
        ...receiptDetail.lines[0],
        unitPrice: 21,
        standardUnitPriceSnapshot: 20,
        priceStandardCurrencySnapshot: 'CNY',
        priceStandardTaxInclusiveSnapshot: true,
        priceStandardVersionSnapshot: 1,
      }],
    }
    installPageMock({ receipts: [pending], receiptDetailValue: detail })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('到货验收') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '到货验收')?.click())
    await waitFor(() => container.textContent?.includes('查看明细并复核') ?? false)
    await act(async () => { Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '查看明细并复核')?.click() })
    await waitFor(() => container.textContent?.includes('价格例外复核原因') ?? false)

    act(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '确认复核并入库')?.click())
    await waitFor(() => container.textContent?.includes('请填写价格例外复核原因') ?? false)
    const textarea = Array.from(container.querySelectorAll('textarea')).find((item) => item.placeholder.includes('涨价原因'))!
    change(textarea, '供应商当日临时涨价，已核对并同意')
    await act(async () => { Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '确认复核并入库')?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path]) => String(path).endsWith('/review-and-post')))
    const call = mockFetch.mock.calls.find(([path]) => String(path).endsWith('/review-and-post'))!
    expect(JSON.parse(String(call[1]?.body))).toEqual({ priceExceptionReason: '供应商当日临时涨价，已核对并同意' })

    act(() => root.unmount())
    container.remove()
  })

  it('无价格例外权限时只显示等待管理员核价且不提供复核按钮', async () => {
    const pending = {
      ...postedReceipt,
      status: 'PENDING_REVIEW',
      reviewReasons: ['ABOVE_STANDARD_PRICE'],
      _count: { lines: 1, claims: 0 },
    }
    installPageMock({
      receipts: [pending],
      receiptDetailValue: {
        ...receiptDetail,
        ...pending,
        canApprovePriceException: false,
      },
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('到货验收') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '到货验收')?.click())
    await waitFor(() => container.textContent?.includes('查看明细并复核') ?? false)
    await act(async () => { Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '查看明细并复核')?.click() })

    await waitFor(() => container.textContent?.includes('需等待管理员核价') ?? false)
    expect(container.textContent).not.toContain('价格例外复核原因（必填）')
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === '确认复核并入库')).toBe(false)

    act(() => root.unmount())
    container.remove()
  })

  it('填写标准草稿后取消侧栏跳转会保留当前页面和输入', async () => {
    installPageMock()
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('价格与质量标准') ?? false)
    act(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '价格与质量标准')?.click())
    await waitFor(() => container.textContent?.includes('新版本·商品质量验收标准') ?? false)
    const title = container.querySelector('input[placeholder*="黑牛肝菌"]') as HTMLInputElement
    change(title, '临时质量标准草稿')

    const event = new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, { cancelable: true })
    let allowed = true
    act(() => { allowed = window.dispatchEvent(event) })

    expect(allowed).toBe(false)
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('放弃未提交的内容')
    act(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '取消')?.click())
    expect(title.value).toBe('临时质量标准草稿')
    act(() => root.unmount())
    container.remove()
  })
})
