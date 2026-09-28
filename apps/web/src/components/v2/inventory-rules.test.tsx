// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InventoryRules } from './inventory-rules'
import { SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT } from './supply-chain-shell'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const mock = vi.hoisted(() => ({ api: vi.fn(), confirm: vi.fn() }))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: mock.api }))
vi.mock('@/lib/ui-dialogs', () => ({ confirmDialog: mock.confirm }))
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a> }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const result = (unitChanged = false, source: 'configured' | 'legacy-fallback' = 'configured') => ({
  warehouse: { id: 'w1', code: 'MAIN', name: '总仓', isDefault: true },
  warehouses: [{ id: 'w1', code: 'MAIN', name: '总仓', isDefault: true }, { id: 'w2', code: 'COLD', name: '冷藏仓', isDefault: false }],
  items: [
    { productId: 'p1', code: 'P001', name: '土豆', spec: '1kg', category: '蔬菜', inventoryUnit: 'kg', currentQty: 12, minQty: 5, maxQty: 20, stagnantDays: 30, source, alertStatus: '正常', active: true, rowVersion: source === 'legacy-fallback' ? 0 : 2, unitChanged, hasPolicy: source !== 'legacy-fallback' },
    { productId: 'p2', code: 'P002', name: '白菜', spec: '500g', category: '蔬菜', inventoryUnit: 'kg', currentQty: 8, minQty: 2, maxQty: 15, stagnantDays: 45, source: 'configured', alertStatus: '正常', active: true, rowVersion: 1, unitChanged: false, hasPolicy: true },
  ],
  total: 2, page: 1, pageSize: 50,
})

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLDivElement
async function render(unitChanged = false, source: 'configured' | 'legacy-fallback' = 'configured') {
  mock.api.mockImplementation((url: string) => url.startsWith('/api/inventory-reports/policies?') ? Promise.resolve(result(unitChanged, source)) : Promise.resolve({ policy: { minQty: 5, maxQty: 25, stagnantDays: 30, active: true, rowVersion: 3 }, replayed: false }))
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  await act(async () => root!.render(<InventoryRules />))
}
afterEach(() => { act(() => root?.unmount()); container?.remove(); sessionStorage.clear(); mock.api.mockReset(); mock.confirm.mockReset(); vi.restoreAllMocks() })

