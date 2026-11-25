// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WarehouseStocktakeWorkPage from './page'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props}>{children}</a>,
}))
const roleFixture=vi.hoisted(()=>({role:'SUPPLY_CHAIN'}))
const navigation=vi.hoisted(()=>({push:vi.fn()}))
vi.mock('next/navigation',()=>({useRouter:()=>navigation}))
vi.mock('@/lib/v2-auth', () => ({
  apiFetch: vi.fn(),
  getUser: () => ({ id: 'user-1', role: roleFixture.role }),
}))

import { apiFetch } from '@/lib/v2-auth'

const mockFetch = vi.mocked(apiFetch)

const options = {
  warehouses: [{ id: 'warehouse-1', code: 'WH-01', name: '总仓' }],
  users: [{ id: 'user-1', name: '盘点员甲' }, { id: 'user-2', name: '盘点员乙' }],
  products: [{ id: 'product-1', code: 'P-01', name: '土豆', inventoryUnit: 'kg', unit: 'kg' }],
  plans: [],
}

function previewFor(body?: string) {
  const input = JSON.parse(body || '{}')
  const selected = input.countScope === 'SELECTED' ? input.manualProductIds || [] : options.products.map(row => row.id)
  return {
    countScope: input.countScope || 'ALL',
    selectionRule: input.countScope === 'SELECTED' ? 'MANUAL_SELECTED' : input.countScope === 'DAILY' || input.countScope === 'WEEKLY' ? 'PERIOD_MOVEMENT_OR_OPENING' : 'ALL_ENABLED',
    periodUnit: input.countScope === 'DAILY' ? 'DAY' : input.countScope === 'WEEKLY' ? 'WEEK' : null,
    selectionFingerprint: 'a'.repeat(64), plan: null,
    products: options.products.filter(row => selected.includes(row.id)).map(row => ({ ...row, reasonCode: 'TEST' })),
  }
}

const makeCount = (status = 'COUNTING'): any => ({
  id: 'count-1', no: 'WSC-20260929-001', status, rowVersion: 3,
  countDate: '2026-09-29T00:00:00.000Z', note: '月末盘点', countScope: 'SELECTED', postingCycle: 0,
  createdBy: { id: 'user-1', name: '盘点员甲' }, submittedBy: null,
  sourceMultiId: null, generatedStocktakeId: null, mergeSources: [], generatedFrom: [],
  warehouse: options.warehouses[0], countedCount: 0, itemCount: 2, totalDifferenceValue: '0', adjustments: [],
  sections: [
    {
      id: 'section-own', name: '冷库', assignedToId: 'user-1', status: 'OPEN', rowVersion: 4, submittedAt: null,
      items: [{
        id: 'item-own', productId: 'product-1', productNameSnapshot: '土豆', productCodeSnapshot: 'P-01', productSpecSnapshot: '10kg/箱', inventoryUnit: 'kg',
        bookQuantity: '10', averageUnitCost: '2', countedQuantity: null, countedUnitCost: null,
        differenceQuantity: null, differenceValue: null, reason: null,
      }],
    },
    {
      id: 'section-other', name: '干货区', assignedToId: 'user-2', status: 'OPEN', rowVersion: 2, submittedAt: null,
      items: [{
        id: 'item-other', productId: 'product-2', productNameSnapshot: '大米', productCodeSnapshot: 'P-02', productSpecSnapshot: null, inventoryUnit: 'kg',
        bookQuantity: '20', averageUnitCost: '3', countedQuantity: null, countedUnitCost: null,
        differenceQuantity: null, differenceValue: null, reason: null,
      }],
    },
  ],
})

function setupFetch(count = makeCount()) {
  mockFetch.mockImplementation((path, init) => {
    const url = String(path)
    if (url === '/api/warehouse-stocktakes/options') return Promise.resolve(options)
    if (url === '/api/warehouse-stocktake-selection/preview' && init?.method === 'POST') return Promise.resolve(previewFor(String(init.body)))
    if (url.startsWith('/api/warehouse-stocktakes?page=1&pageSize=50&documentType=')) {
      return Promise.resolve({ rows: [{ id: count.id, no: count.no, status: count.status, warehouse: count.warehouse }], total: 1 })
    }
    if (url === `/api/warehouse-stocktakes/${count.id}`) return Promise.resolve(count)
    if (url === `/api/warehouse-stocktakes/${count.id}/sections/section-own` && init?.method === 'PUT') return Promise.resolve({ ok: true })
    return Promise.reject(new Error(`unexpected API: ${url}`))
  })
}

function renderPage(from: 'count' | 'multi-count' = 'count') {
  window.history.replaceState({}, '', `/v2/supply-chain/stocktake/work?doc=count-1&from=${from}`)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<WarehouseStocktakeWorkPage />))
  return { container, root }
}

