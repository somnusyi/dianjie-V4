// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagementWorkspace } from './management-workspace'
import { ManagementNav } from './management-nav'
import { managementPages, type ManagementResult } from '@/lib/inventory-management'

const api = vi.hoisted(() => ({ fetch: vi.fn() }))
const navigation = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => navigation }))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: api.fetch }))
vi.mock('next/link', () => ({ default: React.forwardRef<HTMLAnchorElement, any>(({ children, href, ...props }, ref) => <a ref={ref} href={href} {...props}>{children}</a>) }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const expected: Record<string, string> = {
  'purchase-in': '序号|单据编号|入库日期|上游单据号|采购机构|仓库|供应商|金额|状态|复审状态|创建时间|创建人|备注|附件',
  'purchase-return': '序号|单据编号|出库日期|上游单据号|采购机构|供应商|金额|状态|复审状态|对账状态|发票状态|打印状态|创建时间|创建人|备注',
  'other-in': '序号|单据编号|入库日期|机构|仓库|入库原因|金额|状态|复审状态|打印状态|创建时间|创建人|备注',
  'other-out': '序号|单据编号|出库日期|上游单据号|机构|仓库|出库原因|金额|状态|复审状态|打印状态|创建时间|创建人|备注',
  count: '序号|单据编号|盘点日期|机构名称|仓库|物品数|账面金额|实盘金额|盈亏金额|盘点类型|盘点方式|状态|盘点差异|审核日期|打印状态|创建时间|创建人',
  'multi-count': '序号|单据编号|盘点日期|机构|仓库|物品数|状态|审核日期|是否生成盘点单|打印状态|创建日期|创建人',
  profit: '序号|单据编号|来源单号|单据日期|机构|仓库|物品（项）|状态|打印状态|创建时间|创建人|备注',
  loss: '序号|单据编号|来源单号|单据日期|机构|仓库|物品（项）|状态|打印状态|创建人|创建时间|备注',
  limits: '序号|机构编码|机构名称|仓库编码|仓库名称|物品编码|物品名称|规格型号|单位|最小库存天数|安全库存天数|最大库存天数|近7天日均出库量|近14天日均出库量|近21天日均出库量|近30天日均出库量|近60天日均出库量|库存下限数量|库存上限数量|安全库存|当前库存',
}
let container: HTMLDivElement; let root: Root
const result = (id = 'purchase-in'): ManagementResult => ({ id, rows: [{ id: '1', no: 'DOC-01', seq: 1, amount: 20, status: '已入库' }], total: 1, page: 1, pageSize: 20, note: '测试口径', sourceAvailable: true, supportedFilters: ['no', 'org', 'warehouse', 'supplier', 'item', 'status'], options: {} })
const button = (name: string) => [...container.querySelectorAll('button')].find(b => b.textContent === name)!
async function render(id = 'purchase-in') { await act(async () => root.render(<ManagementWorkspace key={id} config={managementPages.find(p => p.id === id)!} />)) }
beforeEach(() => {
  sessionStorage.clear(); navigation.push.mockReset()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  api.fetch.mockReset(); api.fetch.mockImplementation((url: string) => Promise.resolve(result(url.split('/').at(-1)!.split('?')[0])))
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
})
afterEach(() => { act(() => root.unmount()); container.remove() })
describe('审核要求与管理页面', () => {
  it.each(Object.keys(expected))('%s 默认表头与实地核对的字段顺序一致（包含操作）', async id => {
    await render(id)
    expect([...container.querySelectorAll('th')].map(th => th.textContent)).toEqual(['', ...expected[id].split('|'), '操作'])
  })
  it('两个平级导航悬停后显示对应的 5 / 4 个菜单，离开可关闭', () => {
    vi.useFakeTimers()
    act(() => root.render(<nav><ManagementNav group="inventory" pathname="/v2/supply-chain/inventory-management/purchase-in" /><ManagementNav group="stocktake" pathname="/v2/supply-chain/inventory-management/purchase-in" /></nav>))
    const triggers = container.querySelectorAll('nav > a')
    expect(triggers.length).toBe(2)
    for (const [index, size, id] of [[0, 5, 'inventory'], [1, 4, 'stocktake']] as const) {
      act(() => triggers[index].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
      const panel = document.getElementById(`${id}-management-flyout`)!
      expect(panel.querySelectorAll('a')).toHaveLength(size)
      expect(panel.querySelector('.grid-cols-2')).not.toBeNull()
      act(() => { panel.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); vi.advanceTimersByTime(160) })
      expect(document.getElementById(`${id}-management-flyout`)).toBeNull()
    }
    vi.useRealTimers()
  })
  it('跨库存和盘点保留打开标签，关闭非当前标签不跳转；关闭当前标签切换相邻页', async () => {
    await render('purchase-in'); await render('other-in'); await render('count')
    const tabs = () => container.querySelector('nav[aria-label="已打开的库存与盘点页面"]')!
    expect(tabs().querySelectorAll('a')).toHaveLength(3)
    act(() => (tabs().querySelector('[aria-label="关闭其他入库"]') as HTMLButtonElement).click())
    expect(navigation.push).not.toHaveBeenCalled()
    expect(tabs().querySelectorAll('a')).toHaveLength(2)
    act(() => (tabs().querySelector('[aria-label="关闭盘点单"]') as HTMLButtonElement).click())
    expect(navigation.push).toHaveBeenLastCalledWith('/v2/supply-chain/inventory-management/purchase-in')
    await render('purchase-in')
    expect(tabs().textContent).not.toContain('盘点单')
    act(() => (tabs().querySelector('[aria-label="关闭采购入库"]') as HTMLButtonElement).click())
    expect(navigation.push).toHaveBeenLastCalledWith('/v2/supply-chain/home')
    expect(JSON.parse(sessionStorage.getItem('dianjie:management-open-tabs')!)).toEqual([])
  })
  it('查询才应用筛选，重置清除已应用条件', async () => {
    await render()
    const initialQuery = new URL(api.fetch.mock.calls[0][0], 'http://local.test').searchParams
    expect(initialQuery.get('start')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(initialQuery.get('end')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const input = [...container.querySelectorAll('label')].find(l => l.textContent === '单据编号：')!.querySelector('input')!
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'DOC-01'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(api.fetch).toHaveBeenCalledTimes(1)
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    const query = new URL(api.fetch.mock.calls.at(-1)![0], 'http://local.test').searchParams
    expect(JSON.parse(query.get('filters')!)).toMatchObject({ no: 'DOC-01' })
    await act(async () => button('重置').click())
    const resetQuery = new URL(api.fetch.mock.calls.at(-1)![0], 'http://local.test').searchParams
    expect(resetQuery.get('filters')).toBe('{}')
    expect(resetQuery.get('start')).toBe(initialQuery.get('start'))
    expect(resetQuery.get('end')).toBe(initialQuery.get('end'))
  })
  it('日期范围选完后点击查询才发送，右上角不再有功能切换框', async () => {
    await render()
    expect(container.querySelector('[aria-label="切换功能页面"]')).toBeNull()
    act(() => (container.querySelector('[aria-label="选择日期范围"]') as HTMLButtonElement).click())
    act(() => [...document.querySelectorAll('[role=dialog] footer button')].find(b => b.textContent === '昨天')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(api.fetch).toHaveBeenCalledTimes(1)
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    const query = new URL(api.fetch.mock.calls.at(-1)![0], 'http://local.test').searchParams
    expect(query.get('start')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(query.get('start')).toEqual(query.get('end'))
    await act(async () => button('重置').click())
    expect(new URL(api.fetch.mock.calls.at(-1)![0], 'http://local.test').searchParams.get('start')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('快速切换页面时旧请求不能覆盖新页面；勾选不会跨页残留', async () => {
    let resolveOld!: (r: ManagementResult) => void
    api.fetch.mockImplementationOnce(() => new Promise(r => { resolveOld = r }))
    await render('purchase-in'); await render('loss')
    await act(async () => resolveOld({ ...result(), rows: [{ id: 'old', no: 'STALE' }] }))
    expect(container.textContent).not.toContain('STALE')
    act(() => (container.querySelector('tbody input[type=checkbox]') as HTMLInputElement).click())
    expect(button('导出所选（1）')).toBeTruthy()
    await render('other-in'); expect(button('导出所选（1）')).toBeUndefined()
  })
  it.each(['purchase-in', 'count'])('%s 专注表格保留记录与勾选，日期弹窗优先处理 Escape', async id => {
    await render(id)
    act(() => (container.querySelector('tbody input[type=checkbox]') as HTMLInputElement).click())
    act(() => button('专注表格').click())
    expect(button('退出专注').getAttribute('aria-pressed')).toBe('true')
    expect(button('导出所选（1）')).toBeTruthy()
    act(() => (container.querySelector('[aria-label="选择日期范围"]') as HTMLButtonElement).click())
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="dialog"][aria-label="日期范围选择器"]')).toBeNull()
    expect(button('退出专注')).toBeTruthy()
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(button('专注表格').getAttribute('aria-pressed')).toBe('false')
    act(() => button('专注表格').click())
    act(() => button('退出专注').click())
    expect(button('专注表格')).toBeTruthy()
    expect(button('导出所选（1）')).toBeTruthy()
    expect(api.fetch).toHaveBeenCalledTimes(1)
  })
  it('表格设置隐藏/恢复字段，未记录字段显示空值', async () => {
    await render()
    expect(container.querySelector('tbody')!.textContent).toContain('—')
    act(() => button('表格设置').click())
    const label = [...container.querySelectorAll('dialog label')].find(l => l.textContent === '复审状态')!
    act(() => (label.querySelector('input') as HTMLInputElement).click())
    expect([...container.querySelectorAll('th')].map(th => th.textContent)).not.toContain('复审状态')
    act(() => button('恢复全部字段').click())
    expect([...container.querySelectorAll('th')].map(th => th.textContent)).toContain('复审状态')
  })
  it('请求失败时保留完整表头并允许重试；缺少来源时明确说明', async () => {
    api.fetch.mockRejectedValueOnce(new Error('网络异常'))
    await render(); expect(container.querySelector('[role=alert]')?.textContent).toContain('网络异常')
    expect(container.querySelectorAll('th').length).toBe(16)
    await act(async () => button('重新查询').click()); expect(container.querySelector('[role=alert]')).toBeNull()
    api.fetch.mockResolvedValueOnce({ ...result('multi-count'), rows: [], sourceAvailable: false, note: '暂无独立单据来源' })
    await render('multi-count'); expect(container.textContent).toContain('暂无可用单据来源'); expect(button('导出列表').disabled).toBe(true)
  })
})
