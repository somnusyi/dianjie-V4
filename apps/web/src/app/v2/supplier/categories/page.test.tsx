// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CategoriesPage from './page'
import { apiFetch } from '@/lib/v2-auth'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@/components/v2', () => ({ BottomNav: () => null, Chip: ({ children }: any) => <span>{children}</span> }))
vi.mock('@/components/v2/product-tool-tabs', () => ({ ProductToolTabs: () => null }))
const confirmMock = vi.hoisted(() => vi.fn())
vi.mock('@/components/v2/supply-chain-shell', () => ({ SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT: 'dianjie:supply-chain-before-navigate' }))
vi.mock('@/components/v2/confirm-sheet', () => ({ useConfirmSheet: () => [{ open: false }, confirmMock], ConfirmSheet: () => null }))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn(), getUser: () => ({ role: 'SUPPLY_CHAIN' }) }))
vi.mock('@/lib/client-id', () => ({ clientRequestId: () => 'category-sort-test' }))
const fetchMock = vi.mocked(apiFetch)
const category = (id: string | null, name: string) => ({ id, name, count: 2, sortOrder: 0, isActive: true, isSystem: false })
const legacy = [category('master', '蔬菜'), category(null, '历史甲'), category(null, '历史乙')]
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
async function until(predicate: () => boolean) {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
  }
  throw Error('分类测试等待超时')
}
function button(text: string) { return Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === text)! }
function orderedNames() { return Array.from(container.querySelectorAll('ul > li')).map(li => li.querySelector('.text-h2')?.textContent) }
function position(name: string) { return container.querySelector(`input[aria-label="${name}的排序序号"]`) as HTMLInputElement }
function saveCalls() { return fetchMock.mock.calls.filter(([path, init]) => String(path).includes('/categories-order') && init?.method === 'PATCH') }
async function mount(rows = legacy) {
  fetchMock.mockImplementation((path, init) => {
    if (String(path).startsWith('/api/suppliers')) return Promise.resolve([{ id: 'supplier-a', no: 'SUP001', name: '隔离供应商' }, { id: 'supplier-b', no: 'SUP002', name: '隔离供应商乙' }])
    if (String(path).includes('/categories-order')) return Promise.resolve({ ok: true })
    if (String(path).startsWith('/api/products/categories')) return Promise.resolve(rows)
    throw Error(`unexpected ${String(path)} ${init?.method || 'GET'}`)
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<CategoriesPage />))
  await until(() => Boolean(position('历史乙')))
}
beforeEach(() => { fetchMock.mockReset(); confirmMock.mockReset() })
afterEach(() => { if (root) act(() => root.unmount()); container?.remove() })