async function waitFor(predicate: () => boolean, timeout = 1000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

function change(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function button(container: Element, text: string) {
  return Array.from(container.querySelectorAll('button')).find(item => item.textContent === text) as HTMLButtonElement | undefined
}

describe('总仓盘点作业', () => {
  beforeEach(() => {
    roleFixture.role='SUPPLY_CHAIN'
    navigation.push.mockClear()
    sessionStorage.clear()
    localStorage.setItem('tenant', JSON.stringify({ id: 'tenant-1' }))
    mockFetch.mockReset()
    setupFetch()
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('只允许负责人编辑自己的分区，并按会议版接口提交版本与实盘值', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('WSC-20260929-001') ?? false)

    const own = container.querySelector('[aria-label="土豆实盘数量"]') as HTMLInputElement
    const other = container.querySelector('[aria-label="大米实盘数量"]') as HTMLInputElement
    expect(own.disabled).toBe(false)
    expect(other.disabled).toBe(true)

    change(own, '12.5')
    await act(async () => { button(container, '保存我的分区')?.click() })
    await waitFor(() => mockFetch.mock.calls.some(([path, init]) => String(path).endsWith('/sections/section-own') && init?.method === 'PUT'))

    const call = mockFetch.mock.calls.find(([path, init]) => String(path).endsWith('/sections/section-own') && init?.method === 'PUT')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      rowVersion: 4,
      submit: false,
      items: [{ itemId: 'item-own', countedQuantity: '12.5', countedUnitCost: '2', reason: '' }],
    })
    expect(container.textContent).toContain('冷库已保存')

    act(() => root.unmount())
  })

  it('非创建人不显示普通单汇总提交和取消，多人子单仅创建负责人本人可提交', async () => {
    const foreign = makeCount()
    foreign.createdBy = { id: 'user-2', name: '盘点员乙' }
    foreign.sections[0].status = 'SUBMITTED'
    setupFetch(foreign)
    let page = renderPage('count')
    await waitFor(() => page.container.textContent?.includes(foreign.no) ?? false)
    expect(button(page.container, '汇总提交审核')).toBeUndefined()
    expect(button(page.container, '取消盘点')).toBeUndefined()
    act(() => page.root.unmount())
    document.body.replaceChildren()

    setupFetch(foreign)
    page = renderPage('multi-count')
    await waitFor(() => page.container.textContent?.includes(foreign.no) ?? false)
    expect(button(page.container, '提交审核')).toBeUndefined()
    act(() => page.root.unmount())
  })

  it('批量按账面或填零只处理本人分区空白项，不覆盖已有实盘值', async () => {
    const count = makeCount()
    count.sections[0].items.push({
      ...count.sections[0].items[0],
      id: 'item-own-second',
      productId: 'product-3',
      productNameSnapshot: '白菜',
      productCodeSnapshot: 'P-03',
      bookQuantity: '6.5',
      countedQuantity: '4',
    })
    setupFetch(count)
    const page = renderPage()
    await waitFor(() => Boolean(page.container.querySelector('[aria-label="白菜实盘数量"]')))
    const potato = page.container.querySelector('[aria-label="土豆实盘数量"]') as HTMLInputElement
    const cabbage = page.container.querySelector('[aria-label="白菜实盘数量"]') as HTMLInputElement
    const rice = page.container.querySelector('[aria-label="大米实盘数量"]') as HTMLInputElement

    await act(async () => button(page.container, '空白按账面填充')!.click())
    expect(potato.value).toBe('10')
    expect(cabbage.value).toBe('4')
    expect(rice.value).toBe('')
    expect(page.container.textContent).toContain('已有实盘值未覆盖')

    change(potato, '')
    await act(async () => button(page.container, '空白填零')!.click())
    expect(potato.value).toBe('0')
    expect(cabbage.value).toBe('4')
    expect(rice.value).toBe('')
    expect(mockFetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    act(() => page.root.unmount())
  })

  it.each(['保存我的分区', '提交我的分区'])('清空已保存实盘数量时%s拒绝混合写入且保留全部输入', async action => {
    const count = makeCount()
    count.sections[0].items[0].countedQuantity = '10'
    count.sections[0].items.push({ ...count.sections[0].items[0], id: 'item-own-second', productNameSnapshot: '白菜', countedQuantity: null })
    setupFetch(count)
    const { container, root } = renderPage()
    await waitFor(() => Boolean(container.querySelector('[aria-label="白菜实盘数量"]')))
    const recorded = container.querySelector('[aria-label="土豆实盘数量"]') as HTMLInputElement
    const fresh = container.querySelector('[aria-label="白菜实盘数量"]') as HTMLInputElement
    change(recorded, '')
    change(fresh, '7')
    await act(async () => { button(container, action)!.click() })
    expect(mockFetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    expect(container.textContent).toContain('不能清空后保存')
    expect(recorded.value).toBe('')
    expect(fresh.value).toBe('7')
    expect(container.textContent).not.toContain('冷库已保存')
    change(recorded, '0')
    change(recorded.closest('tr')!.querySelector('input[type="text"], input:not([type])') as HTMLInputElement, '清零复核')
    change(fresh.closest('tr')!.querySelector('input[type="text"], input:not([type])') as HTMLInputElement, '实盘复核')
    await act(async () => { button(container, action)!.click() })
    const call = mockFetch.mock.calls.find(([, init]) => init?.method === 'PUT')!
    expect(JSON.parse(String(call[1]?.body)).items.map((item: any) => item.countedQuantity)).toEqual(['0', '7'])
    act(() => root.unmount())
  })

  it('有差异未填原因不能提交锁定分区，补原因后仍能提交', async () => {
    const page = renderPage()
    await waitFor(() => Boolean(page.container.querySelector('[aria-label="土豆实盘数量"]')))
    const input = page.container.querySelector('[aria-label="土豆实盘数量"]') as HTMLInputElement
    change(input, '12')
    await act(async () => button(page.container, '提交我的分区')!.click())
    expect(mockFetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    expect(page.container.textContent).toContain('填写盘盈/盘亏原因后再提交分区')
    expect(input.value).toBe('12')
    const reason = input.closest('tr')!.querySelector('input:not([type])') as HTMLInputElement
    change(reason, '实盘复核')
    await act(async () => button(page.container, '提交我的分区')!.click())
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
    act(() => page.root.unmount())
  })

  it('大数量的微小差异仍要求原因，非法数量优先提示格式并保留输入', async () => {
    const count = makeCount()
    count.sections[0].items[0].bookQuantity = '9999999999.000002'
    setupFetch(count)
    const page = renderPage()
    await waitFor(() => Boolean(page.container.querySelector('[aria-label="土豆实盘数量"]')))
    const input = page.container.querySelector('[aria-label="土豆实盘数量"]') as HTMLInputElement
    change(input, '9999999999.000001')
    await act(async () => button(page.container, '提交我的分区')!.click())
    expect(page.container.textContent).toContain('填写盘盈/盘亏原因后再提交分区')
    expect(mockFetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    change(input, '-1')
    await act(async () => button(page.container, '提交我的分区')!.click())
    expect(page.container.textContent).toContain('实盘数量格式不正确')
    expect(input.value).toBe('-1')
    expect(mockFetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    change(input, '9999999999.000002')
    await act(async () => button(page.container, '提交我的分区')!.click())
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
    act(() => page.root.unmount())
  })

  it('零差异分区不要求新增原因即可提交', async () => {
    const page = renderPage()
    await waitFor(() => Boolean(page.container.querySelector('[aria-label="土豆实盘数量"]')))
    change(page.container.querySelector('[aria-label="土豆实盘数量"]') as HTMLInputElement, '10')
    await act(async () => button(page.container, '提交我的分区')!.click())
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
    act(() => page.root.unmount())
  })

  it('保留盘点复盘直达入口和会议版分区提交状态', async () => {
    const count = makeCount()
    count.sections[0].status = 'SUBMITTED'
    count.sections[0].submittedAt = '2026-09-29T08:00:00.000Z'
    setupFetch(count)
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('WSC-20260929-001') ?? false)

    expect(container.querySelector('a[href="/v2/supply-chain/stocktake/count/count-1?source=warehouse"]')?.textContent).toContain('查看差异')
    expect(container.textContent).toContain('冷库 · 盘点员甲 · 已提交')
    expect((container.querySelector('[aria-label="土豆实盘数量"]') as HTMLInputElement).disabled).toBe(true)
    expect(button(container, '保存我的分区')).toBeUndefined()
    expect(button(container, '提交我的分区')).toBeUndefined()

    act(() => root.unmount())
  })

  it('新建盘点明确提供全部盘点与指定盘点，并支持按分类全选', async () => {
    const { container, root } = renderPage('multi-count')
    await waitFor(() => container.textContent?.includes('WSC-20260929-001') ?? false)

    act(() => { button(container, '新建多人盘点子单')?.click() })
    expect(container.querySelector('input[type="radio"][checked]')?.parentElement?.textContent).toContain('全部盘点')
    expect(container.textContent).toContain('盘点该仓库当前全部 1 个商品')
    for (const oldCopy of ['逐分区分配', '各负责人录入', '我的分区', '汇总提交审核', '各分区进度']) expect(container.textContent).not.toContain(oldCopy)

    const specified = Array.from(container.querySelectorAll('input[type="radio"]')).at(-1) as HTMLInputElement
    act(() => { specified.click() })
    expect(container.textContent).toContain('全选分类：未分类')

    act(() => root.unmount())
  })
  it.skip('旧分区负责人模型已由美团独立子单模型替代', async () => {
    const products = [
      { ...options.products[0], unitConversionStatus: 'VERIFIED' },
      { id: 'product-2', code: 'P-02', name: '待核验大米', unit: 'kg', inventoryUnit: 'kg', unitConversionStatus: 'PENDING' },
    ]
    const count = makeCount('DRAFT')
    mockFetch.mockImplementation(async (path, init) => {
      if (path === '/api/warehouse-stocktakes/options') return { ...options, products } as any
      if (path === '/api/warehouse-stocktake-selection/preview') {
        const input = JSON.parse(String(init?.body || '{}'))
        return { ...previewFor(String(init?.body)), products: products.filter(row => (input.manualProductIds || []).includes(row.id)).map(row => ({ ...row, reasonCode: 'TEST' })) } as any
      }
      if (path === '/api/warehouse-stocktakes' && init?.method === 'POST') return { stocktake: count } as any
      if (String(path).endsWith('/count-1')) return count
      return { rows: [] } as any
    })
    const { container, root } = renderPage('multi-count')
    await waitFor(() => container.textContent?.includes('冷库') ?? false)
    act(() => button(container, '新建多人盘点子单')!.click())
    expect(container.textContent).toContain('换算待核验，可保存草稿')
    act(() => button(container, '添加分区 / 负责人')!.click())
    await act(async () => button(container, '保存子单草稿')!.click())
    expect(mockFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    const sectionBlocks = Array.from(container.querySelectorAll('input')).filter(input => input.parentElement?.textContent?.startsWith('分区名')).map(input => input.parentElement!.parentElement!.parentElement!)
    const pick = (block: Element, name: string) => Array.from(block.querySelectorAll('label')).find(label => label.textContent?.includes(name))!.querySelector('input')!
    act(() => pick(sectionBlocks[0], 'P-01 土豆').click())
    act(() => pick(sectionBlocks[1], 'P-02 待核验大米').click())
    const assignee = sectionBlocks[1].querySelector('select')!
    act(() => { assignee.value = 'user-2'; assignee.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => button(container, '保存盘点草稿')!.click())
    const call = mockFetch.mock.calls.find(([, init]) => init?.method === 'POST')!
    const body = JSON.parse(String(call[1]?.body))
    expect(body.documentType).toBe('MULTI')
    expect(body.countScope).toBe('ALL')
    expect(body.sections.map((section: any) => section.assignedToId)).toEqual(['user-1', 'user-2'])
    expect(body.sections.map((section: any) => section.productIds)).toEqual([['product-1'], ['product-2']])
    act(() => root.unmount())
  })
  it('按名称或规格搜索后全选只选择搜索结果，不选择隐藏商品', async () => {
    const products = ['土豆', '白菜', '萝卜'].map((name, index) => ({ id: `p${index}`, code: `P${index}`, name, spec: index === 1 ? '10kg/袋' : '散装', category: '蔬菜类', inventoryUnit: 'kg', unit: 'kg' }))
    const count = makeCount()
    mockFetch.mockImplementation(async (path, init) => {
      if (path === '/api/warehouse-stocktakes/options') return { ...options, products } as any
      if (path === '/api/warehouse-stocktake-selection/preview') {
        const input = JSON.parse(String(init?.body || '{}'))
        return { ...previewFor(String(init?.body)), products: products.filter(row => (input.manualProductIds || []).includes(row.id)).map(row => ({ ...row, reasonCode: 'TEST' })) } as any
      }
      if (path === '/api/warehouse-stocktakes' && init?.method === 'POST') return { stocktake: count } as any
      if (String(path).endsWith('/count-1')) return count
      return { rows: [] } as any
    })
    const { container, root } = renderPage('multi-count')
    await waitFor(() => container.textContent?.includes('WSC-20260929-001') ?? false)
    act(() => button(container, '新建多人盘点子单')!.click())
    act(() => (Array.from(container.querySelectorAll('input[type="radio"]')).at(-1) as HTMLInputElement).click())
    const search = container.querySelector('input[placeholder="商品名称 / 编码"]') as HTMLInputElement
    change(search, '土豆')
    const category = Array.from(container.querySelectorAll('label')).find(label => label.textContent?.includes('全选搜索结果：蔬菜类'))!.querySelector('input')!
    act(() => category.click())
    expect(container.textContent).toContain('已选择 1 项')
    act(() => category.click())
    expect(container.textContent).toContain('已选择 0 项')
    change(search, '10kg/袋')
    const specificationCategory = Array.from(container.querySelectorAll('label')).find(label => label.textContent?.includes('全选搜索结果：蔬菜类'))!.querySelector('input')!
    act(() => specificationCategory.click())
    await act(async () => button(container, '保存子单草稿')!.click())
    const call = mockFetch.mock.calls.find(([path, init]) => path === '/api/warehouse-stocktakes' && init?.method === 'POST')!
    expect(JSON.parse(String(call[1]?.body)).sections[0].productIds).toEqual(['p1'])
    act(() => root.unmount())
  })

  it('服务端搜索全部盘点单、支持分页并忽略过期搜索响应', async () => {
    const count = makeCount()
    let resolveOld: ((value: any) => void) | null = null
    const oldSearch = new Promise(resolve => { resolveOld = resolve })
    setupFetch(count)
    const original = mockFetch.getMockImplementation()!
    mockFetch.mockImplementation((path, init) => {
      const url = String(path)
      if (url.includes('q=%E6%97%A7%E5%8D%95')) return oldSearch
      if (url.includes('page=2') && url.includes('q=%E6%96%B0%E5%8D%95')) return Promise.resolve({ rows: [{ id: 'new-count-2', no: '新单第二页', status: 'DRAFT', warehouse: count.warehouse }], total: 51 })
      if (url.includes('q=%E6%96%B0%E5%8D%95')) return Promise.resolve({ rows: [{ id: 'new-count', no: '新单命中', status: 'DRAFT', warehouse: count.warehouse }], total: 51 })
      return original(path, init)
    })
    const page = renderPage()
    await waitFor(() => page.container.textContent?.includes(count.no) ?? false)
    const search = page.container.querySelector('[aria-label="搜索盘点单"]') as HTMLInputElement
    change(search, '旧单')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    change(search, '新单')
    await waitFor(() => page.container.textContent?.includes('新单命中') ?? false)
    await act(async () => resolveOld?.({ rows: [{ id: 'old-count', no: '过期旧单', status: 'DRAFT', warehouse: count.warehouse }], total: 1 }))
    expect(page.container.textContent).not.toContain('过期旧单')
    expect(page.container.textContent).toContain('共 51 张')
    act(() => button(page.container, '下一页')!.click())
    await waitFor(() => page.container.textContent?.includes('新单第二页') ?? false)
    act(() => page.root.unmount())
  })

  it('单人指定盘点只选一个菌菇即可保存，空选择不会发创建请求', async () => {
    const products = [
      { id: 'mushroom-1', code: 'ZZ9M-M1', name: '人工见手青', category: '人工菌', inventoryUnit: 'kg', unit: 'kg' },
      { id: 'mushroom-2', code: 'ZZ9M-M2', name: '人工鸡枞菌', category: '人工菌', inventoryUnit: 'kg', unit: 'kg' },
    ]
    const count = { ...makeCount('DRAFT'), documentType: 'FORMAL', itemCount: 1, sections: [{ ...makeCount('DRAFT').sections[0], items: [makeCount('DRAFT').sections[0].items[0]] }] }
    mockFetch.mockImplementation(async (path, init) => {
      if (path === '/api/warehouse-stocktakes/options') return { ...options, products } as any
      if (path === '/api/warehouse-stocktake-selection/preview') {
        const input = JSON.parse(String(init?.body || '{}'))
        return {
          countScope: 'SELECTED', selectionRule: 'MANUAL_SELECTED', periodUnit: null,
          selectionFingerprint: 'a'.repeat(64), plan: null,
          products: products.filter(product => (input.manualProductIds || []).includes(product.id)).map(product => ({ ...product, reasonCode: 'MANUAL_SELECTED' })),
        } as any
      }
      if (path === '/api/warehouse-stocktakes' && init?.method === 'POST') return { stocktake: count } as any
      if (String(path).endsWith('/count-1')) return count as any
      return { rows: [] } as any
    })
    const { container, root } = renderPage('count')
    await waitFor(() => container.textContent?.includes('WSC-20260929-001') ?? false)
    act(() => button(container, '新建盘点单')!.click())
    act(() => (Array.from(container.querySelectorAll('input[type="radio"]')).at(-1) as HTMLInputElement).click())

    await act(async () => button(container, '保存盘点草稿')!.click())
    expect(container.textContent).toContain('请至少选择一个盘点商品')
    expect(mockFetch.mock.calls.some(([path, init]) => path === '/api/warehouse-stocktakes' && init?.method === 'POST')).toBe(false)

    const mushroom = Array.from(container.querySelectorAll('label')).find(label => label.textContent?.includes('ZZ9M-M1 人工见手青'))!.querySelector('input')!
    act(() => mushroom.click())
    await act(async () => button(container, '保存盘点草稿')!.click())
    const call = mockFetch.mock.calls.find(([path, init]) => path === '/api/warehouse-stocktakes' && init?.method === 'POST')!
    const body = JSON.parse(String(call[1]?.body))
    expect(body.documentType).toBe('FORMAL')
    expect(body.sections).toEqual([{ name: '单人盘点', assignedToId: 'user-1', productIds: ['mushroom-1'] }])
    act(() => root.unmount())
  })

  it('创建响应丢失后冻结原请求，双击和刷新重试不更换请求内容', async () => {
    const count = makeCount('DRAFT')
    let posts = 0
    mockFetch.mockImplementation(async (path, init) => {
      if (path === '/api/warehouse-stocktakes/options') return options as any
      if (path === '/api/warehouse-stocktake-selection/preview') return previewFor(String(init?.body)) as any
      if (path === '/api/warehouse-stocktakes' && init?.method === 'POST') {
        posts += 1
        if (posts === 1) throw new Error('网络响应丢失')
        return { stocktake: count } as any
      }
      if (String(path).endsWith('/count-1')) return count
      return { rows: [] } as any
    })
    let page = renderPage('multi-count')
    await waitFor(() => page.container.textContent?.includes('WSC-20260929-001') ?? false)
    act(() => button(page.container, '新建多人盘点子单')!.click())
    await act(async () => { const save = button(page.container, '保存子单草稿')!; save.click(); save.click() })
    expect(posts).toBe(1)
    const firstBody = mockFetch.mock.calls.find(([path, init]) => path === '/api/warehouse-stocktakes' && init?.method === 'POST')![1]!.body
    expect(page.container.textContent).toContain('创建结果未确认')
    expect((page.container.querySelector('input[type="date"]') as HTMLInputElement).closest('fieldset')!.disabled).toBe(true)
    expect(sessionStorage.getItem('dj:stocktake-create:tenant-1:user-1:multi-count')).not.toBeNull()
    act(() => page.root.unmount())
    page.container.remove()
    page = renderPage('multi-count')
    await waitFor(() => page.container.textContent?.includes('已恢复上次结果未确认') ?? false)
    await act(async () => button(page.container, '重试原创建请求')!.click())
    expect(posts).toBe(2)
    expect(mockFetch.mock.calls.filter(([path, init]) => path === '/api/warehouse-stocktakes' && init?.method === 'POST').map(([, init]) => init!.body)).toEqual([firstBody, firstBody])
    expect(sessionStorage.getItem('dj:stocktake-create:tenant-1:user-1:multi-count')).toBeNull()
    expect(page.container.textContent).toContain('多人盘点子单已创建')
    act(() => page.root.unmount())
  })

  it('首次明确拒绝允许修正，但损坏恢复记录不覆盖或发送新请求', async () => {
    const existing = mockFetch.getMockImplementation()!
    mockFetch.mockImplementation((path, init) => path === '/api/warehouse-stocktakes' && init?.method === 'POST'
      ? Promise.reject(Object.assign(new Error('负责人不合法'), { status: 400 }))
      : existing(path, init))
    let page = renderPage('multi-count')
    await waitFor(() => page.container.textContent?.includes('WSC-20260929-001') ?? false)
    act(() => button(page.container, '新建多人盘点子单')!.click())
    await act(async () => button(page.container, '保存子单草稿')!.click())
    expect(page.container.textContent).toContain('负责人不合法')
    expect(sessionStorage.getItem('dj:stocktake-create:tenant-1:user-1')).toBeNull()
    expect((page.container.querySelector('input[type="date"]') as HTMLInputElement).closest('fieldset')!.disabled).toBe(false)
    act(() => page.root.unmount()); page.container.remove()
    sessionStorage.setItem('dj:stocktake-create:tenant-1:user-1', '{broken')
    const before = mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST').length
    page = renderPage('multi-count')
    await waitFor(() => !!button(page.container, '重试原创建请求'))
    await act(async () => button(page.container, '重试原创建请求')!.click())
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(before)
    expect(sessionStorage.getItem('dj:stocktake-create:tenant-1:user-1')).toBe('{broken')
    act(() => page.root.unmount())
  })

  it('待核验项目不显示虚构成本，提交返回明确提示且不发写请求', async () => {
    const count = makeCount('DRAFT')
    count.sections[0].items[0].unitPending = true
    setupFetch(count)
    const page = renderPage()
    await waitFor(() => page.container.textContent?.includes('换算待核验，账面和成本待确认') ?? false)
    const article = page.container.querySelector('tbody tr')!
    const inputs = article.querySelectorAll<HTMLInputElement>('input')
    expect(inputs[0].disabled).toBe(true)
    expect(inputs[1].value).toBe('')
    await act(async () => button(page.container, '提交我的分区')!.click())
    expect(page.container.textContent).toContain('分区存在待核验换算，请先补齐并刷新换算后提交')
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0)
    act(() => page.root.unmount())
  })

  it('多人盘点审核提示明确不直接改库存，不冒充正式盘点复审', async () => {
    setupFetch(makeCount('REVIEWING'))
    const page = renderPage('multi-count')
    await waitFor(() => Boolean(button(page.container, '审核')))
    act(() => button(page.container, '审核')!.click())
    expect(page.container.textContent).toContain('审核完成后可以生成一张独立的正式盘点单')
    expect(page.container.textContent).toContain('这张多人盘点单不直接改变库存和金额')
    act(() => page.root.unmount())
  })

  it('多人盘点只展示独立子单语义，不再暴露旧分区负责人模型', async () => {
    const count = makeCount()
    count.documentType = 'MULTI'
    count.sections = [count.sections[0]]
    setupFetch(count)
    const page = renderPage('multi-count')
    await waitFor(() => Boolean(button(page.container, '提交审核')))
    expect(button(page.container, '保存子单')).toBeDefined()
    for (const oldCopy of ['逐分区分配', '各负责人录入', '我的分区', '汇总提交审核', '各分区进度', '负责人']) {
      expect(page.container.textContent).not.toContain(oldCopy)
    }
    expect(page.container.textContent).toContain('独立子单')
    act(() => page.root.unmount())
  })

  it('多人子单一次提交审核依次锁定明细并提交整单', async () => {
    let current = makeCount()
    current.documentType = 'MULTI'
    current.sections = [current.sections[0]]
    mockFetch.mockImplementation(async (path, init) => {
      const url = String(path)
      if (url === '/api/warehouse-stocktakes/options') return options as any
      if (url.includes('?page=')) return { rows: [{ id: current.id, no: current.no, status: current.status, warehouse: current.warehouse }] } as any
      if (url === `/api/warehouse-stocktakes/${current.id}`) return structuredClone(current)
      if (url.endsWith('/sections/section-own') && init?.method === 'PUT') {
        current = structuredClone(current); current.rowVersion = 4; current.sections[0].status = 'SUBMITTED'; current.sections[0].rowVersion = 5
        return structuredClone(current)
      }
      if (url.endsWith('/submit') && init?.method === 'POST') {
        current = structuredClone(current); current.status = 'REVIEWING'; current.rowVersion = 5
        return structuredClone(current)
      }
      throw new Error(`unexpected API: ${url}`)
    })
    const page = renderPage('multi-count')
    await waitFor(() => Boolean(page.container.querySelector('[aria-label="土豆实盘数量"]')))
    change(page.container.querySelector('[aria-label="土豆实盘数量"]') as HTMLInputElement, '10')
    act(() => button(page.container, '提交审核')!.click())
    expect(page.container.textContent).toContain('锁定这张独立子单')
    const confirmations = Array.from(page.container.querySelectorAll('button')).filter(item => item.textContent === '提交审核')
    await act(async () => confirmations.at(-1)!.click())
    await waitFor(() => page.container.textContent?.includes('多人盘点子单已提交审核') ?? false)
    const put = mockFetch.mock.calls.find(([path, init]) => String(path).endsWith('/sections/section-own') && init?.method === 'PUT')!
    expect(JSON.parse(String(put[1]?.body))).toMatchObject({ rowVersion: 4, submit: true, items: [{ itemId: 'item-own', countedQuantity: '10' }] })
    const submit = mockFetch.mock.calls.find(([path, init]) => String(path).endsWith('/submit') && init?.method === 'POST')!
    expect(JSON.parse(String(submit[1]?.body))).toEqual({ rowVersion: 4 })
    expect(button(page.container, '汇总提交审核')).toBeUndefined()
    act(() => page.root.unmount())
  })

  it('多人子单明细已锁定但整单提交失败时可续提且不重复写明细', async () => {
    let current = makeCount()
    current.documentType = 'MULTI'
    current.sections = [current.sections[0]]
    let submitAttempts = 0
    mockFetch.mockImplementation(async (path, init) => {
      const url = String(path)
      if (url === '/api/warehouse-stocktakes/options') return options as any
      if (url.includes('?page=')) return { rows: [{ id: current.id, no: current.no, status: current.status, warehouse: current.warehouse }] } as any
      if (url === `/api/warehouse-stocktakes/${current.id}`) return structuredClone(current)
      if (url.endsWith('/sections/section-own') && init?.method === 'PUT') {
        current = structuredClone(current); current.rowVersion = 4; current.sections[0].status = 'SUBMITTED'; current.sections[0].rowVersion = 5
        return structuredClone(current)
      }
      if (url.endsWith('/submit') && init?.method === 'POST') {
        submitAttempts += 1
        if (submitAttempts === 1) throw new Error('提交网络中断')
        current = structuredClone(current); current.status = 'REVIEWING'; current.rowVersion = 5
        return structuredClone(current)
      }
      throw new Error(`unexpected API: ${url}`)
    })
    const page = renderPage('multi-count')
    await waitFor(() => Boolean(page.container.querySelector('[aria-label="土豆实盘数量"]')))
    change(page.container.querySelector('[aria-label="土豆实盘数量"]') as HTMLInputElement, '10')
    act(() => button(page.container, '提交审核')!.click())
    let confirmations = Array.from(page.container.querySelectorAll('button')).filter(item => item.textContent === '提交审核')
    await act(async () => confirmations.at(-1)!.click())
    await waitFor(() => page.container.textContent?.includes('子单实盘内容已保存并锁定') ?? false)
    expect(mockFetch.mock.calls.filter(([path, init]) => String(path).endsWith('/sections/section-own') && init?.method === 'PUT')).toHaveLength(1)
    act(() => button(page.container, '提交审核')!.click())
    confirmations = Array.from(page.container.querySelectorAll('button')).filter(item => item.textContent === '提交审核')
    await act(async () => confirmations.at(-1)!.click())
    await waitFor(() => page.container.textContent?.includes('多人盘点子单已提交审核') ?? false)
    expect(mockFetch.mock.calls.filter(([path, init]) => String(path).endsWith('/sections/section-own') && init?.method === 'PUT')).toHaveLength(1)
    expect(submitAttempts).toBe(2)
    act(() => page.root.unmount())
  })

  it('多人子单首个PUT服务端成功但响应丢失时重载后只续提整单', async () => {
    let current = makeCount()
    current.documentType = 'MULTI'; current.sections = [current.sections[0]]
    let putAttempts = 0
    mockFetch.mockImplementation(async (path, init) => {
      const url = String(path)
      if (url === '/api/warehouse-stocktakes/options') return options as any
      if (url.includes('?page=')) return { rows: [{ id: current.id, no: current.no, status: current.status, warehouse: current.warehouse }] } as any
      if (url === `/api/warehouse-stocktakes/${current.id}`) return structuredClone(current)
      if (url.endsWith('/sections/section-own') && init?.method === 'PUT') {
        putAttempts += 1
        current = structuredClone(current); current.rowVersion = 4; current.sections[0].status = 'SUBMITTED'; current.sections[0].rowVersion = 5
        throw new Error('PUT响应丢失')
      }
      if (url.endsWith('/submit') && init?.method === 'POST') {
        current = structuredClone(current); current.status = 'REVIEWING'; current.rowVersion = 5
        return structuredClone(current)
      }
      throw new Error(`unexpected API: ${url}`)
    })
    const page = renderPage('multi-count')
    await waitFor(() => Boolean(page.container.querySelector('[aria-label="土豆实盘数量"]')))
    change(page.container.querySelector('[aria-label="土豆实盘数量"]') as HTMLInputElement, '10')
    act(() => button(page.container, '提交审核')!.click())
    let confirmations = Array.from(page.container.querySelectorAll('button')).filter(item => item.textContent === '提交审核')
    await act(async () => confirmations.at(-1)!.click())
    await waitFor(() => page.container.textContent?.includes('PUT响应丢失') ?? false)
    expect(putAttempts).toBe(1)
    act(() => button(page.container, '提交审核')!.click())
    confirmations = Array.from(page.container.querySelectorAll('button')).filter(item => item.textContent === '提交审核')
    await act(async () => confirmations.at(-1)!.click())
    await waitFor(() => page.container.textContent?.includes('多人盘点子单已提交审核') ?? false)
    expect(putAttempts).toBe(1)
    expect(mockFetch.mock.calls.filter(([path, init]) => String(path).endsWith('/submit') && init?.method === 'POST')).toHaveLength(1)
    act(() => page.root.unmount())
  })

  it('正式盘点审核立即过账且已审核单调用真实安全反审核接口', async () => {
    const reviewing = makeCount('REVIEWING')
    reviewing.documentType = 'FORMAL'
    setupFetch(reviewing)
    let page = renderPage('count')
    await waitFor(() => Boolean(button(page.container, '审核')))
    act(() => button(page.container, '审核')!.click())
    expect(page.container.textContent).toContain('审核后立即按实盘数调整库存并生成盘盈/盘亏单')
    expect(page.container.textContent).not.toContain('复盘审核后才按差额调整库存')
    expect(page.container.textContent).not.toContain('审核只改变状态')
    act(() => page.root.unmount()); page.container.remove()

    const confirmed = makeCount('CONFIRMED')
    confirmed.documentType = 'FORMAL'; confirmed.postingPolicy = 'REVIEW'; confirmed.reviewStatus = 'UNREVIEWED'
    const writes: Array<[string, any]> = []
    mockFetch.mockImplementation(async (path, init) => {
      const url = String(path)
      if (url === '/api/warehouse-stocktakes/options') return options as any
      if (url.includes('?page=')) return { rows: [{ id: confirmed.id, no: confirmed.no, status: confirmed.status, warehouse: confirmed.warehouse }] } as any
      if (url === `/api/warehouse-stocktakes/${confirmed.id}`) return structuredClone(confirmed)
      if (url === `/api/warehouse-stocktakes/${confirmed.id}/reverse-approval` && init?.method === 'POST') { writes.push([url, init]); return {} as any }
      throw new Error(`unexpected API: ${url}`)
    })
    page = renderPage('count')
    await waitFor(() => Boolean(button(page.container, '复盘审核')))
    act(() => button(page.container, '反审核')!.click())
    const reason = page.container.querySelector('textarea[placeholder="请填写反审核原因"]') as HTMLTextAreaElement
    act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(reason, '复核录入错误'); reason.dispatchEvent(new Event('input', { bubbles: true })); reason.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => button(page.container, '确认')!.click())
    await waitFor(() => writes.length === 1)
    expect(writes[0][0]).toBe('/api/warehouse-stocktakes/count-1/reverse-approval')
    expect(JSON.parse(String(writes[0][1].body))).toMatchObject({ reason: '复核录入错误', rowVersion: 3 })
    expect(JSON.parse(String(writes[0][1].body)).requestKey).toEqual(expect.any(String))
    expect(button(page.container, '复盘审核')).toBeDefined()
    act(() => page.root.unmount())
  })

  it('反审核服务端成功但响应丢失时重载核对成功且不生成第二个请求键', async () => {
    let current = makeCount('CONFIRMED')
    current.documentType = 'FORMAL'; current.postingPolicy = 'REVIEW'; current.reviewStatus = 'UNREVIEWED'
    const writes: any[] = []
    mockFetch.mockImplementation(async (path, init) => {
      const url = String(path)
      if (url === '/api/warehouse-stocktakes/options') return options as any
      if (url.includes('?page=')) return { rows: [{ id: current.id, no: current.no, status: current.status, warehouse: current.warehouse }] } as any
      if (url === `/api/warehouse-stocktakes/${current.id}`) return structuredClone(current)
      if (url.endsWith('/reverse-approval') && init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)))
        if (writes.length === 1) {
          current = { ...current, status: 'COUNTING', reviewNote: '响应丢失复核', rowVersion: 4 }
          throw new Error('网络响应丢失')
        }
        return { replayed: true } as any
      }
      throw new Error(`unexpected API: ${url}`)
    })
    const page = renderPage('count')
    await waitFor(() => Boolean(button(page.container, '反审核')))
    act(() => button(page.container, '反审核')!.click())
    const reason = page.container.querySelector('textarea[placeholder="请填写反审核原因"]') as HTMLTextAreaElement
    act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(reason, '响应丢失复核'); reason.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => button(page.container, '确认')!.click())
    await waitFor(() => page.container.textContent?.includes('已使用原请求编号核对结果') ?? false)
    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatchObject({ reason: '响应丢失复核', rowVersion: 3, requestKey: expect.any(String) })
    expect(writes[1]).toEqual(writes[0])
    expect(button(page.container, '反审核')).toBeUndefined()
    act(() => page.root.unmount())
  })

  it('他人使用相同原因改变状态时不误认本次反审核成功', async () => {
    let current = makeCount('CONFIRMED')
    current.documentType = 'FORMAL'; current.postingPolicy = 'REVIEW'; current.reviewStatus = 'UNREVIEWED'
    const writes: any[] = []
    mockFetch.mockImplementation(async (path, init) => {
      const url = String(path)
      if (url === '/api/warehouse-stocktakes/options') return options as any
      if (url.includes('?page=')) return { rows: [{ id: current.id, no: current.no, status: current.status, warehouse: current.warehouse }] } as any
      if (url === `/api/warehouse-stocktakes/${current.id}`) return structuredClone(current)
      if (url.endsWith('/reverse-approval') && init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)))
        if (writes.length === 1) { current = { ...current, status: 'COUNTING', reviewNote: '相同原因', rowVersion: 4 }; throw new Error('网络中断') }
        throw Object.assign(new Error('盘点单已被其他请求更新'), { status: 409 })
      }
      throw new Error(`unexpected API: ${url}`)
    })
    const page = renderPage('count')
    await waitFor(() => Boolean(button(page.container, '反审核')))
    act(() => button(page.container, '反审核')!.click())
    const reason = page.container.querySelector('textarea[placeholder="请填写反审核原因"]') as HTMLTextAreaElement
    act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(reason, '相同原因'); reason.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => button(page.container, '确认')!.click())
    await waitFor(() => page.container.textContent?.includes('未把本请求标记为成功') ?? false)
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0])
    expect(page.container.textContent).not.toContain('反审核已成功')
    act(() => page.root.unmount())
  })

  it.skip('旧分区名编辑保护由独立子单固定负责人模型替代', async () => {
    const page = renderPage()
    await waitFor(() => !button(page.container, '新建多人盘点单')!.disabled)
    act(() => button(page.container, '新建多人盘点单')!.click())
    const name = Array.from(page.container.querySelectorAll<HTMLInputElement>('input')).find(input => input.value === '分区 1')!
    change(name, '未保存分区')
    const proceed = vi.fn()
    act(() => { expect(window.dispatchEvent(new CustomEvent('dianjie:supply-chain-before-navigate', { cancelable: true, detail: { proceed } }))).toBe(false) })
    expect(page.container.textContent).toContain('放弃未保存的盘点填写？')
    await act(async () => button(page.container, '取消')!.click())
    expect(name.value).toBe('未保存分区')
    expect(proceed).not.toHaveBeenCalled()
    act(() => { window.dispatchEvent(new CustomEvent('dianjie:supply-chain-before-navigate', { cancelable: true, detail: { proceed } })) })
    await act(async () => button(page.container, '放弃并继续')!.click())
    expect(proceed).toHaveBeenCalledTimes(1)
    act(() => page.root.unmount())
  })

  it('保存一分区不清空另一分区未保存的录入，切单取消也保留', async () => {
    const count = makeCount()
    count.sections[1].assignedToId = 'user-1'
    setupFetch(count)
    const page = renderPage()
    await waitFor(() => !!page.container.querySelector('[aria-label="大米实盘数量"]'))
    const own = page.container.querySelector<HTMLInputElement>('[aria-label="土豆实盘数量"]')!
    const other = page.container.querySelector<HTMLInputElement>('[aria-label="大米实盘数量"]')!
    change(own, '12'); change(other, '18')
    await act(async () => button(page.container, '保存我的分区')!.click())
    await waitFor(() => page.container.textContent?.includes('冷库已保存') ?? false)
    expect(other.value).toBe('18')
    const select = Array.from(page.container.querySelectorAll<HTMLSelectElement>('select')).find(select => select.parentElement?.textContent?.startsWith('选择盘点单'))!
    act(() => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(page.container.textContent).toContain('放弃未保存的盘点填写？')
    await act(async () => button(page.container, '取消')!.click())
    expect(other.value).toBe('18')
    act(() => page.root.unmount())
  })

  it('本分区保存后未编辑的他人分区采用服务器新值，不制造未保存修改', async () => {
    const count = makeCount()
    const saved = structuredClone(count)
    saved.sections[0].items[0].countedQuantity = '12'
    saved.sections[1].items[0].countedQuantity = '18'
    saved.sections[1].status = 'SUBMITTED'
    setupFetch(count)
    const original = mockFetch.getMockImplementation()!
    let written = false
    mockFetch.mockImplementation((path, init) => {
      if (init?.method === 'PUT') { written = true; return Promise.resolve({ ok: true }) }
      if (written && path === '/api/warehouse-stocktakes/count-1') return Promise.resolve(saved)
      return original(path, init)
    })
    const page = renderPage()
    await waitFor(() => Boolean(page.container.querySelector('[aria-label="土豆实盘数量"]')))
    change(page.container.querySelector('[aria-label="土豆实盘数量"]') as HTMLInputElement, '12')
    await act(async () => button(page.container, '保存我的分区')!.click())
    expect((page.container.querySelector('[aria-label="大米实盘数量"]') as HTMLInputElement).value).toBe('18')
    await act(async () => button(page.container, '汇总提交审核')!.click())
    expect(page.container.textContent).not.toContain('请先保存各分区未保存')
    expect(page.container.textContent).toContain('请确认已核对单据和各分区进度')
    act(() => page.root.unmount())
  })

  it('分区写入成功后详情读取失败明确提示已保存，保留当前输入', async () => {
    setupFetch()
    const original = mockFetch.getMockImplementation()!
    let written = false
    mockFetch.mockImplementation((path, init) => {
      if (init?.method === 'PUT') { written = true; return Promise.resolve({ ok: true }) }
      if (written && path === '/api/warehouse-stocktakes/count-1') return Promise.reject(new Error('读取断开'))
      return original(path, init)
    })
    const page = renderPage()
    await waitFor(() => Boolean(page.container.querySelector('[aria-label="土豆实盘数量"]')))
    const input = page.container.querySelector('[aria-label="土豆实盘数量"]') as HTMLInputElement
    change(input, '12')
    await act(async () => button(page.container, '保存我的分区')!.click())
    expect(page.container.textContent).toContain('冷库已保存，但最新状态读取失败')
    expect(input.value).toBe('12')
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
    act(() => page.root.unmount())
  })

  it('旧单详情晚返回不能覆盖后选单据', async () => {
    const first = makeCount(); const second = { ...makeCount(), id: 'count-2', no: '最新选择单' }
    let resolveFirst!: (value: any) => void
    mockFetch.mockImplementation(async path => {
      if (path === '/api/warehouse-stocktakes/options') return options as any
      if (String(path).includes('?page=')) return { rows: [first, second].map(count => ({ id: count.id, no: count.no, status: count.status, warehouse: count.warehouse })), total: 2 } as any
      if (String(path).endsWith('/count-1')) return new Promise(resolve => { resolveFirst = resolve })
      if (String(path).endsWith('/count-2')) return second
      throw new Error('unexpected')
    })
    const page = renderPage()
    await waitFor(() => !!resolveFirst)
    await waitFor(() => Array.from((page.container.querySelector('[aria-label="选择盘点单"]') as HTMLSelectElement).options).some(option => option.value === 'count-2'))
    const select = page.container.querySelector('[aria-label="选择盘点单"]') as HTMLSelectElement
    act(() => { select.value = 'count-2'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await waitFor(() => page.container.querySelector('h2')?.textContent?.includes('最新选择单') ?? false)
    await act(async () => resolveFirst(first))
    expect(page.container.querySelector('h2')?.textContent).toContain('最新选择单')
    act(() => page.root.unmount())
  })

  it('提交人撤回并发失败后保留原请求编号重试', async () => {
    const count = makeCount('REVIEWING')
    count.submittedBy = { id: 'user-1', name: '盘点员甲' }
    setupFetch(count)
    const original = mockFetch.getMockImplementation()!
    const writes: any[] = []
    mockFetch.mockImplementation((path, init) => {
      if (String(path).endsWith('/withdraw') && init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)))
        if (writes.length === 1) return Promise.reject(Object.assign(new Error('版本冲突'), { status: 409 }))
        return Promise.resolve({ replayed: false })
      }
      return original(path, init)
    })
    const page = renderPage()
    await waitFor(() => Boolean(button(page.container, '撤回录入')))
    act(() => button(page.container, '撤回录入')!.click())
    await act(async () => button(page.container, '确认')!.click())
    expect(page.container.textContent).toContain('版本冲突')
    await act(async () => button(page.container, '确认')!.click())
    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatchObject({ rowVersion: 3, requestKey: expect.any(String) })
    expect(writes[1]).toEqual(writes[0])
    act(() => page.root.unmount())
  })

  it('审核人驳回409后保留原因并使用原请求编号重试', async () => {
    const count = makeCount('REVIEWING')
    count.submittedBy = { id: 'user-2', name: '盘点员乙' }
    setupFetch(count)
    const original = mockFetch.getMockImplementation()!
    const writes: any[] = []
    mockFetch.mockImplementation((path, init) => {
      if (String(path).endsWith('/reject') && init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)))
        if (writes.length === 1) return Promise.reject(Object.assign(new Error('旧版本'), { status: 409 }))
        return Promise.resolve({ replayed: false })
      }
      return original(path, init)
    })
    const page = renderPage()
    await waitFor(() => Boolean(button(page.container, '驳回录入')))
    act(() => button(page.container, '驳回录入')!.click())
    const reason = page.container.querySelector('textarea[placeholder="请填写退回原因"]') as HTMLTextAreaElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(reason, '数量需要复核')
      reason.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button(page.container, '确认')!.click())
    expect(reason.value).toBe('数量需要复核')
    await act(async () => button(page.container, '确认')!.click())
    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatchObject({ reason: '数量需要复核', rowVersion: 3, requestKey: expect.any(String) })
    expect(writes[1]).toEqual(writes[0])
    act(() => page.root.unmount())
  })

  it('表头编辑409保留输入并使用原请求编号重试', async () => {
    const count = makeCount()
    setupFetch(count)
    const original = mockFetch.getMockImplementation()!
    const writes: any[] = []
    mockFetch.mockImplementation((path, init) => {
      if (String(path).endsWith('/header') && init?.method === 'PATCH') {
        writes.push(JSON.parse(String(init.body)))
        if (writes.length === 1) return Promise.reject(Object.assign(new Error('并发更新'), { status: 409 }))
        return Promise.resolve({ replayed: false })
      }
      return original(path, init)
    })
    const page = renderPage()
    await waitFor(() => Boolean(button(page.container, '编辑表头')))
    act(() => button(page.container, '编辑表头')!.click())
    const date = page.container.querySelector('[aria-label="编辑盘点日期"]') as HTMLInputElement
    const note = page.container.querySelector('[aria-label="编辑盘点备注"]') as HTMLInputElement
    change(note, '复核后修改备注')
    await act(async () => button(page.container, '保存表头')!.click())
    expect(date.value).toBe('2026-09-29'); expect(note.value).toBe('复核后修改备注')
    await act(async () => button(page.container, '保存表头')!.click())
    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatchObject({ countDate: '2026-09-29', note: '复核后修改备注', rowVersion: 3, requestKey: expect.any(String) })
    expect(writes[1]).toEqual(writes[0])
    act(() => page.root.unmount())
  })

  it('指定盘点可增删商品且ALL盘点隐藏增删入口', async () => {
    const count = makeCount()
    count.sections[0].items.push({ ...count.sections[0].items[0], id: 'item-own-extra', productId: 'product-extra', productCodeSnapshot: 'P-EXTRA', productNameSnapshot: '萝卜' })
    const extraOptions = { ...options, products: [...options.products, { id: 'product-3', code: 'P-03', name: '白菜', inventoryUnit: 'kg', unit: 'kg' }] }
    setupFetch(count)
    const original = mockFetch.getMockImplementation()!
    const addWrites: any[] = []; const removeWrites: any[] = []
    mockFetch.mockImplementation((path, init) => {
      if (path === '/api/warehouse-stocktakes/options') return Promise.resolve(extraOptions)
      if (String(path).endsWith('/items') && init?.method === 'POST') { addWrites.push(JSON.parse(String(init.body))); return Promise.resolve({ replayed: false }) }
      if (String(path).endsWith('/items/remove') && init?.method === 'POST') { removeWrites.push(JSON.parse(String(init.body))); return Promise.resolve({ replayed: false }) }
      return original(path, init)
    })
    const page = renderPage()
    await waitFor(() => Boolean(button(page.container, '添加商品')))
    act(() => button(page.container, '添加商品')!.click())
    act(() => (page.container.querySelector('[aria-label="添加商品 白菜"]') as HTMLInputElement).click())
    await act(async () => button(page.container, '添加所选商品')!.click())
    expect(addWrites[0]).toMatchObject({ sectionId: 'section-own', productIds: ['product-3'], rowVersion: 3, requestKey: expect.any(String) })
    act(() => (Array.from(page.container.querySelectorAll('button')).find(node => node.textContent === '移除') as HTMLButtonElement).click())
    const removeButtons = Array.from(page.container.querySelectorAll('button')).filter(node => node.textContent === '移除')
    await act(async () => removeButtons.at(-1)!.click())
    expect(removeWrites[0]).toMatchObject({ itemIds: ['item-own'], rowVersion: 3, requestKey: expect.any(String) })
    act(() => page.root.unmount())

    const all = makeCount(); all.countScope = 'ALL'; setupFetch(all)
    const allPage = renderPage()
    await waitFor(() => allPage.container.textContent?.includes(all.no) ?? false)
    expect(button(allPage.container, '添加商品')).toBeUndefined()
    expect(Array.from(allPage.container.querySelectorAll('button')).some(node => node.textContent === '移除')).toBe(false)
    act(() => allPage.root.unmount())

    const planned = makeCount(); planned.planId = 'plan-1'; planned.planNameSnapshot = '重点方案'; planned.selectionRuleSnapshot = 'FIXED_PLAN_PRODUCTS'; setupFetch(planned)
    const plannedPage = renderPage(); await waitFor(() => plannedPage.container.textContent?.includes('重点方案') ?? false)
    expect(button(plannedPage.container, '添加商品')).toBeUndefined()
    expect(Array.from(plannedPage.container.querySelectorAll('button')).some(node => node.textContent === '移除')).toBe(false)
    act(() => plannedPage.root.unmount())

    const daily = makeCount(); daily.countScope = 'DAILY'; daily.selectionRuleSnapshot = 'PERIOD_MOVEMENT_OR_OPENING'; setupFetch(daily)
    const dailyPage = renderPage(); await waitFor(() => dailyPage.container.textContent?.includes('PERIOD_MOVEMENT_OR_OPENING') ?? false)
    expect(button(dailyPage.container, '添加商品')).toBeUndefined()
    expect(Array.from(dailyPage.container.querySelectorAll('button')).some(node => node.textContent === '移除')).toBe(false)
    act(() => dailyPage.root.unmount())
  })

  it('商品上移按完整分区顺序持久化，未保存实盘会先阻止排序', async () => {
    const count = makeCount()
    count.sections[0].items.push({ ...count.sections[0].items[0], id: 'item-own-extra', productId: 'product-extra', productNameSnapshot: '萝卜' })
    setupFetch(count)
    const original = mockFetch.getMockImplementation()!
    const reorderWrites: any[] = []
    mockFetch.mockImplementation((path, init) => {
      if (String(path).endsWith('/items/reorder') && init?.method === 'POST') {
        reorderWrites.push(JSON.parse(String(init.body)))
        return Promise.resolve({ replayed: false })
      }
      return original(path, init)
    })
    const page = renderPage()
    await waitFor(() => Boolean(page.container.querySelector('[aria-label="萝卜上移"]')))
    const potato = page.container.querySelector('[aria-label="土豆实盘数量"]') as HTMLInputElement
    change(potato, '10')
    await act(async () => (page.container.querySelector('[aria-label="萝卜上移"]') as HTMLButtonElement).click())
    expect(reorderWrites).toHaveLength(0)
    expect(page.container.textContent).toContain('请先保存盘点明细，再调整商品顺序')
    change(potato, '')
    await act(async () => (page.container.querySelector('[aria-label="萝卜上移"]') as HTMLButtonElement).click())
    expect(reorderWrites[0]).toMatchObject({
      sectionId: 'section-own', itemIds: ['item-own-extra', 'item-own'], rowVersion: 3, requestKey: expect.any(String),
    })
    act(() => page.root.unmount())
  })

  it('单据日志按需加载，切换单据后忽略上一张单的慢响应', async () => {
    const first = makeCount()
    const second = { ...makeCount(), id: 'count-2', no: 'WSC-20260929-002' }
    let resolveFirstLogs: ((value: any) => void) | null = null
    const firstLogs = new Promise(resolve => { resolveFirstLogs = resolve })
    mockFetch.mockImplementation((path) => {
      const url = String(path)
      if (url === '/api/warehouse-stocktakes/options') return Promise.resolve(options)
      if (url.includes('page=1&pageSize=50')) return Promise.resolve({ rows: [
        { id: first.id, no: first.no, status: first.status, warehouse: first.warehouse },
        { id: second.id, no: second.no, status: second.status, warehouse: second.warehouse },
      ], total: 2 })
      if (url === `/api/warehouse-stocktakes/${first.id}`) return Promise.resolve(first)
      if (url === `/api/warehouse-stocktakes/${second.id}`) return Promise.resolve(second)
      if (url === `/api/warehouse-stocktakes/${first.id}/logs`) return firstLogs
      if (url === `/api/warehouse-stocktakes/${second.id}/logs`) return Promise.resolve({ items: [], hasMore: false, nextCursor: null })
      return Promise.reject(new Error(`unexpected API: ${url}`))
    })
    const page = renderPage()
    await waitFor(() => page.container.textContent?.includes(first.no) ?? false)
    expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith('/logs'))).toBe(false)
    act(() => button(page.container, '加载操作日志')!.click())
    await waitFor(() => mockFetch.mock.calls.some(([url]) => String(url) === `/api/warehouse-stocktakes/${first.id}/logs`))

    const select = page.container.querySelector('[aria-label="选择盘点单"]') as HTMLSelectElement
    await waitFor(() => Array.from(select.options).some(option => option.value === second.id))
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, second.id)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await waitFor(() => page.container.querySelector('h2')?.textContent?.includes(second.no) ?? false)
    await act(async () => resolveFirstLogs?.({
      items: [{ id: 'log-a', action: 'A单旧日志', actor: '盘点员甲', actorId: 'user-1', createdAt: new Date().toISOString(), metadata: null }],
      hasMore: false,
      nextCursor: null,
    }))
    expect(page.container.textContent).not.toContain('A单旧日志')
    expect(button(page.container, '加载操作日志')).toBeDefined()
    act(() => page.root.unmount())
  })

})

