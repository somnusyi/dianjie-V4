// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Page from './page'
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn(), getUser: () => ({ id: 'user-1', role: 'SUPPLY_CHAIN' }) }))
import { apiFetch } from '@/lib/v2-auth'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const fetch = vi.mocked(apiFetch)
let count: any
beforeEach(() => {
  window.history.replaceState({}, '', '/?doc=count-1')
  count = { id: 'count-1', no: 'WSC-01', status: 'COUNTING', warehouse: { id: 'wh', name: '总仓' }, countedCount: 0, itemCount: 2, totalDifferenceValue: '0', adjustments: [], partitions: [
    { id: 'part-1', name: '冷库', assignedToId: 'user-1', savedAt: null, version: 0, lines: [{ id: 'line-1', productName: '土豆', productCode: 'P1', inventoryUnit: 'kg', bookQuantity: '10', unitCost: '2', countedQuantity: null, differenceQuantity: null, differenceAmount: null, reason: null }] },
    { id: 'part-2', name: '干货', assignedToId: 'user-2', savedAt: null, version: 0, lines: [{ id: 'line-2', productName: '大米', productCode: 'P2', inventoryUnit: 'kg', bookQuantity: '10', unitCost: '3', countedQuantity: null, differenceQuantity: null, differenceAmount: null, reason: null }] },
  ] }
  fetch.mockReset()
  fetch.mockImplementation(async (path, init) => {
    if (path === '/api/warehouse-stocktakes/options') return { warehouses: [{ id: 'wh', name: '总仓' }], users: [{ id: 'user-1', name: '员工一' }, { id: 'user-2', name: '员工二' }], products: [{ id: 'product-1', code: 'P1', name: '土豆', inventoryUnit: 'kg', unit: 'kg' }] }
    if (path === '/api/warehouse-stocktakes' && init?.method === 'POST') return { id: 'count-1' }
    if (path === '/api/warehouse-stocktakes') return [count]
    if (path === '/api/warehouse-stocktakes/count-1') return count
    if (String(path).endsWith('/partitions/part-1')) { count = { ...count, countedCount: 1 }; return { id: 'count-1' } }
    if (String(path).endsWith('/approve')) { count = { ...count, status: 'CONFIRMED', adjustments: [{ id: 'adjust-1', no: 'WSC-01-PY', kind: 'PROFIT', amount: '4' }] }; return { id: 'count-1' } }
    throw new Error(`unexpected ${path}`)
  })
})
async function render() {
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container)
  await act(async () => root.render(<Page />))
  return { container, close: () => { act(() => root.unmount()); container.remove() } }
}
async function click(container: HTMLElement, text: string) { await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent === text)?.click()) }
describe('总仓盘点作业', () => {
  it('只能录入自己的分区，保存携带分区版本和实盘值', async () => {
    const { container, close } = await render()
    const own = container.querySelector('[aria-label="土豆实盘数量"]') as HTMLInputElement
    expect(own.disabled).toBe(false)
    expect((container.querySelector('[aria-label="大米实盘数量"]') as HTMLInputElement).disabled).toBe(true)
    act(() => Simulate.change(own, { target: { value: '12' } } as any))
    await click(container, '保存我的分区')
    const saved = fetch.mock.calls.find(([path, init]) => String(path).endsWith('/partitions/part-1') && init?.method === 'PUT')
    expect(JSON.parse(String(saved?.[1]?.body))).toMatchObject({ version: 0, lines: [{ id: 'line-1', quantity: '12', unitCost: '2' }] })
    expect(container.textContent).toContain('冷库已保存')
    close()
  })
  it('审核需要确认，成功后直达盘盈单，并复用复盘打印入口', async () => {
    count.status = 'REVIEWING'
    const { container, close } = await render()
    expect(container.querySelector('a[href*="source=warehouse"]')).not.toBeNull()
    await click(container, '审核并生成盘盈盘亏')
    expect(fetch.mock.calls.some(([path]) => String(path).endsWith('/approve'))).toBe(false)
    await click(container, '确认')
    expect(container.textContent).toContain('WSC-01-PY')
    expect(container.querySelector('a[href="/v2/supply-chain/stocktake/profit"]')).not.toBeNull()
    close()
  })
})
