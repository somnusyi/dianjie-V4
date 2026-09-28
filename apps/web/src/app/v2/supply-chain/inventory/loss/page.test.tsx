// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WarehouseSelfLossPage from './page'
import { SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT } from '@/components/v2/supply-chain-shell'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const mock = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: mock.api }))
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a> }))
vi.mock('@/components/v2/warehouse-tool-tabs', () => ({ WarehouseToolTabs: () => <nav>warehouse tools</nav> }))

const product = { id: 'p1', code: 'P001', name: '土豆', spec: '1kg', inventoryUnit: 'kg', physicalQty: 12, availableQty: 10 }
let root: ReturnType<typeof createRoot> | null = null
let container: HTMLDivElement

async function renderPage(overrides: { upload?: Promise<any>; batch?: Promise<any> } = {}) {
  mock.api.mockImplementation((url: string) => {
    if (url.startsWith('/api/warehouse-inventory?')) return Promise.resolve({ items: [product] })
    if (url === '/api/upload?category=warehouse-docs') return overrides.upload || Promise.resolve({ key: 'evidence/a.jpg', name: 'a.jpg', mime: 'image/jpeg', size: 3, url: '/a.jpg' })
    if (url === '/api/warehouse-inventory/batch-self-loss') return overrides.batch || Promise.resolve({ replayed: false, count: 1, totalAmount: 5, doc: { id: 'd1', docNo: 'BS-001' } })
    throw new Error(`unexpected ${url}`)
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root!.render(<WarehouseSelfLossPage />); await Promise.resolve() })
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  mock.api.mockReset()
  vi.restoreAllMocks()
})

function setValue(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('总仓自损页面未提交保护', () => {
  it('拦截浏览器和全局导航，取消保留草稿，确认只跳转一次', async () => {
    await renderPage()
    const responsibility = container.querySelector('input[placeholder*="仓储环节"]') as HTMLInputElement
    await act(async () => setValue(responsibility, '搬运环节'))

    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)

    const proceed = vi.fn()
    const first = new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, { cancelable: true, detail: { proceed } })
    await act(async () => { expect(window.dispatchEvent(first)).toBe(false) })
    expect(container.textContent).toContain('放弃未提交的总仓自损单？')
    const cancel = [...container.querySelectorAll('button')].find(button => button.textContent === '取消')!
    await act(async () => cancel.click())
    expect(responsibility.value).toBe('搬运环节')
    expect(proceed).not.toHaveBeenCalled()

    const second = new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, { cancelable: true, detail: { proceed } })
    await act(async () => { expect(window.dispatchEvent(second)).toBe(false) })
    const leave = [...container.querySelectorAll('button')].find(button => button.textContent === '放弃并离开')!
    await act(async () => leave.click())
    expect(proceed).toHaveBeenCalledTimes(1)
  })

  it('成功提交后恢复为干净页面，不再拦截导航', async () => {
    let resolveBatch!: (value: any) => void
    const batch = new Promise(resolve => { resolveBatch = resolve })
    await renderPage({ batch })
    const reason = container.querySelector('select') as HTMLSelectElement
    const responsibility = container.querySelector('input[placeholder*="仓储环节"]') as HTMLInputElement
    const search = container.querySelector('input[placeholder*="物品编码"]') as HTMLInputElement
    await act(async () => { setValue(reason, '盘亏损毁'); setValue(responsibility, '搬运环节'); setValue(search, '土豆') })
    const add = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('P001 · 土豆'))!
    await act(async () => add.click())
    const quantity = container.querySelector('input[aria-label="土豆自损数量"]') as HTMLInputElement
    await act(async () => setValue(quantity, '1'))

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [new File(['abc'], 'a.jpg', { type: 'image/jpeg' })] })
    await act(async () => { fileInput.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve(); await Promise.resolve() })
    expect(container.textContent).toContain('a.jpg')

    const request = [...container.querySelectorAll('button')].find(button => button.textContent === '审核后提交自损')!
    await act(async () => request.click())
    const confirm = [...container.querySelectorAll('button')].find(button => button.textContent === '确认扣库并生成自损单')!
    await act(async () => { confirm.click(); await Promise.resolve() })
    const blockedProceed = vi.fn()
    const blocked = new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, { cancelable: true, detail: { proceed: blockedProceed } })
    await act(async () => { expect(window.dispatchEvent(blocked)).toBe(false) })
    expect(blockedProceed).not.toHaveBeenCalled()
    expect(container.textContent).toContain('自损单正在提交入账')
    await act(async () => {
      resolveBatch({ replayed: false, count: 1, totalAmount: 5, doc: { id: 'd1', docNo: 'BS-001' } })
      await batch
      await Promise.resolve()
    })
    expect(container.textContent).toContain('自损单 BS-001 已入账')

    const proceed = vi.fn()
    const event = new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, { cancelable: true, detail: { proceed } })
    expect(window.dispatchEvent(event)).toBe(true)
    expect(proceed).not.toHaveBeenCalled()
  })

  it('现场证据上传中禁止离开并给出明确反馈', async () => {
    let resolveUpload!: (value: any) => void
    const upload = new Promise(resolve => { resolveUpload = resolve })
    await renderPage({ upload })
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [new File(['abc'], 'a.jpg', { type: 'image/jpeg' })] })
    await act(async () => { fileInput.dispatchEvent(new Event('change', { bubbles: true })); await Promise.resolve() })
    const proceed = vi.fn()
    const event = new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, { cancelable: true, detail: { proceed } })
    await act(async () => { expect(window.dispatchEvent(event)).toBe(false) })
    expect(proceed).not.toHaveBeenCalled()
    expect(container.textContent).toContain('现场证据正在上传')
    await act(async () => {
      resolveUpload({ key: 'evidence/a.jpg', name: 'a.jpg', mime: 'image/jpeg', size: 3, url: '/a.jpg' })
      await upload
      await Promise.resolve()
    })
  })
})