it('财务可查看待审核盘点，但没有审核或退回入口',async()=>{
 roleFixture.role='FINANCE';setupFetch(makeCount('REVIEWING'))
 const {container,root}=renderPage('count');await waitFor(()=>container.textContent?.includes('WSC-20260929-001')??false)
 expect(button(container,'审核并生成盘盈盘亏')).toBeUndefined()
 expect(button(container,'退回录入')).toBeUndefined()
 expect(container.querySelector('a[href="/v2/supply-chain/stocktake/count"]')).not.toBeNull()
 act(()=>root.unmount())
})

it('opens explicit create from the multi list with the selected warehouse and returns to that list',async()=>{
 window.history.replaceState({},'', '/v2/supply-chain/stocktake/work?create=1&from=multi-count&warehouseId=warehouse-1')
 roleFixture.role='SUPPLY_CHAIN';setupFetch()
 const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container)
 await act(async()=>root.render(<WarehouseStocktakeWorkPage />))
 expect(container.textContent).toContain('保存子单草稿')
 expect(container.querySelector('a[href="/v2/supply-chain/stocktake/multi-count"]')?.textContent).toBe('返回多人盘点查询')
 const warehouse=container.querySelector('select') as HTMLSelectElement
 expect(warehouse.value).toBe('warehouse-1');act(()=>root.unmount())
 window.history.replaceState({},'', '/v2/supply-chain/stocktake/work')
})

