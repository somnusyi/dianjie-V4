// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { expect, it, vi } from 'vitest'
import LoginPage from './page'

const mocks = vi.hoisted(() => ({ replace: vi.fn(), post: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }))
vi.mock('@/lib/api', () => ({ default: { post: mocks.post } }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

it('旧登录同步v2会话并按角色进入真实落地页，清除上次活动门店', async () => {
  localStorage.clear()
  localStorage.setItem('activeStoreId', 'previous-store')
  mocks.post.mockResolvedValue({ data: { token: 'new-token', refreshToken: 'new-refresh', user: { id: 'u1', name: '供应链', role: 'SUPPLY_CHAIN' }, tenant: { id: 't1' } } })
  const el = document.createElement('div')
  const root = createRoot(el)
  act(() => root.render(<LoginPage />))
  const inputs = el.querySelectorAll('input')
  act(() => {
    Simulate.change(inputs[0], { target: { value: 'user@example.test' } } as any)
    Simulate.change(inputs[1], { target: { value: 'example' } } as any)
  })
  await act(async () => el.querySelector('button')!.click())
  expect(mocks.replace).toHaveBeenCalledWith('/v2/supply-chain/home')
  expect(localStorage.getItem('token')).toBe('new-token')
  expect(localStorage.getItem('dj_token')).toBe('new-token')
  expect(localStorage.getItem('refreshToken')).toBe('new-refresh')
  expect(localStorage.getItem('activeStoreId')).toBeNull()
  act(() => root.unmount())
  localStorage.clear()
})
