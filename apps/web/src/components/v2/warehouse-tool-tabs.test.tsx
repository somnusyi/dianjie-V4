// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { WarehouseToolTabs } from './warehouse-tool-tabs'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({ usePathname: () => '/v2/supply-chain/inventory' }))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}))

function renderTabs() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<WarehouseToolTabs />))
  return { container, root }
}

describe('库存与单据页面切换', () => {
  it('只显示三个固定标签，链接不携带关联商品参数', () => {
    const { container, root } = renderTabs()
    const links = Array.from(container.querySelectorAll('a'))

    expect(links.map(link => link.textContent)).toEqual(['库存查询', '入库记录', '单据审核'])
    expect(links.map(link => link.getAttribute('href'))).toEqual([
      '/v2/supply-chain/inventory',
      '/v2/supply-chain/inbound',
      '/v2/supply-chain/docs',
    ])
    expect(links[0].getAttribute('aria-current')).toBe('page')
    expect(container.textContent).not.toContain('关联查看')
    expect(container.querySelector('[role="switch"]')).toBeNull()
    act(() => root.unmount())
    container.remove()
  })
})