it('does not silently choose a different warehouse when a create link names an unavailable warehouse',async()=>{
 roleFixture.role='SUPPLY_CHAIN';sessionStorage.clear();setupFetch()
 window.history.replaceState({},'', '/v2/supply-chain/stocktake/work?create=1&from=count&warehouseId=not-available')
 const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container)
 await act(async()=>root.render(<WarehouseStocktakeWorkPage />))
 expect(container.textContent).toContain('所选仓库已停用或不可用')
 expect((container.querySelector('select') as HTMLSelectElement).value).toBe('')
 act(()=>root.unmount());window.history.replaceState({},'', '/v2/supply-chain/stocktake/work')
})

it('restores an uncertain create before any unrelated doc or create link',async()=>{
 roleFixture.role='SUPPLY_CHAIN';setupFetch();mockFetch.mockClear();localStorage.setItem('tenant',JSON.stringify({id:'tenant-1'}));sessionStorage.clear()
 sessionStorage.setItem('dj:stocktake-create:tenant-1:user-1',JSON.stringify({body:{requestKey:'pending-original',warehouseId:'warehouse-1',countDate:'2026-10-12',documentType:'MULTI',countScope:'SELECTED',selectionRule:'MANUAL_SELECTED',selectionFingerprint:'a'.repeat(64),sections:[{name:'原创建分区',assignedToId:'user-1',productIds:['product-1']}]},countScope:'SELECTED'}))
 window.history.replaceState({},'', '/v2/supply-chain/stocktake/work?create=1&from=multi-count&doc=count-1&warehouseId=other')
 const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container)
 await act(async()=>root.render(<WarehouseStocktakeWorkPage />))
 expect(container.textContent).toContain('重试原创建请求')
 expect(container.textContent).toContain('由当前创建人录入的独立子单')
 expect(mockFetch.mock.calls.some(([url])=>String(url)==='/api/warehouse-stocktakes/count-1')).toBe(false)
 expect((container.querySelector('select') as HTMLSelectElement).value).toBe('warehouse-1')
 act(()=>root.unmount());sessionStorage.clear();mockFetch.mockClear();window.history.replaceState({},'', '/v2/supply-chain/stocktake/work')
})

