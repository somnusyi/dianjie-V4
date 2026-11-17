// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SearchableList, SearchableSelect } from './searchable-select'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML = '' })
function render(element: React.ReactNode) {
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container); act(() => root.render(element)); return container
}
const options = <><option value="">请选择</option><option value="a" data-search="SUP001">山禾食材</option><option value="b">SUP002 · 海川冻品</option><option value="c" disabled>SUP003 · 海川停用</option></>
function openSearch() { if (!container.querySelector('input[type=search]')) act(() => container.querySelector<HTMLButtonElement>('button[aria-expanded=false]')!.click()) }
function search(value: string) { openSearch(); act(() => Simulate.change(container.querySelector('input')!, { target: { value } } as any)) }

describe('searchable selection', () => {
  it('keeps nested search and choices visible under the legacy filter width-zero rule', () => {
    render(<label className="legacy-filter"><style>{'.legacy-filter input,.legacy-filter select{width:0;flex:1}'}</style><SearchableSelect searchLabel="搜索供应商" value="a" onChange={() => {}}>{options}</SearchableSelect></label>)
    openSearch()
    expect(getComputedStyle(container.querySelector('input')!).width).toBe('100%')
    expect(getComputedStyle(container.querySelector('select')!).width).toBe('100%')
  })
  it('keeps short lists compact and exposes search when an asynchronously loaded list becomes long', () => {
    render(<SearchableSelect searchWhenLong searchLabel="搜索仓库" value="" onChange={() => {}}>{options}</SearchableSelect>)
    expect(container.querySelector('input')).toBeNull()
    act(() => root.render(<SearchableSelect searchWhenLong searchLabel="搜索仓库" value="" onChange={() => {}}><option value="">请选择</option>{Array.from({ length: 12 }, (_, i) => <option key={i} value={i}>仓库 {i}</option>)}</SearchableSelect>))
    search('仓库 11')
    expect([...container.querySelectorAll('option')].map(x => x.value)).toEqual(['', '11'])
  })
  it('keeps checkbox selections when filtering and restoring a long list', () => {
    function Choices() {
      const [checked, setChecked] = React.useState<string[]>([])
      return <SearchableList searchLabel="搜索门店">{Array.from({ length: 12 }, (_, i) => <label key={i}><input type="checkbox" checked={checked.includes(String(i))} onChange={event => setChecked(event.target.checked ? [...checked, String(i)] : checked.filter(id => id !== String(i)))} />门店 {i}</label>)}</SearchableList>
    }
    render(<Choices />)
    act(() => Simulate.change(container.querySelector('input[type=checkbox]')!, { target: { checked: true } } as any))
    search('门店 11')
    expect(container.querySelectorAll('input[type=checkbox]')).toHaveLength(1)
    act(() => container.querySelector('button')!.click())
    expect(container.querySelectorAll('input[type=checkbox]')).toHaveLength(12)
    expect((container.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(true)
  })
  it('keeps the all-categories action without counting it as a search match', () => {
    render(<SearchableList searchLabel="搜索分类"><button data-search-pinned>全部分类</button>{Array.from({ length: 7 }, (_, i) => <button key={i}>分类 {i}</button>)}</SearchableList>)
    search('不存在')
    expect(container.querySelector('[role=status]')?.textContent).toContain('未找到匹配项')
    expect([...container.querySelectorAll('button')].map(x => x.textContent)).toContain('全部分类')
    search('分类 6')
    expect(container.querySelector('[role=status]')?.textContent).toContain('找到 1 项')
  })
  it('finds names and full-width codes, and typing never changes the selected company', () => {
    const change = vi.fn()
    render(<SearchableSelect searchLabel="搜索供应商" value="a" onChange={change}>{options}</SearchableSelect>)
    search('ＳＵＰ００２ 海川')
    expect([...container.querySelectorAll('option')].map(x => x.value)).toEqual(['', 'a', 'b'])
    expect(container.querySelector('select')!.value).toBe('a')
    expect(change).not.toHaveBeenCalled()
    expect(container.querySelector('[role=status]')?.textContent).toBe('找到 1 项')
  })
  it('retains the chosen value on no matches and clearing restores original choices and disabled rules', () => {
    render(<SearchableSelect searchLabel="搜索商品" value="b" onChange={() => {}}>{options}</SearchableSelect>)
    search('不存在')
    expect(container.querySelector('select')!.value).toBe('b')
    expect(container.querySelector('[role=status]')?.textContent).toContain('未找到匹配项')
    act(() => container.querySelector('button')!.click())
    expect(container.querySelectorAll('option')).toHaveLength(4)
    expect(container.querySelector('option[value=c]')?.hasAttribute('disabled')).toBe(true)
  })
  it('does not claim to retain a chosen item when only the empty placeholder is selected', () => {
    render(<SearchableSelect searchLabel="搜索商品" value="" onChange={() => {}}>{options}</SearchableSelect>)
    search('不存在')
    expect(container.querySelector('[role=status]')?.textContent).toBe('未找到匹配项')
    expect(container.querySelector('select')!.value).toBe('')
  })
  it('retains numeric zero as a real selected value when no search result matches', () => {
    render(<SearchableSelect searchLabel="搜索商品" value={0} onChange={() => {}}><option value="">请选择</option><option value={0}>白菜</option><option value={1}>土豆</option></SearchableSelect>)
    search('不存在')
    expect(container.querySelector('select')!.value).toBe('0')
    expect(container.querySelector('[role=status]')?.textContent).toContain('当前选择保留')
  })
  it('keeps required validation and disabled input; search Enter does not submit its parent form', () => {
    const submit = vi.fn(event => event.preventDefault())
    render(<form onSubmit={submit}><SearchableSelect searchLabel="搜索供应商" required value="" onChange={() => {}}>{options}</SearchableSelect></form>)
    expect(container.querySelector('select')!.checkValidity()).toBe(false)
    openSearch()
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => container.querySelector('input')!.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(submit).not.toHaveBeenCalled()
    act(() => root.render(<SearchableSelect searchLabel="搜索供应商" disabled value="a" onChange={() => {}}>{options}</SearchableSelect>))
    expect(container.querySelector('button')!.disabled).toBe(true)
    expect(container.querySelector('input')).toBeNull()
    expect(container.querySelector('select')!.disabled).toBe(true)
  })
  it('keeps the native select, styling and form value without a permanent second search row', () => {
    render(<form><SearchableSelect searchLabel="搜索供应商" className="original-select" name="supplierId" required value="a" onChange={() => {}}>{options}</SearchableSelect></form>)
    expect(container.querySelector('input[type=search]')).toBeNull()
    expect(container.querySelector('select')!.className).toBe('original-select')
    expect(new FormData(container.querySelector('form')!).get('supplierId')).toBe('a')
    search('海川')
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => container.querySelector('input')!.dispatchEvent(escape))
    expect(container.querySelector('input[type=search]')).toBeNull()
    expect(container.querySelectorAll('option')).toHaveLength(4)
    expect(container.querySelector('select')!.value).toBe('a')
    expect(document.activeElement).toBe(container.querySelector('button'))
  })
  it('clears search after selection and closing so hidden filters cannot carry over', () => {
    const change = vi.fn()
    render(<SearchableSelect searchLabel="搜索供应商" value="" onChange={change}>{options}</SearchableSelect>)
    search('SUP002')
    act(() => Simulate.change(container.querySelector('select')!, { target: { value: 'b' } } as any))
    expect(change).toHaveBeenCalledTimes(1)
    expect(container.querySelector('input[type=search]')).toBeNull()
    expect(container.querySelectorAll('option')).toHaveLength(4)
    search('不存在')
    act(() => container.querySelector<HTMLButtonElement>('button[aria-expanded=true]')!.click())
    expect(container.querySelectorAll('option')).toHaveLength(4)
  })
  it('searches optgroup children while retaining the original change event and value', () => {
    const change = vi.fn()
    render(<SearchableSelect searchLabel="搜索商品" value="" onChange={change}><option value="">请选择</option><optgroup label="蔬菜"><option value="p">土豆 P01</option></optgroup><optgroup label="冻品"><option value="q">鱼丸 Q01</option></optgroup></SearchableSelect>)
    search('蔬菜 P01')
    expect([...container.querySelectorAll('option')].map(x => x.value)).toEqual(['', 'p'])
    act(() => Simulate.change(container.querySelector('select')!, { target: { value: 'p' } } as any))
    expect(change).toHaveBeenCalledTimes(1)
    expect(change.mock.calls[0][0].target.value).toBe('p')
  })
})
