// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UserMenu } from './user-menu'

const auth = vi.hoisted(() => ({ role: 'FINANCE', clear: vi.fn() }))
vi.mock('@/lib/v2-auth', () => ({
  getUser: () => ({ name: '财务员', email: 'finance@example.test', role: auth.role }),
  clearSession: auth.clear,
}))
vi.mock('./notification-bell', () => ({ NotificationBell: () => null }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('只给财务角色显示总仓盘点审核入口', async () => {
  await act(async () => root.render(<UserMenu />))
  act(() => (container.querySelector('button') as HTMLButtonElement).click())
  expect(container.querySelector('a[href="/v2/supply-chain/stocktake/work"]')?.textContent).toBe('总仓盘点审核')

  auth.role = 'SUPPLIER_OWNER'
  await act(async () => root.render(<UserMenu key="supplier" />))
  act(() => (container.querySelector('button') as HTMLButtonElement).click())
  expect(container.querySelector('a[href="/v2/supply-chain/stocktake/work"]')).toBeNull()
})