it('恢复键优先按页面隔离，损坏旧键不压死有效记录，旧记录缺类型也可恢复并在成功后删除',async()=>{
 roleFixture.role='SUPPLY_CHAIN';localStorage.setItem('tenant',JSON.stringify({id:'tenant-1'}));sessionStorage.clear()
 const pending={body:{requestKey:'mode-specific',warehouseId:'warehouse-1',countDate:'2026-10-12',documentType:'MULTI',countScope:'SELECTED',selectionRule:'MANUAL_SELECTED',selectionFingerprint:'a'.repeat(64),sections:[{name:'多人盘点子单',assignedToId:'user-1',productIds:['product-1']}]},countScope:'SELECTED'}
 const isolated='dj:stocktake-create:tenant-1:user-1:multi-count',legacy='dj:stocktake-create:tenant-1:user-1'
 sessionStorage.setItem(isolated,JSON.stringify(pending));sessionStorage.setItem(legacy,'{broken')
 window.history.replaceState({},'', '/v2/supply-chain/stocktake/work?from=multi-count')
 let container=document.createElement('div');document.body.appendChild(container);let root=createRoot(container)
 await act(async()=>root.render(<WarehouseStocktakeWorkPage />));await waitFor(()=>container.textContent?.includes('已恢复上次结果未确认')??false)
 expect(container.textContent).not.toContain('恢复记录读取失败');expect((container.querySelector('select') as HTMLSelectElement).value).toBe('warehouse-1')
 act(()=>root.unmount());container.remove();sessionStorage.clear()

 const legacyPending={...pending,body:{...pending.body,requestKey:'legacy-no-type'}} as any
 delete legacyPending.body.documentType
 sessionStorage.setItem(legacy,JSON.stringify(legacyPending))
 mockFetch.mockImplementation(async(path,init)=>{
  const url=String(path);if(url==='/api/warehouse-stocktakes/options')return options as any
  if(url.includes('?page='))return {rows:[]} as any
  if(init?.method==='POST')return {stocktake:makeCount('DRAFT')} as any
  if(url.endsWith('/count-1'))return makeCount('DRAFT')
  throw new Error(`unexpected API: ${url}`)
 })
 container=document.createElement('div');document.body.appendChild(container);root=createRoot(container)
 await act(async()=>root.render(<WarehouseStocktakeWorkPage />));await waitFor(()=>!!button(container,'重试原创建请求'))
 await act(async()=>button(container,'重试原创建请求')!.click());await waitFor(()=>container.textContent?.includes('多人盘点子单已创建')??false)
 const post=mockFetch.mock.calls.find(([,init])=>init?.method==='POST')!
 expect(JSON.parse(String(post[1]?.body))).toMatchObject({requestKey:'legacy-no-type',documentType:'MULTI'})
 expect(sessionStorage.getItem(legacy)).toBeNull();expect(sessionStorage.getItem(isolated)).toBeNull()
 act(()=>root.unmount());sessionStorage.clear();mockFetch.mockClear();window.history.replaceState({},'', '/v2/supply-chain/stocktake/work')
})

