// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { internalProductDefaultFilters, useSupplyProductFilters } from './use-supply-product-filters'
const identity = vi.hoisted(() => ({ user: { id: 'a', tenantId: 'one' } }))
vi.mock('./v2-auth', () => ({ getUser: () => identity.user }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let current: ReturnType<typeof useSupplyProductFilters>
function Probe() { current = useSupplyProductFilters(); return <output>{JSON.stringify(current[0])}</output> }
function mount() { const c = document.createElement('div'); document.body.append(c); root = createRoot(c); act(() => root!.render(<Probe />)) }
function unmount() { act(() => root?.unmount()); root = undefined }
beforeEach(() => { sessionStorage.clear(); identity.user = { id: 'a', tenantId: 'one' } })
afterEach(() => { unmount(); document.body.innerHTML = ''; vi.restoreAllMocks() })
it('restores combined filters and pagination after leaving and remounting', () => {
  mount(); act(() => current[1]({ q: '松茸', category: '野生菌', status: 'DISABLED', supplierId: 'supplier-a', page: 3, pageSize: 50 }))
  unmount(); mount()
  expect(current[2]).toBe(true)
  expect(current[0]).toEqual({ q: '松茸', category: '野生菌', status: 'DISABLED', supplierId: 'supplier-a', page: 3, pageSize: 50 })
})
it('clearing filters persists the original defaults rather than recovering an older search', () => {
  mount(); act(() => current[1](v => ({ ...v, q: '松茸' })))
  act(() => current[1](internalProductDefaultFilters())); unmount(); mount()
  expect(current[0]).toEqual(internalProductDefaultFilters())
})
it('separates accounts and tenants and rejects a previous account setter', () => {
  mount(); act(() => current[1](v => ({ ...v, q: '账号A' }))); const stale = current[1]
  identity.user = { id: 'b', tenantId: 'one' }; act(() => root!.render(<Probe />))
  expect(current[0].q).toBe('')
  act(() => stale(v => ({ ...v, q: '旧回调' })))
  expect(current[0].q).toBe('')
  identity.user = { id: 'a', tenantId: 'two' }; act(() => root!.render(<Probe />))
  expect(current[0].q).toBe('')
  identity.user = { id: 'a', tenantId: 'one' }; act(() => root!.render(<Probe />))
  expect(current[0].q).toBe('账号A')
})
it('ignores corrupt and invalid stored filter fields', () => {
  sessionStorage.setItem('dj:supply-product-filters:v1:one:a', '{broken'); mount()
  expect(current[0]).toEqual(internalProductDefaultFilters()); unmount()
  sessionStorage.setItem('dj:supply-product-filters:v1:one:a', JSON.stringify({ q: {}, category: [], status: 'BAD', page: -2, pageSize: 999999 }))
  mount(); expect(current[0]).toEqual(internalProductDefaultFilters())
})
it('continues filtering if browser storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
  mount(); act(() => current[1](v => ({ ...v, q: '土豆' })))
  expect(current[0].q).toBe('土豆')
})