describe('分类排序兼容历史及隐藏分类', () => {
  it('两个空ID历史行不误进编辑态，各自置顶移动正确并发送完整快照', async () => {
    await mount()
    expect(container.querySelectorAll('ul input:not([type="number"])')).toHaveLength(0)
    expect(container.textContent).not.toContain('来源：')
    await act(async () => (container.querySelector('[aria-label="置顶 历史乙"]') as HTMLButtonElement).click())
    expect(orderedNames()).toEqual(['历史乙', '蔬菜', '历史甲'])
    await act(async () => (container.querySelector('[aria-label="置顶 历史甲"]') as HTMLButtonElement).click())
    expect(orderedNames()).toEqual(['历史甲', '历史乙', '蔬菜'])
    await act(async () => button('保存排序').click())
    expect(saveCalls()[0][0]).toBe('/api/products/categories-order?supplierId=supplier-a')
    expect(JSON.parse(String(saveCalls()[0][1]!.body))).toEqual({ categories: [
      { id: null, name: '历史甲' }, { id: null, name: '历史乙' }, { id: 'master', name: '蔬菜' },
    ] })
  })
  it('岗位主数据与岗位历史分类隐藏，但保存时留在原槽且不遗漏', async () => {
    await mount([legacy[0], category('hidden-master', '素菜岗'), legacy[1], category(null, '水吧'), legacy[2]])
    expect(orderedNames()).toEqual(['蔬菜', '历史甲', '历史乙'])
    await act(async () => (container.querySelector('[aria-label="置顶 历史乙"]') as HTMLButtonElement).click())
    await act(async () => button('保存排序').click())
    expect(JSON.parse(String(saveCalls()[0][1]!.body))).toEqual({ categories: [
      { id: null, name: '历史乙' }, { id: 'hidden-master', name: '素菜岗' },
      { id: 'master', name: '蔬菜' }, { id: null, name: '水吧' }, { id: null, name: '历史甲' },
    ] })
  })
  it('序号直接移动、置底及箭头都保持正确对象', async () => {
    await mount()
    const input = position('历史乙')
    input.value = '1'
    act(() => Simulate.blur(input))
    expect(orderedNames()).toEqual(['历史乙', '蔬菜', '历史甲'])
    await act(async () => (container.querySelector('[aria-label="置底 历史乙"]') as HTMLButtonElement).click())
    expect(orderedNames()).toEqual(['蔬菜', '历史甲', '历史乙'])
    await act(async () => (container.querySelector('[aria-label="上移 历史乙"]') as HTMLButtonElement).click())
    expect(orderedNames()).toEqual(['蔬菜', '历史乙', '历史甲'])
  })
  it('保存网络失败不加载覆盖草稿，错误保留且可以重试', async () => {
    await mount()
    const original = fetchMock.getMockImplementation()!
    let fail = true
    fetchMock.mockImplementation((path, init) => {
      if (String(path).includes('/categories-order') && fail) { fail = false; return Promise.reject(Error('网络中断，请重试')) }
      return original(path, init)
    })
    await act(async () => (container.querySelector('[aria-label="置顶 历史乙"]') as HTMLButtonElement).click())
    const readsBefore = fetchMock.mock.calls.filter(([path]) => String(path).includes('/categories?')).length
    await act(async () => button('保存排序').click())
    expect(container.textContent).toContain('网络中断，请重试')
    expect(orderedNames()).toEqual(['历史乙', '蔬菜', '历史甲'])
    expect(fetchMock.mock.calls.filter(([path]) => String(path).includes('/categories?'))).toHaveLength(readsBefore)
    expect(button('保存排序').disabled).toBe(false)
    await act(async () => button('保存排序').click())
    expect(saveCalls()).toHaveLength(2)
    expect(saveCalls()[0][1]!.body).toBe(saveCalls()[1][1]!.body)
  })
  it('409冲突保留完整草稿和具体错误，不误报成功', async () => {
    await mount()
    const original = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((path, init) => String(path).includes('/categories-order')
      ? Promise.reject(Object.assign(Error('分类列表已变化，请刷新后重新排序'), { status: 409 })) : original(path, init))
    await act(async () => (container.querySelector('[aria-label="置顶 历史乙"]') as HTMLButtonElement).click())
    await act(async () => button('保存排序').click())
    expect(container.textContent).toContain('分类列表已变化，请刷新后重新排序')
    expect(orderedNames()).toEqual(['历史乙', '蔬菜', '历史甲'])
    expect(button('保存排序')).toBeTruthy()
  })
  it('搜索时不能重排，清空后原全量顺序仍在', async () => {
    await mount()
    const search = container.querySelector('input[type="search"]')!
    act(() => Simulate.change(search, { target: { value: '历史乙' } as any }))
    expect(orderedNames()).toEqual(['历史乙'])
    expect(position('历史乙').disabled).toBe(true)
    act(() => Simulate.change(search, { target: { value: '' } as any }))
    expect(orderedNames()).toEqual(['蔬菜', '历史甲', '历史乙'])
    expect(saveCalls()).toHaveLength(0)
  })
  it.each(['resolve', 'reject'])('切换供应商后忽略较早作用域的慢%s响应，不覆盖当前分类或错误', async outcome => {
    await mount()
    const original = fetchMock.getMockImplementation()!
    let complete!: (rows: typeof legacy) => void
    let fail!: (error: Error) => void
    const pending = new Promise<typeof legacy>((resolve, reject) => { complete = resolve; fail = reject })
    fetchMock.mockImplementation((path, init) => String(path) === '/api/products/categories?supplierId=supplier-b' ? pending : original(path, init))
    const selector = container.querySelector('header select') as HTMLSelectElement
    await act(async () => Simulate.change(selector, { target: { value: 'supplier-b' } as any }))
    expect(orderedNames()).toEqual([])
    await act(async () => Simulate.change(selector, { target: { value: 'supplier-a' } as any }))
    await until(() => Boolean(position('历史乙')))
    await act(async () => {
      if (outcome === 'resolve') complete([category('b1', '乙公司分类')])
      else fail(Error('乙公司请求失败'))
      await pending.catch(() => {})
    })
    expect(selector.value).toBe('supplier-a')
    expect(orderedNames()).toEqual(['蔬菜', '历史甲', '历史乙'])
    expect(container.textContent).not.toContain('乙公司请求失败')
    await act(async () => (container.querySelector('[aria-label="置顶 历史乙"]') as HTMLButtonElement).click())
    await act(async () => button('保存排序').click())
    expect(saveCalls()[0][0]).toBe('/api/products/categories-order?supplierId=supplier-a')
    expect(JSON.parse(String(saveCalls()[0][1]!.body)).categories.map((row: any) => row.name)).toEqual(['历史乙', '蔬菜', '历史甲'])
  })
  it('排序保存未结束前禁止切供应商，成功后可切换且按新作用域加载', async () => {
    await mount()
    const original = fetchMock.getMockImplementation()!
    let complete!: (value: { ok: boolean }) => void
    const pending = new Promise<{ ok: boolean }>(resolve => { complete = resolve })
    fetchMock.mockImplementation((path, init) => {
      if (String(path).includes('/categories-order')) return pending
      if (String(path) === '/api/products/categories?supplierId=supplier-b') return Promise.resolve([category('b1', '乙公司分类')])
      return original(path, init)
    })
    await act(async () => (container.querySelector('[aria-label="置顶 历史乙"]') as HTMLButtonElement).click())
    await act(async () => button('保存排序').click())
    const selector = container.querySelector('header select') as HTMLSelectElement
    expect(selector.disabled).toBe(true)
    expect(selector.value).toBe('supplier-a')
    await act(async () => { complete({ ok: true }); await pending })
    await until(() => !selector.disabled)
    await act(async () => Simulate.change(selector, { target: { value: 'supplier-b' } as any }))
    await until(() => orderedNames().includes('乙公司分类'))
    expect(orderedNames()).toEqual(['乙公司分类'])
    expect(saveCalls()[0][0]).toBe('/api/products/categories-order?supplierId=supplier-a')
  })

})