it('分区以商品表格显示，返回取消保留输入，确认后才返回列表',async()=>{
 roleFixture.role='SUPPLY_CHAIN';navigation.push.mockClear();setupFetch()
 const page=renderPage('count');await waitFor(()=>!!page.container.querySelector('[aria-label="土豆实盘数量"]'))
 try{
  expect(page.container.querySelectorAll('table')).toHaveLength(2)
  expect(page.container.querySelector('table')!.textContent).toContain('规格型号')
  const input=page.container.querySelector<HTMLInputElement>('[aria-label="土豆实盘数量"]')!
  change(input,'12')
  const back=page.container.querySelector<HTMLAnchorElement>('header a')!
  act(()=>back.click())
  expect(page.container.textContent).toContain('放弃未保存的盘点填写')
  act(()=>button(page.container,'取消')!.click())
  expect(input.value).toBe('12');expect(navigation.push).not.toHaveBeenCalled()
  act(()=>back.click());await act(async()=>button(page.container,'放弃并继续')!.click())
  expect(navigation.push).toHaveBeenCalledWith('/v2/supply-chain/stocktake/count')
  expect(mockFetch.mock.calls.every(([,init])=>!init?.method)).toBe(true)
 }finally{act(()=>page.root.unmount())}
})

it('补换算跳转保护未保存输入，新建沿用当前单据仓库',async()=>{
 roleFixture.role='SUPPLY_CHAIN';navigation.push.mockClear()
 const count=makeCount();count.warehouse={id:'warehouse-2',code:'WH-02',name:'第二仓'}
 count.sections[1].items[0].unitPending=true
 setupFetch(count);const original=mockFetch.getMockImplementation()!
 mockFetch.mockImplementation((path,init)=>String(path)==='/api/warehouse-stocktakes/options'?Promise.resolve({...options,warehouses:[...options.warehouses,count.warehouse]}):original(path,init))
 const page=renderPage('count');await waitFor(()=>!!page.container.querySelector('[aria-label="土豆实盘数量"]'))
 try{
  const input=page.container.querySelector<HTMLInputElement>('[aria-label="土豆实盘数量"]')!;change(input,'12')
  const link=page.container.querySelector<HTMLAnchorElement>('a[href="/v2/supply-chain/products"]')!
  act(()=>link.click());act(()=>button(page.container,'取消')!.click())
  expect(input.value).toBe('12');expect(navigation.push).not.toHaveBeenCalled()
  act(()=>button(page.container,'新建盘点单')!.click());act(()=>button(page.container,'取消')!.click())
  expect(input.value).toBe('12')
  act(()=>button(page.container,'新建盘点单')!.click());await act(async()=>button(page.container,'放弃并继续')!.click())
  const warehouse=Array.from(page.container.querySelectorAll('select')).find(select=>Array.from(select.options).some(option=>option.value==='warehouse-2'))!
  expect(warehouse.value).toBe('warehouse-2')
  expect(mockFetch.mock.calls.every(([,init])=>!init?.method)).toBe(true)
 }finally{act(()=>page.root.unmount())}
})
