// @vitest-environment jsdom
import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { ResponsiveDataTable } from './responsive-data-table'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { vi.unstubAllGlobals() })

it('手机卡片保留字段、操作、汇总及受控输入，切回桌面不丢值也不重复表单', () => {
  const media = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  vi.stubGlobal('matchMedia', () => media)
  const remove = vi.fn()
  function Example() {
    const [qty, setQty] = useState('1')
    return <ResponsiveDataTable><table><thead><tr><th>商品</th><th>数量</th><th>操作</th></tr></thead><tbody><tr><td>牛肝菌</td><td><input aria-label="采购数量" value={qty} onChange={event => setQty(event.target.value)} /></td><td><button onClick={remove}>移除</button></td></tr></tbody><tfoot><tr><td colSpan={2}>合计</td><td>¥100</td></tr></tfoot></table></ResponsiveDataTable>
  }
  const el = document.createElement('div'); document.body.appendChild(el); const root = createRoot(el)
  act(() => root.render(<Example />))
  expect(el.querySelector('table')).toBeNull(); expect(el.querySelectorAll('input')).toHaveLength(1); expect(el.textContent).toContain('牛肝菌'); expect(el.textContent).toContain('¥100')
  act(() => Simulate.change(el.querySelector('input')!, { target: { value: '7.5' } } as any))
  act(() => el.querySelector('button')!.click()); expect(remove).toHaveBeenCalledOnce()
  media.matches = false; act(() => media.addEventListener.mock.calls[0][1]())
  expect(el.querySelector('table')).not.toBeNull(); expect(el.querySelectorAll('input')).toHaveLength(1); expect(el.querySelector('input')!.value).toBe('7.5')
  act(() => root.unmount()); el.remove(); expect(media.removeEventListener).toHaveBeenCalledOnce()
})

it('复盘打印强制保留表格，即使当前手机视口也不生成卡片', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  const el = document.createElement('div'); const root = createRoot(el)
  act(() => root.render(<ResponsiveDataTable desktopOnly><table><tbody><tr><td>打印行</td></tr></tbody></table></ResponsiveDataTable>))
  expect(el.querySelector('table')).not.toBeNull(); expect(el.querySelector('[data-mobile-cards]')).toBeNull(); act(() => root.unmount())
})
