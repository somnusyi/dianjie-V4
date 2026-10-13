// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import Page from './page'
import { apiFetch } from '@/lib/v2-auth'
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn() }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const mock = vi.mocked(apiFetch)
let root: ReturnType<typeof createRoot> | undefined
const old = { company: '公司A', name: '旧人员', phone: '13970000998' }
afterEach(() => { if (root) act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.resetAllMocks() })
async function setup() {
  mock.mockImplementation(async path => path.startsWith('/api/upstream/supplier-accounts/history') ? { items: [old], hasMore: false } : [{ id: 'company-a', no: 'A', name: '公司A', status: 'ENABLED' }, { id: 'disabled', no: 'C', name: '停用公司', status: 'DISABLED' }] as any)
  const c = document.createElement('div'); document.body.append(c); root = createRoot(c)
  await act(async () => root!.render(<Page />))
  act(() => {
    Simulate.change(c.querySelector('select')!, { target: { value: 'company-a' } } as any)
    const inputs = c.querySelectorAll('input')
    for (const [i, value] of ['张先生', '13970000999', 'test-password'].entries()) Simulate.change(inputs[i], { target: { value } } as any)
  })
  return c
}
it('directly adds the selected company account and renders only the three history fields', async () => {
  const c = await setup(); expect(c.textContent).not.toContain('停用公司')
  mock.mockImplementation(async (path, options) => options?.method === 'POST' ? { company: '公司A', name: '张先生', phone: '13970000999' } : { items: [old, { company: '公司A', name: '张先生', phone: '13970000999' }], hasMore: false } as any)
  await act(async () => Simulate.submit(c.querySelector('form')!))
  expect(mock).toHaveBeenCalledWith('/api/upstream/suppliers/company-a/accounts', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: '张先生', phone: '13970000999', password: 'test-password' }) }))
  expect([...c.querySelectorAll('th')].map(x => x.textContent)).toEqual(['公司', '姓名', '手机号'])
  expect(c.querySelector('table')?.textContent).toContain('张先生')
  expect(c.querySelector('table')?.textContent).not.toContain('test-password')
  expect((c.querySelector('input[type=password]') as HTMLInputElement).value).toBe('')
})
it('locks repeat submission and retains input after failure without creating a success record', async () => {
  const c = await setup(); let fail!: (x: any) => void
  mock.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
  act(() => { Simulate.submit(c.querySelector('form')!); Simulate.submit(c.querySelector('form')!) })
  expect(mock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
  await act(async () => fail(new Error('该手机号已有账号')))
  expect(c.querySelector('[role=alert]')?.textContent).toContain('已有账号')
  expect(c.querySelector('[role=status]')).toBeNull()
  expect((c.querySelector('input[type=tel]') as HTMLInputElement).value).toBe('13970000999')
  expect(c.querySelector('table')?.textContent).not.toContain('张先生')
})

it('ignores an older history response after successful creation', async () => {
  const c = await setup(); let oldResult!: (x: any) => void
  mock.mockImplementationOnce(() => new Promise(resolve => { oldResult = resolve }))
  act(() => [...c.querySelectorAll('button')].find(b => b.textContent === '刷新历史')!.click())
  mock.mockImplementation(async (path, options) => options?.method === 'POST' ? { company: '公司A', name: '新人员', phone: '13970000999' } : { items: [{ company: '公司A', name: '新人员', phone: '13970000999' }], hasMore: true } as any)
  await act(async () => Simulate.submit(c.querySelector('form')!))
  await act(async () => oldResult({ items: [old], hasMore: false }))
  expect(c.querySelector('table')?.textContent).toContain('新人员')
  expect(c.querySelector('table')?.textContent).not.toContain('旧人员')
  expect([...c.querySelectorAll('button')].find(b => b.textContent === '下一页')?.disabled).toBe(false)
})
