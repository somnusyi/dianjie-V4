// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SupplierShell } from './supplier-shell'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const route = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/v2/supplier/upstream', useRouter: () => route }))
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a> }))
vi.mock('@/lib/v2-auth', () => ({ getUser: () => ({ supplier: { businessScopes: ['WAREHOUSE_UPSTREAM'] } }) }))
it('defaults to desktop and changes navigation only on explicit toggle without losing page input', () => {
 const element = document.createElement('div'); document.body.append(element); const root = createRoot(element)
 try {
  act(() => root.render(<SupplierShell><input aria-label="草稿内容" defaultValue="保留本批数量" /></SupplierShell>))
  const shell = element.querySelector('[data-navigation-mode]')!
  const field = element.querySelector('input')!
  expect(shell.getAttribute('data-navigation-mode')).toBe('desktop')
  expect(element.querySelector('aside')).not.toBeNull()
  act(() => window.dispatchEvent(new Event('resize')))
  expect(shell.getAttribute('data-navigation-mode')).toBe('desktop')
  act(() => (element.querySelector('button[aria-label="切换到手机版"]') as HTMLButtonElement).click())
  expect(shell.getAttribute('data-navigation-mode')).toBe('mobile')
  expect(element.querySelector('aside')).toBeNull()
  expect(element.querySelector('[aria-label="打开供应商菜单"]')).toBeNull()
  const bottom = element.querySelector('[data-bottom-nav="true"]')!
  expect(bottom.querySelectorAll('button')).toHaveLength(5)
  expect(bottom.textContent).toContain('工作台')
  expect(bottom.textContent).toContain('采购单')
  act(() => (bottom.querySelector('button') as HTMLButtonElement).click())
  expect(route.push).toHaveBeenCalledWith('/v2/supplier/home')
  act(() => window.dispatchEvent(new Event('resize')))
  expect(shell.getAttribute('data-navigation-mode')).toBe('mobile')
  act(() => (element.querySelector('button[aria-label="切换到电脑版"]') as HTMLButtonElement).click())
  expect(shell.getAttribute('data-navigation-mode')).toBe('desktop')
  expect(element.querySelector('[data-bottom-nav="true"]')).toBeNull()
  expect(element.querySelector('input')).toBe(field)
  expect(field.value).toBe('保留本批数量')
 } finally { act(() => root.unmount()); element.remove() }
})
