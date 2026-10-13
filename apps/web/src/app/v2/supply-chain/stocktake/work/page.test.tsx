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
}

const makeCount = (status = 'COUNTING'): any => ({
  id: 'count-1', no: 'WSC-20260929-001', status, rowVersion: 3,
  warehouse: options.warehouses[0], countedCount: 0, itemCount: 2, totalDifferenceValue: '0', adjustments: [],
  sections: [
    {
      id: 'section-own', name: '冷库', assignedToId: 'user-1', status: 'OPEN', rowVersion: 4, submittedAt: null,
      items: [{
        id: 'item-own', productNameSnapshot: '土豆', productCodeSnapshot: 'P-01', productSpecSnapshot: '10kg/箱', inventoryUnit: 'kg',
        bookQuantity: '10', averageUnitCost: '2', countedQuantity: null, countedUnitCost: null,
        differenceQuantity: null, differenceValue: null, reason: null,
      }],
    },
    {
      id: 'section-other', name: '干货区', assignedToId: 'user-2', status: 'OPEN', rowVersion: 2, submittedAt: null,
      items: [{
        id: 'item-other', productNameSnapshot: '大米', productCodeSnapshot: 'P-02', productSpecSnapshot: null, inventoryUnit: 'kg',
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
    if (url === '/api/warehouse-stocktakes?page=1&pageSize=200') {
      return Promise.resolve({ rows: [{ id: count.id, no: count.no, status: count.status, warehouse: count.warehouse }] })
    }
    if (url === `/api/warehouse-stocktakes/${count.id}`) return Promise.resolve(count)
    if (url === `/api/warehouse-stocktakes/${count.id}/sections/section-own` && init?.method === 'PUT') return Promise.resolve({ ok: true })
    return Promise.reject(new Error(`unexpected API: ${url}`))
  })
}

function renderPage() {
  window.history.replaceState({}, '', '/v2/supply-chain/stocktake/work?doc=count-1')
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

describe('总仓多人分区盘点', () => {
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
    await waitFor(() => container.textContent?.includes('冷库') ?? false)

    expect(container.querySelector('a[href="/v2/supply-chain/stocktake/count/count-1?source=warehouse"]')?.textContent).toContain('查看差异')
    expect(container.textContent).toContain('冷库 · 盘点员甲 · 已提交')
    expect((container.querySelector('[aria-label="土豆实盘数量"]') as HTMLInputElement).disabled).toBe(true)
    expect(button(container, '保存我的分区')).toBeUndefined()
    expect(button(container, '提交我的分区')).toBeUndefined()

    act(() => root.unmount())
  })

  it('新建盘点明确提供全部盘点与指定盘点，并支持按分类全选', async () => {
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('WSC-20260929-001') ?? false)

    act(() => { button(container, '新建总仓盘点')?.click() })
    expect(container.querySelector('input[type="radio"][checked]')?.parentElement?.textContent).toContain('全部盘点')
    expect(container.textContent).toContain('盘点该仓库当前全部 1 个商品')

    const specified = Array.from(container.querySelectorAll('input[type="radio"]'))[1] as HTMLInputElement
    act(() => { specified.click() })
    expect(container.textContent).toContain('全选分类：未分类（1）')

    act(() => root.unmount())
  })
  it('全部盘点保留多负责人及待核验商品，漏分配时不发送创建请求', async () => {
    const products = [
      { ...options.products[0], unitConversionStatus: 'VERIFIED' },
      { id: 'product-2', code: 'P-02', name: '待核验大米', unit: 'kg', inventoryUnit: 'kg', unitConversionStatus: 'PENDING' },
    ]
    const count = makeCount('DRAFT')
    mockFetch.mockImplementation(async (path, init) => {
      if (path === '/api/warehouse-stocktakes/options') return { ...options, products } as any
      if (init?.method === 'POST') return { stocktake: count } as any
      if (String(path).endsWith('/count-1')) return count
      return { rows: [] } as any
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('冷库') ?? false)
    act(() => button(container, '新建总仓盘点')!.click())
    expect(container.textContent).toContain('换算待核验，可保存草稿')
    act(() => button(container, '添加分区 / 负责人')!.click())
    await act(async () => button(container, '保存盘点草稿')!.click())
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
    expect(body.countScope).toBe('ALL')
    expect(body.sections.map((section: any) => section.assignedToId)).toEqual(['user-1', 'user-2'])
    expect(body.sections.map((section: any) => section.productIds)).toEqual([['product-1'], ['product-2']])
    act(() => root.unmount())
  })
  it('搜索土豆后全选分类仍选择整类三个商品，重复取消不会漏留隐藏商品', async () => {
    const products = ['土豆', '白菜', '萝卜'].map((name, index) => ({ id: `p${index}`, code: `P${index}`, name, category: '蔬菜类', inventoryUnit: 'kg', unit: 'kg' }))
    const count = makeCount()
    mockFetch.mockImplementation(async (path, init) => {
      if (path === '/api/warehouse-stocktakes/options') return { ...options, products } as any
      if (init?.method === 'POST') return { stocktake: count } as any
      if (String(path).endsWith('/count-1')) return count
      return { rows: [] } as any
    })
    const { container, root } = renderPage()
    await waitFor(() => container.textContent?.includes('冷库') ?? false)
    act(() => button(container, '新建总仓盘点')!.click())
    act(() => (container.querySelectorAll('input[type="radio"]')[1] as HTMLInputElement).click())
    const search = container.querySelector('input[placeholder="商品名称 / 编码"]') as HTMLInputElement
    change(search, '土豆')
    const category = Array.from(container.querySelectorAll('label')).find(label => label.textContent?.includes('全选分类：蔬菜类（3）'))!.querySelector('input')!
    act(() => category.click())
    expect(container.textContent).toContain('已分配 3 项')
    act(() => category.click())
    expect(container.textContent).toContain('已分配 0 项')
    act(() => category.click())
    await act(async () => button(container, '保存盘点草稿')!.click())
    const call = mockFetch.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(JSON.parse(String(call[1]?.body)).sections[0].productIds).toEqual(['p0', 'p1', 'p2'])
    act(() => root.unmount())
  })

  it('创建响应丢失后冻结原请求，双击和刷新重试不更换请求内容', async () => {
    const count = makeCount('DRAFT')
    let posts = 0
    mockFetch.mockImplementation(async (path, init) => {
      if (path === '/api/warehouse-stocktakes/options') return options as any
      if (init?.method === 'POST') {
        posts += 1
        if (posts === 1) throw new Error('网络响应丢失')
        return { stocktake: count } as any
      }
      if (String(path).endsWith('/count-1')) return count
      return { rows: [] } as any
    })
    let page = renderPage()
    await waitFor(() => page.container.textContent?.includes('冷库') ?? false)
    act(() => button(page.container, '新建总仓盘点')!.click())
    await act(async () => { const save = button(page.container, '保存盘点草稿')!; save.click(); save.click() })
    expect(posts).toBe(1)
    const firstBody = mockFetch.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body
    expect(page.container.textContent).toContain('创建结果未确认')
    expect((page.container.querySelector('input[type="date"]') as HTMLInputElement).closest('fieldset')!.disabled).toBe(true)
    expect(sessionStorage.getItem('dj:stocktake-create:tenant-1:user-1')).not.toBeNull()
    act(() => page.root.unmount())
    page.container.remove()
    page = renderPage()
    await waitFor(() => page.container.textContent?.includes('已恢复上次结果未确认') ?? false)
    await act(async () => button(page.container, '重试原创建请求')!.click())
    expect(posts).toBe(2)
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => init!.body)).toEqual([firstBody, firstBody])
    expect(sessionStorage.getItem('dj:stocktake-create:tenant-1:user-1')).toBeNull()
    expect(page.container.textContent).toContain('盘点已创建')
    act(() => page.root.unmount())
  })

  it('首次明确拒绝允许修正，但损坏恢复记录不覆盖或发送新请求', async () => {
    const existing = mockFetch.getMockImplementation()!
    mockFetch.mockImplementation((path, init) => init?.method === 'POST'
      ? Promise.reject(Object.assign(new Error('负责人不合法'), { status: 400 }))
      : existing(path, init))
    let page = renderPage()
    await waitFor(() => page.container.textContent?.includes('冷库') ?? false)
    act(() => button(page.container, '新建总仓盘点')!.click())
    await act(async () => button(page.container, '保存盘点草稿')!.click())
    expect(page.container.textContent).toContain('负责人不合法')
    expect(sessionStorage.getItem('dj:stocktake-create:tenant-1:user-1')).toBeNull()
    expect((page.container.querySelector('input[type="date"]') as HTMLInputElement).closest('fieldset')!.disabled).toBe(false)
    act(() => page.root.unmount()); page.container.remove()
    sessionStorage.setItem('dj:stocktake-create:tenant-1:user-1', '{broken')
    const before = mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST').length
    page = renderPage()
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

  it('离开未保存的新建表单先确认，取消保留填写，确认才继续', async () => {
    const page = renderPage()
    await waitFor(() => !button(page.container, '新建总仓盘点')!.disabled)
    act(() => button(page.container, '新建总仓盘点')!.click())
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
      if (String(path).includes('?page=')) return { rows: [first, second].map(count => ({ id: count.id, no: count.no, status: count.status, warehouse: count.warehouse })) } as any
      if (String(path).endsWith('/count-1')) return new Promise(resolve => { resolveFirst = resolve })
      if (String(path).endsWith('/count-2')) return second
      throw new Error('unexpected')
    })
    const page = renderPage()
    await waitFor(() => !!resolveFirst)
    const select = page.container.querySelector('select')!
    act(() => { select.value = 'count-2'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await waitFor(() => page.container.querySelector('h2')?.textContent?.includes('最新选择单') ?? false)
    await act(async () => resolveFirst(first))
    expect(page.container.querySelector('h2')?.textContent).toContain('最新选择单')
    act(() => page.root.unmount())
  })

})

it('财务可查看待审核盘点，但没有审核或退回入口',async()=>{
 roleFixture.role='FINANCE';setupFetch(makeCount('REVIEWING'))
 const {container,root}=renderPage();await waitFor(()=>container.textContent?.includes('WSC-20260929-001')??false)
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
 expect(container.textContent).toContain('保存盘点草稿')
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
 sessionStorage.setItem('dj:stocktake-create:tenant-1:user-1',JSON.stringify({body:{requestKey:'pending-original',warehouseId:'warehouse-1',countDate:'2026-10-12',countScope:'SELECTED',sections:[{name:'原创建分区',assignedToId:'user-1',productIds:['product-1']}]},countScope:'SELECTED'}))
 window.history.replaceState({},'', '/v2/supply-chain/stocktake/work?create=1&from=multi-count&doc=count-1&warehouseId=other')
 const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container)
 await act(async()=>root.render(<WarehouseStocktakeWorkPage />))
 expect(container.textContent).toContain('重试原创建请求')
 expect((container.querySelector('input[value="原创建分区"]') as HTMLInputElement)?.value).toBe('原创建分区')
 expect(mockFetch.mock.calls.some(([url])=>String(url)==='/api/warehouse-stocktakes/count-1')).toBe(false)
 expect((container.querySelector('select') as HTMLSelectElement).value).toBe('warehouse-1')
 act(()=>root.unmount());sessionStorage.clear();window.history.replaceState({},'', '/v2/supply-chain/stocktake/work')
})

it('分区以商品表格显示，返回取消保留输入，确认后才返回列表',async()=>{
 roleFixture.role='SUPPLY_CHAIN';navigation.push.mockClear();setupFetch()
 const page=renderPage();await waitFor(()=>!!page.container.querySelector('[aria-label="土豆实盘数量"]'))
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
 const page=renderPage();await waitFor(()=>!!page.container.querySelector('[aria-label="土豆实盘数量"]'))
 try{
  const input=page.container.querySelector<HTMLInputElement>('[aria-label="土豆实盘数量"]')!;change(input,'12')
  const link=page.container.querySelector<HTMLAnchorElement>('a[href="/v2/supply-chain/products"]')!
  act(()=>link.click());act(()=>button(page.container,'取消')!.click())
  expect(input.value).toBe('12');expect(navigation.push).not.toHaveBeenCalled()
  act(()=>button(page.container,'新建总仓盘点')!.click());act(()=>button(page.container,'取消')!.click())
  expect(input.value).toBe('12')
  act(()=>button(page.container,'新建总仓盘点')!.click());await act(async()=>button(page.container,'放弃并继续')!.click())
  const warehouse=Array.from(page.container.querySelectorAll('select')).find(select=>Array.from(select.options).some(option=>option.value==='warehouse-2'))!
  expect(warehouse.value).toBe('warehouse-2')
  expect(mockFetch.mock.calls.every(([,init])=>!init?.method)).toBe(true)
 }finally{act(()=>page.root.unmount())}
})
