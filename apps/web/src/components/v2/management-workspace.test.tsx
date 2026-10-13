// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagementWorkspace } from './management-workspace'
import { ManagementNav } from './management-nav'
import { managementPages, type ManagementResult } from '@/lib/inventory-management'

const api = vi.hoisted(() => ({ fetch: vi.fn(), role: 'SUPPLY_CHAIN' }))
const navigation = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => navigation }))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: api.fetch, getUser: () => ({ role: api.role }) }))
vi.mock('next/link', () => ({ default: React.forwardRef<HTMLAnchorElement, any>(({ children, href, ...props }, ref) => <a ref={ref} href={href} {...props}>{children}</a>) }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const expected: Record<string, string> = {
  'purchase-in': '序号|单据编号|入库日期|上游单据号|采购机构|仓库|供应商|金额|状态|复审状态|创建时间|创建人|备注|附件',
  'purchase-return': '序号|单据编号|出库日期|上游单据号|采购机构|供应商|金额|状态|复审状态|发票状态|打印状态|创建时间|创建人|备注',
  'other-in': '序号|单据编号|入库日期|机构|仓库|入库原因|金额|状态|复审状态|打印状态|创建时间|创建人|备注|附件',
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
  sessionStorage.clear(); navigation.push.mockReset(); api.role = 'SUPPLY_CHAIN'
  Object.defineProperty(window, 'print', { configurable: true, value: vi.fn() })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  api.fetch.mockReset(); api.fetch.mockImplementation((url: string) => Promise.resolve(result(url.split('/').at(-1)!.split('?')[0])))
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
})
afterEach(() => { act(() => root.unmount()); container.remove() })
describe('审核要求与管理页面', () => {
  it.each(Object.keys(expected))('%s 默认表头与实地核对的字段顺序一致', async id => {
    await render(id)
    expect([...container.querySelectorAll('th')].map(th => th.textContent)).toEqual(['', ...expected[id].split('|'), ...(['count','multi-count','purchase-in','purchase-return','other-in','other-out'].includes(id) ? ['操作'] : [])])
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
    const tabs = () => container.querySelector('nav[aria-label="已打开的业务页面"]')!
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
    expect(button(id === 'count' ? '批量导出单据列表' : '导出所选（1）')).toBeTruthy()
    act(() => (container.querySelector('[aria-label="选择日期范围"]') as HTMLButtonElement).click())
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="dialog"][aria-label="日期范围选择器"]')).toBeNull()
    expect(button('退出专注')).toBeTruthy()
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(button('专注表格').getAttribute('aria-pressed')).toBe('false')
    act(() => button('专注表格').click())
    act(() => button('退出专注').click())
    expect(button('专注表格')).toBeTruthy()
    expect(button(id === 'count' ? '批量导出单据列表' : '导出所选（1）')).toBeTruthy()
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
  it('只在查询结果可用时打印当前筛选结果', async () => {
    await render()
    await act(async () => { button('打印当前筛选结果').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(String(api.fetch.mock.calls.at(-1)?.[0])).toContain('print=1')
    expect(container.querySelector('[aria-label="采购入库当前筛选打印结果"]')?.textContent).toContain('DOC-01')
    expect(window.print).not.toHaveBeenCalled()

    api.fetch.mockResolvedValueOnce({ ...result('multi-count'), rows: [], sourceAvailable: false, note: '暂无独立单据来源' })
    await render('multi-count')
    expect(button('批量打印').disabled).toBe(true)
  })
  it('盘点单从供应链管理表格进入只读复盘页', async () => {
    await render('count')
    const link = [...container.querySelectorAll('a')].find(item => item.textContent === '复盘差异')
    expect(link?.getAttribute('href')).toBe('/v2/supply-chain/stocktake/count/1')
  })
  it('采购与其他入库单号显示来源徽标，并直达原始单据与附件', async () => {
    api.fetch.mockResolvedValueOnce({ ...result('purchase-in'), rows: [{ id: 'receipt:1', detailId: '1', recordType: 'UPSTREAM_RECEIPT', no: 'DOC-01', seq: 1, source: '采购收货', attachments: '2 项' }] })
    await render('purchase-in')
    expect(container.textContent).toContain('DOC-01采购收货')
    expect(container.textContent).toContain('2 项')
    expect(container.querySelector('a[href="/v2/supply-chain/procurement/receipts/1/edit?from=purchase-in"]')?.textContent).toBe('DOC-01')
    expect(button('查看')).toBeUndefined()
    expect(container.querySelector('button[aria-label="查看 DOC-01 内容"]')).toBeNull()
  })
  it('请求失败时保留完整表头并允许重试；缺少来源时明确说明', async () => {
    api.fetch.mockRejectedValueOnce(new Error('网络异常'))
    await render(); expect(container.querySelector('[role=alert]')?.textContent).toContain('网络异常')
    expect(container.querySelectorAll('th').length).toBe(16)
    await act(async () => button('重新查询').click()); expect(container.querySelector('[role=alert]')).toBeNull()
    api.fetch.mockResolvedValueOnce({ ...result('multi-count'), rows: [], sourceAvailable: false, note: '暂无独立单据来源' })
    await render('multi-count'); expect(container.textContent).toContain('暂无可用单据来源'); expect(button('批量导出单据列表').disabled).toBe(true)
  })
  it('盘点工具栏顺序、空选择禁用和原创建入口正确', async () => {
    await render('count')
    const labels = [...container.querySelectorAll('[class*=toolbar] a, [class*=toolbar] button')].map(el => el.textContent)
    expect(labels).toEqual(['＋ 批次盘点', '批量打印', '批量提交', '批量审核', '批量反审核', '批量导出', '批量导出单据列表'])
    expect(container.querySelector('[class*=toolbar] a')?.getAttribute('href')).toBe('/v2/supply-chain/stocktake/work?create=1&from=count')
    expect(button('批量提交').disabled).toBe(true)
    expect(button('批量反审核').disabled).toBe(true)
  })
  it('盘点单行审核先确认、取消不写，重新读取发现终态不发审核请求', async () => {
    api.fetch.mockImplementation((url: string) => url.startsWith('/api/inventory-management/')
      ? Promise.resolve({ ...result('count'), rows: [{ id: 'warehouse:pending', detailId: 'pending', recordType: 'WAREHOUSE_STOCKTAKE', no: 'PD-PENDING', status: '待审核' }] })
      : Promise.resolve({ rowVersion: 3, status: 'CONFIRMED' }))
    await render('count')
    expect(button('审核').disabled).toBe(false)
    act(() => button('审核').click()); act(() => button('取消').click())
    expect(api.fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0)
    act(() => button('审核').click()); await act(async () => button('确认审核').click())
    expect(api.fetch.mock.calls.some(call => call[0] === '/api/warehouse-stocktakes/pending')).toBe(true)
    expect(api.fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0)
    expect(container.querySelector('[role=status]')?.textContent).toContain('只有待审核单据可以审核')
  })
  it('行审批确认及延迟请求期间锁定查询分页，程序提交也不能切换上下文', async () => {
    let resolvePost!: (value: object) => void
    api.fetch.mockImplementation((url: string, options?: any) => {
      if (url.startsWith('/api/inventory-management/')) return Promise.resolve({ ...result('count'), total: 50, rows: [{ id: 'warehouse:p', detailId: 'p', recordType: 'WAREHOUSE_STOCKTAKE', no: 'PD-P', status: '待审核' }] })
      if (options?.method === 'POST') return new Promise(resolve => { resolvePost = resolve })
      return Promise.resolve({ rowVersion: 3, status: 'REVIEWING' })
    })
    await render('count')
    const queries = () => api.fetch.mock.calls.filter(call => String(call[0]).startsWith('/api/inventory-management/')).length
    const assertLocked = () => {
      expect(button('查询').disabled).toBe(true); expect(button('重置').disabled).toBe(true)
      expect((container.querySelector('[aria-label="每页条数"]') as HTMLSelectElement).disabled).toBe(true)
      expect((container.querySelector('[aria-label="下一页"]') as HTMLButtonElement).disabled).toBe(true)
    }
    act(() => button('审核').click()); assertLocked()
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(queries()).toBe(1)
    act(() => button('取消').click()); expect(button('查询').disabled).toBe(false)
    act(() => button('审核').click())
    await act(async () => { button('确认审核').click() })
    assertLocked()
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(queries()).toBe(1)
    await act(async () => resolvePost({}))
    expect(queries()).toBe(2)
    expect(button('查询').disabled).toBe(false)
    expect((container.querySelector('[aria-label="下一页"]') as HTMLButtonElement).disabled).toBe(false)
  })
  it('行审核只审核当前单，忽略另一个已勾选单据', async () => {
    api.fetch.mockImplementation((url: string) => url.startsWith('/api/inventory-management/')
      ? Promise.resolve({ ...result('count'), rows: ['one', 'two'].map(id => ({ id: `warehouse:${id}`, detailId: id, recordType: 'WAREHOUSE_STOCKTAKE', no: `PD-${id}`, status: '待审核' })) })
      : Promise.resolve({ rowVersion: 3, status: 'REVIEWING' }))
    await render('count')
    act(() => (container.querySelector('[aria-label="选择PD-two"]') as HTMLInputElement).click())
    const row = [...container.querySelectorAll('tbody tr')].find(r => r.textContent?.includes('PD-one'))!
    act(() => [...row.querySelectorAll('button')].find(b => b.textContent === '审核')!.click())
    await act(async () => button('确认审核').click())
    expect(api.fetch.mock.calls.filter(call => call[1]?.method === 'POST').map(call => call[0])).toEqual(['/api/warehouse-stocktakes/one/approve'])
  })
  it.each([
    ['WAREHOUSE_STOCKTAKE', '已审核'], ['WAREHOUSE_STOCKTAKE', '已取消'],
    ['STORE_INVENTORY_COUNT', '待审核'], ['IMPORTED_BASELINE', '待审核'],
  ])('盘点单%s/%s不显示总仓行审批', async (recordType, status) => {
    api.fetch.mockResolvedValueOnce({ ...result('count'), rows: [{ id: 'one', no: 'PD-ONE', recordType, status }] })
    await render('count')
    expect(button('审核')).toBeUndefined()
    expect(button('提交')).toBeUndefined()
  })
  it('盘点单行提交只使用该行真实来源并保留原版本检查', async () => {
    api.fetch.mockImplementation((url: string) => url.startsWith('/api/inventory-management/')
      ? Promise.resolve({ ...result('count'), rows: [{ id: 'warehouse:draft', detailId: 'draft', recordType: 'WAREHOUSE_STOCKTAKE', no: 'PD-DRAFT', status: '盘点中' }] })
      : Promise.resolve({ rowVersion: 7, status: 'COUNTING' }))
    await render('count')
    expect(button('审核').disabled).toBe(true)
    act(() => button('提交').click()); await act(async () => button('确认提交').click())
    const posts = api.fetch.mock.calls.filter(call => call[1]?.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0][0]).toBe('/api/warehouse-stocktakes/draft/submit')
    expect(JSON.parse(posts[0][1].body)).toEqual({ rowVersion: 7 })
  })
  it.each(['FINANCE', 'STORE_MANAGER'])('盘点列表不向%s开放总仓行审批', async role => {
    api.role = role
    api.fetch.mockResolvedValueOnce({ ...result('count'), rows: [{ id: 'warehouse:p', detailId: 'p', recordType: 'WAREHOUSE_STOCKTAKE', no: 'PD-P', status: '待审核' }] })
    await render('count')
    expect(button('审核')).toBeUndefined()
    expect(button('提交')).toBeUndefined()
    expect(button('批量审核').disabled).toBe(true)
  })
  it('批量审核取消不写入，失败停止后续单据并保留成功结果', async () => {
    const rows = ['a', 'b', 'c'].map(id => ({ id, detailId: id, recordType: 'WAREHOUSE_STOCKTAKE', no: `PD-${id}`, status: '待审核' }))
    api.fetch.mockImplementation((url: string, options?: any) => {
      if (url.startsWith('/api/inventory-management/')) return Promise.resolve({ ...result('count'), rows, total: 3 })
      if (url.endsWith('/b/approve')) return Promise.reject(new Error('网络失败'))
      if (options?.method === 'POST') return Promise.resolve({})
      return Promise.resolve({ rowVersion: 2, status: 'REVIEWING' })
    })
    await render('count')
    act(() => (container.querySelector('[aria-label="选择本页全部记录"]') as HTMLInputElement).click())
    act(() => button('批量审核').click())
    act(() => button('取消').click())
    expect(api.fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0)
    act(() => button('批量审核').click())
    await act(async () => button('确认审核').click())
    expect(api.fetch.mock.calls.filter(call => call[1]?.method === 'POST').map(call => call[0])).toEqual(['/api/warehouse-stocktakes/a/approve', '/api/warehouse-stocktakes/b/approve'])
    expect(container.querySelector('[role=status]')?.textContent).toContain('已成功1张')
    expect(container.querySelector('[role=status]')?.textContent).toContain('后续1张未执行')
    expect(container.querySelector('[role=status] a')?.getAttribute('href')).toBe('/v2/supply-chain/stocktake/work?doc=b&from=count')
  })
  it('所选盘点打印读取单据明细，任一读取失败不打印部分单据', async () => {
    api.fetch.mockResolvedValueOnce({ ...result('count'), rows: [{ id: 'warehouse:a', detailId: 'a', recordType: 'WAREHOUSE_STOCKTAKE', no: 'PD-a' }] })
    await render('count')
    act(() => (container.querySelector('tbody input[type=checkbox]') as HTMLInputElement).click())
    api.fetch.mockRejectedValueOnce(new Error('明细读取失败'))
    await act(async () => button('批量打印').click())
    expect(api.fetch).toHaveBeenLastCalledWith('/api/warehouse-stocktakes/a/review')
    expect(window.print).not.toHaveBeenCalled()
    expect(container.querySelector('[role=alert]')?.textContent).toContain('明细读取失败')
  })

  it('盘点差异显示真实项数、标识固定且逐行打印读取本单', async () => {
    const row = { id: 'warehouse:one', detailId: 'one', recordType: 'WAREHOUSE_STOCKTAKE', no: 'PD001', seq: 1, status: '已审核', difference: '有差异', differenceCount: 3 }
    api.fetch.mockResolvedValueOnce({ ...result('count'), rows: [row] })
    await render('count')
    expect(container.querySelector('tbody')?.textContent).toContain('3项差异')
    expect(container.querySelector('tbody td[class*=fixedDocument]')?.textContent).toContain('PD001')
    expect([...container.querySelectorAll('tbody button')].map(b => b.textContent)).toEqual(['反审核', '打印', '导出'])
    api.fetch.mockResolvedValueOnce({ no: 'PD001', countDate: '2026-10-12', items: [{ id: 'line', productNameSnapshot: '土豆', countedQuantity: 8 }] })
    await act(async () => { button('打印').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(api.fetch).toHaveBeenLastCalledWith('/api/warehouse-stocktakes/one/review')
    expect(container.querySelector('[aria-label="所选盘点单打印明细"]')?.textContent).toContain('土豆')
    expect(window.print).not.toHaveBeenCalled()
  })

  it('打印未发出afterprint时仍能关闭预览恢复操作', async () => {
    api.fetch.mockResolvedValueOnce({ ...result('count'), rows: [{ id: 'warehouse:a', detailId: 'a', recordType: 'WAREHOUSE_STOCKTAKE', no: 'PD-a' }] })
    await render('count')
    api.fetch.mockResolvedValueOnce({ no: 'PD-a', countDate: '2026-10-12T00:00:00.000Z', items: [{ id: 'line', productNameSnapshot: '测试商品',productSpecSnapshot:'500g/袋',countedQuantity:null }] })
    await act(async () => { button('打印').click(); await new Promise(resolve => setTimeout(resolve, 10)) })
    expect(window.print).not.toHaveBeenCalled()
    expect(container.querySelector('[role="dialog"][aria-label="所选盘点单打印明细"]')?.textContent).toContain('测试商品')
    expect(container.querySelector('[aria-label="所选盘点单打印明细"]')?.textContent).toContain('500g/袋')
    expect(container.querySelector('[aria-label="所选盘点单打印明细"]')?.textContent).not.toContain('T00:00')
    await act(async () => button('打印 / 保存 PDF').click())
    expect(window.print).toHaveBeenCalledTimes(1)
    await act(async () => button('关闭打印预览').click())
    expect(container.querySelector('[aria-label="所选盘点单打印明细"]')).toBeNull()
    expect(button('打印').disabled).toBe(false)
  })

  it.each([
    ['POSTED', 'UNREVIEWED', ['编辑', '审核', '打印', '保存', '质检']],
    ['CONFIRMED', 'UNREVIEWED', ['反审核', '复审', '打印', '保存', '质检']],
    ['CONFIRMED', 'REVIEWED', ['打印', '保存', '质检']],
  ])('仓库单据按真实%s/%s显示阶段动作，固定动作保留', async (docStatus, docReviewStatus, expectedActions) => {
    api.fetch.mockResolvedValueOnce({ ...result('other-in'), rows: [{ id:'doc', detailId:'doc', recordType:'WAREHOUSE_DOC', no:'RK-DOC', docStatus, docReviewStatus }] })
    await render('other-in')
    const operation = container.querySelector('tbody td[class*=operation]')!
    expect([...operation.querySelectorAll('a, button')].map(el => el.textContent)).toEqual(expectedActions)
    expect(operation.querySelector('a')?.getAttribute('href')).toContain('/docs/doc/edit')
    expect(api.fetch.mock.calls.every(call => call[1]?.method !== 'POST')).toBe(true)
  })

  it.each([
    ['UPSTREAM_RECEIPT','purchase-in','receipts','PENDING',['编辑','审核','打印','保存','质检']],
    ['UPSTREAM_RETURN','purchase-return','returns','AUDITED',['反审核','复审','打印','保存','质检']],
    ['UPSTREAM_RECEIPT','purchase-in','receipts','REVIEWED',['打印','保存','质检']],
  ])('采购真实来源 %s 固定入口及阶段使用原始 ID',async(recordType,page,path,approvalStatus,actions)=>{
    api.fetch.mockResolvedValueOnce({...result(page),rows:[{id:'prefixed:source-id',detailId:'source-id',recordType,no:'SOURCE-NO',sourceStatus:approvalStatus==='REVIEWED'?'POSTED':'DRAFT',approvalStatus,businessFieldsLocked:approvalStatus==='PENDING'?0:1}]})
    await render(page)
    const cell=container.querySelector('tbody td[class*=operation]')!
    expect([...cell.querySelectorAll('a,button')].map(el=>el.textContent)).toEqual(actions)
    for(const link of cell.querySelectorAll('a'))expect(link.getAttribute('href')).toContain(`/procurement/${path}/source-id/edit`)
    api.fetch.mockResolvedValueOnce({version:0,image:null,history:[],canWrite:false})
    await act(async()=>Array.from(cell.querySelectorAll('button')).find(b=>b.textContent==='质检')!.click())
    expect(api.fetch.mock.calls.at(-1)?.[0]).toBe(`/api/upstream/${recordType==='UPSTREAM_RECEIPT'?'receipts':'purchase-returns'}/source-id/quality-image`)
    expect(api.fetch.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true)
  })

  it('盘点机构高级选择启用关联仓库，切机构清除旧仓库', async () => {
    api.fetch.mockResolvedValueOnce({ ...result('count'), options: { org: ['甲机构', '乙机构'], warehouse: ['甲仓', '乙仓'] }, warehousesByOrg: { '甲机构': ['甲仓'], '乙机构': ['乙仓'] } })
    await render('count')
    const warehouse = () => [...container.querySelectorAll('label')].find(label => label.textContent?.startsWith('仓库：'))!.querySelector('select')!
    expect(warehouse().disabled).toBe(true)
    act(() => button('高级').click())
    expect(container.querySelector('dialog[aria-label="选择机构"]')).not.toBeNull()
    act(() => button('甲机构').click())
    expect(warehouse().disabled).toBe(false)
    expect([...warehouse().options].map(option => option.textContent)).toEqual(['全部', '甲仓'])
    act(() => { warehouse().value = '甲仓'; warehouse().dispatchEvent(new Event('change', { bubbles: true })) })
    act(() => button('高级').click())
    act(() => button('乙机构').click())
    expect(warehouse().value).toBe('')
    expect([...warehouse().options].map(option => option.textContent)).toEqual(['全部', '乙仓'])
  })
  it('操作日志只读取盘点日志，不触发业务写入', async () => {
    await render('count')
    api.fetch.mockResolvedValueOnce({ items: [{ id: 'log', no: 'PD001', action: '创建盘点', actor: '测试供应链', createdAt: '2026-10-12T00:00:00Z' }] })
    await act(async () => button('操作日志').click())
    expect(api.fetch).toHaveBeenLastCalledWith('/api/warehouse-stocktakes/logs')
    expect(container.querySelector('dialog[aria-label="操作日志"]')?.textContent).toContain('PD001')
    expect(api.fetch.mock.calls.every(call => call[1]?.method !== 'POST')).toBe(true)
  })

})

it('多人逐行操作不依赖勾选其他单，待提交审核禁用、已审核只打印导出',async()=>{
 const rows=[{id:'multi-1',detailId:'multi-1',no:'MULTI-1',recordType:'WAREHOUSE_STOCKTAKE',status:'草稿'},{id:'multi-2',detailId:'multi-2',no:'MULTI-2',recordType:'WAREHOUSE_STOCKTAKE',status:'已审核'}]
 api.fetch.mockImplementation(async(url:string)=>url.includes('/inventory-management/')?{...result('multi-count'),rows}:url==='/api/warehouse-stocktakes/multi-1'?{status:'DRAFT',rowVersion:7}:{})
 await render('multi-count')
 const first=[...container.querySelectorAll('tbody tr')].find(row=>row.textContent?.includes('MULTI-1'))!
 const second=[...container.querySelectorAll('tbody tr')].find(row=>row.textContent?.includes('MULTI-2'))!
 expect([...first.querySelectorAll('td:last-child button')].map(b=>b.textContent)).toEqual(['提交','审核','打印','导出'])
 expect((first.querySelectorAll('td:last-child button')[1] as HTMLButtonElement).disabled).toBe(true)
 expect([...second.querySelectorAll('td:last-child button')].map(b=>b.textContent)).toEqual(['打印','导出'])
 await act(async()=>first.querySelector<HTMLButtonElement>('td:last-child button')!.click())
 expect(api.fetch.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false)
 await act(async()=>button('取消').click())
 expect(api.fetch.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false)
 await act(async()=>first.querySelector<HTMLButtonElement>('td:last-child button')!.click())
 await act(async()=>button('确认提交').click())
 const writes=api.fetch.mock.calls.filter(([,init])=>init?.method==='POST')
 expect(writes).toHaveLength(1);expect(writes[0][0]).toBe('/api/warehouse-stocktakes/multi-1/submit')
 expect(JSON.parse(String(writes[0][1]?.body))).toEqual({rowVersion:7})
})
