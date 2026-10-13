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
  default: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(({ href, children, ...props }, ref) => (
    <a ref={ref} href={String(href)} {...props}>{children}</a>
  )),
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
    ['/v2/supply-chain/inventory-management/purchase-in', 'inventory'],
    ['/v2/supply-chain/stocktake/count', 'inventory'],
    ['/v2/supply-chain/products', 'inventory'],
    ['/v2/supply-chain/differences', 'more'],
    ['/v2/supply-chain/stores/store-1', 'more'],
    ['/v2/supply-chain/navigation', 'more'],
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

  it('默认电脑版，仅按钮切换侧栏底栏，resize不切换且不销毁业务内容', () => {
    const { container, cleanup } = renderShell('/v2/supply-chain/home')
    const shell = container.querySelector('[data-navigation-mode]')!
    const page = container.querySelector('[data-page]')!
    const toggle = container.querySelector('button[aria-label="切换到手机版"]') as HTMLButtonElement
    expect(shell.getAttribute('data-navigation-mode')).toBe('desktop')
    expect(container.querySelector('aside')?.className).toContain('flex')
    expect(container.querySelector('main')?.className).toContain('pl-64')
    expect(container.querySelector('[data-bottom-nav]')?.parentElement?.className).toBe('hidden')
    act(() => window.dispatchEvent(new Event('resize')))
    expect(shell.getAttribute('data-navigation-mode')).toBe('desktop')
    act(() => toggle.click())
    expect(shell.getAttribute('data-navigation-mode')).toBe('mobile')
    expect(container.querySelector('aside')).toBeNull()
    expect(container.querySelector('main')?.className).not.toContain('pl-64')
    expect(container.querySelector('[data-bottom-nav]')?.parentElement?.className).toBe('block')
    expect(container.querySelector('main')?.className).toContain('pb-24')
    act(() => window.dispatchEvent(new Event('resize')))
    expect(shell.getAttribute('data-navigation-mode')).toBe('mobile')
    expect(container.querySelector('[data-page]')).toBe(page)
    act(() => toggle.click())
    expect(shell.getAttribute('data-navigation-mode')).toBe('desktop')
    cleanup()
  })

  it('普通内部a也使用Next跳转，外开及下载保留浏览器行为', () => {
    const {container, cleanup} = renderShell('/v2/supply-chain/inventory')
    const anchor = container.querySelector('a[href="/v2/supply-chain/stocktake/count"]') as HTMLAnchorElement || container.querySelector('a[href="/v2/supply-chain/home"]') as HTMLAnchorElement
    const href = anchor.getAttribute('href')!
    const event = new MouseEvent('click', {bubbles:true,cancelable:true})
    act(() => anchor.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(navigation.push).toHaveBeenCalledWith(href)
    navigation.push.mockClear()
    anchor.target = '_blank'
    act(() => anchor.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})))
    expect(navigation.push).not.toHaveBeenCalled()
    anchor.target = ''; anchor.setAttribute('download','test.txt')
    act(() => anchor.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})))
    expect(navigation.push).not.toHaveBeenCalled()
    cleanup()
  })

  it('恢复原固定功能入口与未保存离开拦截，更多仍打开全部功能', () => {
    const { container, cleanup } = renderShell('/v2/supply-chain/deliveries/delivery-1')
    const quickNav = container.querySelector('nav[aria-label="页面快捷入口"]')!
    const directory = quickNav.querySelector('a[href="/v2/supply-chain/navigation"]') as HTMLAnchorElement
    expect(quickNav.querySelectorAll('a')).toHaveLength(1)
    expect(quickNav.querySelector('a[href="/v2/supply-chain/inventory/loss"]')).toBeNull()
    const preventLeave = (event: Event) => event.preventDefault()
    window.addEventListener('dianjie:supply-chain-before-navigate', preventLeave)
    try {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      act(() => directory.dispatchEvent(click))
      expect(click.defaultPrevented).toBe(true)
      act(() => (container.querySelector('[data-nav-key="more"]') as HTMLButtonElement).click())
      expect(navigation.push).not.toHaveBeenCalled()
    } finally { window.removeEventListener('dianjie:supply-chain-before-navigate', preventLeave) }
    act(() => (container.querySelector('[data-nav-key="more"]') as HTMLButtonElement).click())
    expect(navigation.push).toHaveBeenCalledWith('/v2/supply-chain/navigation')
    cleanup()
  })

})


describe('库存报表悬浮导航', () => {
  it('移入展开，经过浮层取消关闭，移出后关闭；保留业务导航', () => {
    vi.useFakeTimers()
    const { container, cleanup } = renderShell('/v2/supply-chain/reports')
    try {
      const trigger = container.querySelector('button[aria-controls="inventory-report-flyout"]')!
      act(() => trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      const navigationCalls = navigation.push.mock.calls.length
      act(() => (trigger as HTMLButtonElement).click())
      expect(navigation.push).toHaveBeenCalledTimes(navigationCalls)
      const panel = document.querySelector('#inventory-report-flyout')!
      expect(panel.querySelectorAll('a')).toHaveLength(12)
      expect([...panel.querySelectorAll('a')].slice(0, 9).map(a => a.textContent)).toEqual(['库存管理与验收', '实时库存查询表', '出入库明细表', '出入库汇总表', '其他出入库汇总表', '机构间调拨明细表', '机构间调拨汇总表', '库存呆滞品查询表', '库存预警表'])
      expect(trigger.textContent).toContain('库存报表')
      const mainItems = panel.querySelector('.grid-cols-2')!
      expect(mainItems.querySelector('a[href="/v2/supply-chain/inventory"]')?.textContent).toBe('库存管理与验收')
      expect(mainItems.querySelectorAll('a')).toHaveLength(9)
      expect(panel.querySelector('a[href="/v2/supply-chain/inventory/loss"]')?.textContent).toBe('总仓自损')
      act(() => trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
      act(() => panel.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
      act(() => vi.advanceTimersByTime(200))
      expect(document.querySelector('#inventory-report-flyout')).not.toBeNull()
      act(() => panel.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
      act(() => vi.advanceTimersByTime(150))
      expect(document.querySelector('#inventory-report-flyout')).toBeNull()
      expect(container.querySelector('a[href="/v2/supply-chain/home"]')).not.toBeNull()
      expect(container.querySelector('a[href="/v2/supply-chain/fulfillment"]')).not.toBeNull()
    } finally { cleanup(); vi.useRealTimers() }
  })
})
