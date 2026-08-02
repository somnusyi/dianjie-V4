// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SupplyChainShell } from './supply-chain-shell'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const navigation = vi.hoisted(() => ({
  pathname: '/v2/supply-chain/home',
  push: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push }),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>{children}</a>
  ),
}))

vi.mock('@/components/v2', () => ({
  BottomNav: ({ tabs, activeKey, onChange }: {
    tabs: Array<{ key: string; label: string; icon?: React.ReactNode }>
    activeKey: string
    onChange: (key: string) => void
  }) => (
    <nav data-bottom-nav="true" data-active-key={activeKey}>
      {tabs.map(tab => (
        <button key={tab.key} data-nav-key={tab.key} onClick={() => onChange(tab.key)}>
          {tab.label}
        </button>
      ))}
    </nav>
  ),
}))

function renderShell(pathname: string) {
  navigation.pathname = pathname
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<SupplyChainShell><div data-page="true" /></SupplyChainShell>))
  return {
    container,
    cleanup: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

describe('SupplyChainShell 移动端导航', () => {
  beforeEach(() => navigation.push.mockReset())

  it.each([
    ['/v2/supply-chain/home', 'home'],
    ['/v2/supply-chain/fulfillment/order-1', 'orders'],
    ['/v2/supply-chain/orders', 'orders'],
    ['/v2/supply-chain/inventory/item-1', 'inventory'],
    ['/v2/supply-chain/products', 'inventory'],
    ['/v2/supply-chain/differences', 'more'],
    ['/v2/supply-chain/stores/store-1', 'more'],
  ])('在 %s 高亮 %s', (pathname, expectedKey) => {
    const { container, cleanup } = renderShell(pathname)

    const navs = container.querySelectorAll('[data-bottom-nav="true"]')
    expect(navs).toHaveLength(1)
    expect(navs[0].getAttribute('data-active-key')).toBe(expectedKey)
    expect(navs[0].querySelectorAll('button')).toHaveLength(4)

    cleanup()
  })

  it('点击订单 Tab 使用 Next 路由跳转', () => {
    const { container, cleanup } = renderShell('/v2/supply-chain/home')

    const orders = container.querySelector('[data-nav-key="orders"]') as HTMLButtonElement
    act(() => orders.click())

    expect(navigation.push).toHaveBeenCalledWith('/v2/supply-chain/fulfillment')
    cleanup()
  })

  it('仅在移动端显示底栏，并保留桌面侧栏偏移', () => {
    const { container, cleanup } = renderShell('/v2/supply-chain/home')

    expect(container.querySelector('[data-bottom-nav="true"]')?.parentElement?.className).toContain('lg:hidden')
    expect(container.querySelector('main')?.className).toContain('lg:pl-64')
    expect(container.querySelector('aside')?.className).toContain('lg:flex')

    cleanup()
  })
})