it('未保存排序切换供应商先确认，取消不丢草稿，确认才切换', async () => {
  await mount()
  await act(async () => (container.querySelector('[aria-label="置顶 历史乙"]') as HTMLButtonElement).click())
  const selector = container.querySelector('header select') as HTMLSelectElement
  await act(async () => Simulate.change(selector, { target: { value: 'supplier-b' } as any }))
  expect(selector.value).toBe('supplier-a')
  expect(orderedNames()).toEqual(['历史乙', '蔬菜', '历史甲'])
  expect(confirmMock.mock.lastCall?.[0].title).toBe('排序尚未保存')
  expect(button('＋ 新增分类').disabled).toBe(true)
  const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
  await act(async () => confirmMock.mock.lastCall![0].onConfirm())
  expect(selector.value).toBe('supplier-b')
})
it('取消排序恢复已保存快照并解除离开保护；编辑分类时不允许排序', async () => {
  await mount()
  await act(async () => (container.querySelector('[aria-label="置顶 历史乙"]') as HTMLButtonElement).click())
  await act(async () => button('取消排序').click())
  expect(orderedNames()).toEqual(['蔬菜', '历史甲', '历史乙'])
  const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(false)
  await act(async () => button('＋ 新增分类').click())
  expect(position('历史乙').disabled).toBe(true)
})
it('排序未保存时页面链接和菜单导航都先确认而不丢弃草稿', async () => {
  await mount()
  await act(async () => (container.querySelector('[aria-label="置顶 历史乙"]') as HTMLButtonElement).click())
  const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
  await act(async () => container.querySelector('header a')!.dispatchEvent(click))
  expect(click.defaultPrevented).toBe(true)
  const proceed = vi.fn()
  const navigate = new CustomEvent('dianjie:supply-chain-before-navigate', { cancelable: true, detail: { proceed } })
  await act(async () => window.dispatchEvent(navigate))
  expect(navigate.defaultPrevented).toBe(true); expect(proceed).not.toHaveBeenCalled()
  await act(async () => confirmMock.mock.lastCall![0].onConfirm())
  expect(proceed).toHaveBeenCalledOnce()
})
