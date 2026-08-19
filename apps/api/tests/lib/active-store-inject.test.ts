import { describe, expect, it } from 'vitest'
import { activeStoreInjectHook } from '../../src/lib/active-store-inject'

function fakeRequest(url: string, headers: Record<string, string> = {}, query: Record<string, unknown> = {}) {
  return { url, headers, query } as any
}

describe('active store inject hook', () => {
  it('injects storeId into query for routes that declare storeId support', () => {
    const request = fakeRequest('/api/orders?status=SUBMITTED', { 'x-active-store': 'store-1' })
    activeStoreInjectHook(request)
    expect(request.query.storeId).toBe('store-1')
  })

  it('injects for sub-paths of allowlisted prefixes', () => {
    const request = fakeRequest('/api/inventory-counts/sessions', { 'x-active-store': 'store-1' })
    activeStoreInjectHook(request)
    expect(request.query.storeId).toBe('store-1')
  })

  it('never injects into strict-schema routes like suppliers/products (2026-08-19 regression)', () => {
    for (const url of ['/api/suppliers', '/api/suppliers?status=ENABLED', '/api/products', '/api/payments', '/api/notifications']) {
      const request = fakeRequest(url, { 'x-active-store': 'store-1' })
      activeStoreInjectHook(request)
      expect(request.query.storeId, url).toBeUndefined()
    }
  })

  it('does not override an explicit storeId', () => {
    const request = fakeRequest('/api/orders', { 'x-active-store': 'store-1' }, { storeId: 'store-2' })
    activeStoreInjectHook(request)
    expect(request.query.storeId).toBe('store-2')
  })

  it('ignores auth endpoints and missing headers', () => {
    const authReq = fakeRequest('/api/auth/login', { 'x-active-store': 'store-1' })
    activeStoreInjectHook(authReq)
    expect(authReq.query.storeId).toBeUndefined()

    const noHeader = fakeRequest('/api/orders')
    activeStoreInjectHook(noHeader)
    expect(noHeader.query.storeId).toBeUndefined()
  })
})