function setInput(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!
  descriptor.set!.call(input, value)
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('库存上下限与呆滞规则页面', () => {
  it('提供独立入口、仓库切换、预警跳转和停用语义', async () => {
    await render()
    expect(container.textContent).toContain('库存上下限与呆滞规则')
    expect(container.textContent).toContain('不自动移库')
    expect(container.textContent).toContain('停用后该仓库商品按“阈值未配置”处理')
    expect(container.querySelector('a[href="/v2/supply-chain/reports?report=alerts"]')).not.toBeNull()
    expect(container.querySelector('td[data-label="库存上限"]')).not.toBeNull()
    const warehouse = container.querySelector('select[aria-label="仓库"]') as HTMLSelectElement
    await act(async () => setInput(warehouse, 'w2'))
    expect(mock.api.mock.calls.some(([url]) => String(url).includes('warehouseId=w2'))).toBe(true)
  })

  it('保存库存基准单位阈值并携带CAS版本', async () => {
    await render()
    const max = container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement
    await act(async () => setInput(max, '25'))
    const save = [...container.querySelectorAll('button')].find(button => button.textContent === '保存')!
    await act(async () => save.click())
    const call = mock.api.mock.calls.find(([url, init]) => url === '/api/inventory-reports/policies/p1' && init?.method === 'PATCH')
    const payload = JSON.parse(String(call?.[1]?.body))
    expect(payload).toMatchObject({ warehouseId: 'w1', minQty: 5, maxQty: 25, stagnantDays: 30, active: true, rowVersion: 2, confirmUnitChange: false })
    expect(payload.requestId).toBeTruthy()
  })

  it('库存单位变更必须二次确认', async () => {
    mock.confirm.mockResolvedValue(false)
    await render(true)
    const max = container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement
    await act(async () => setInput(max, '25'))
    const save = [...container.querySelectorAll('button')].find(button => button.textContent === '保存')!
    await act(async () => save.click())
    expect(mock.confirm).toHaveBeenCalled()
    expect(mock.api.mock.calls.some(([url]) => url === '/api/inventory-reports/policies/p1')).toBe(false)
    mock.confirm.mockResolvedValue(true)
    await act(async () => save.click())
    const call = mock.api.mock.calls.find(([url, init]) => url === '/api/inventory-reports/policies/p1' && init?.method === 'PATCH')
    expect(JSON.parse(String(call?.[1]?.body)).confirmUnitChange).toBe(true)
  })

  it('旧安全库存显示为兼容生效，保存时明确迁移', async () => {
    mock.confirm.mockResolvedValue(true)
    await render(false, 'legacy-fallback')
    expect(container.textContent).toContain('旧安全库存兼容 · 待迁移')
    expect(container.textContent).toContain('兼容生效')
    const max = container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement
    await act(async () => setInput(max, '25'))
    const save = [...container.querySelectorAll('button')].find(button => button.textContent === '迁移并保存')!
    await act(async () => save.click())
    expect(mock.confirm).toHaveBeenCalledWith(expect.stringContaining('迁移为该仓库的独立库存规则'))
  })

  it('保存一行不会丢失另一行尚未保存的修改', async () => {
    await render()
    const potato = container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement
    const cabbage = container.querySelector('input[aria-label="白菜库存上限"]') as HTMLInputElement
    await act(async () => { setInput(potato, '25'); setInput(cabbage, '18') })
    expect(container.textContent).toContain('2 条未保存')
    const potatoSave = [...container.querySelectorAll('button')].find(button => button.textContent === '保存')!
    await act(async () => potatoSave.click())
    expect((container.querySelector('input[aria-label="白菜库存上限"]') as HTMLInputElement).value).toBe('18')
    expect(container.textContent).toContain('1 条未保存')
  })

  it('切换仓库前拦截未保存修改，取消后不发请求', async () => {
    mock.confirm.mockResolvedValue(false)
    await render()
    const max = container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement
    await act(async () => setInput(max, '25'))
    const callsBefore = mock.api.mock.calls.length
    const warehouse = container.querySelector('select[aria-label="仓库"]') as HTMLSelectElement
    await act(async () => setInput(warehouse, 'w2'))
    expect(mock.confirm).toHaveBeenCalledWith(expect.stringContaining('尚未保存'))
    expect(mock.api.mock.calls.length).toBe(callsBefore)
  })

  it('CAS冲突仅刷新冲突行并保留其他草稿', async () => {
    let getCount = 0
    mock.api.mockImplementation((url: string) => {
      if (url.startsWith('/api/inventory-reports/policies?')) { getCount += 1; return Promise.resolve(result()) }
      if (url === '/api/inventory-reports/policies/p1') return Promise.reject(new Error('库存规则已被其他人修改，请刷新后重试'))
      return Promise.resolve({ policy: { minQty: 2, maxQty: 18, stagnantDays: 45, active: true, rowVersion: 2 }, replayed: false })
    })
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    await act(async () => root!.render(<InventoryRules />))
    const potato = container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement
    const cabbage = container.querySelector('input[aria-label="白菜库存上限"]') as HTMLInputElement
    await act(async () => { setInput(potato, '25'); setInput(cabbage, '18') })
    const save = [...container.querySelectorAll('button')].find(button => button.textContent === '保存')!
    await act(async () => save.click())
    expect(getCount).toBeGreaterThan(1)
    expect(container.textContent).toContain('其他未保存修改已保留')
    expect((container.querySelector('input[aria-label="白菜库存上限"]') as HTMLInputElement).value).toBe('18')
  })

  it('停用已生效规则必须危险确认', async () => {
    mock.confirm.mockResolvedValue(false)
    await render()
    const toggle = container.querySelector('input[aria-label="土豆启用库存规则"]') as HTMLInputElement
    await act(async () => toggle.click())
    const save = [...container.querySelectorAll('button')].find(button => button.textContent === '保存')!
    await act(async () => save.click())
    expect(mock.confirm).toHaveBeenCalledWith(expect.stringContaining('不会恢复旧安全库存'))
    expect(mock.api.mock.calls.some(([url]) => url === '/api/inventory-reports/policies/p1')).toBe(false)
  })

  it('未保存修改会保护报表深链、管理标签和浏览器离开', async () => {
    sessionStorage.setItem('dianjie:management-open-tabs', JSON.stringify(['purchase-in']))
    mock.confirm.mockResolvedValue(false)
    await render()
    const max = container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement
    await act(async () => setInput(max, '25'))

    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)

    const alertLink = container.querySelector('a[href="/v2/supply-chain/reports?report=alerts"]')!
    const alertNavigation = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { alertLink.dispatchEvent(alertNavigation); await Promise.resolve() })
    expect(alertNavigation.defaultPrevented).toBe(true)

    const tabLink = container.querySelector('nav[aria-label="已打开的库存与盘点页面"] a[href="/v2/supply-chain/inventory-management/purchase-in"]')!
    const tabNavigation = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { tabLink.dispatchEvent(tabNavigation); await Promise.resolve() })
    expect(tabNavigation.defaultPrevented).toBe(true)
    expect(mock.confirm).toHaveBeenCalledTimes(2)
  })

  it('全局侧边栏或底部导航会拦截未保存规则，取消保留且确认只跳转一次', async () => {
    await render()
    const cleanProceed = vi.fn()
    const cleanEvent = new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, { cancelable: true, detail: { proceed: cleanProceed } })
    expect(window.dispatchEvent(cleanEvent)).toBe(true)
    expect(cleanProceed).not.toHaveBeenCalled()

    const max = container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement
    await act(async () => setInput(max, '25'))
    const proceed = vi.fn()
    const first = new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, { cancelable: true, detail: { proceed } })
    await act(async () => { expect(window.dispatchEvent(first)).toBe(false) })
    expect(container.textContent).toContain('放弃未保存的库存规则？')
    const cancel = [...container.querySelectorAll('button')].find(button => button.textContent === '取消')!
    await act(async () => cancel.click())
    expect((container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement).value).toBe('25')
    expect(proceed).not.toHaveBeenCalled()

    const second = new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, { cancelable: true, detail: { proceed } })
    await act(async () => { expect(window.dispatchEvent(second)).toBe(false) })
    const leave = [...container.querySelectorAll('button')].find(button => button.textContent === '放弃并离开')!
    await act(async () => leave.click())
    expect(proceed).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('1 条未保存')
  })
})
