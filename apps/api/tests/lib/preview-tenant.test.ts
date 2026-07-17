import { describe, expect, it } from 'vitest'
import { resolveLoginTenantSlug } from '../../src/lib/preview-tenant'

describe('preview login tenant resolution', () => {
  it('keeps the requested tenant when preview isolation is disabled', () => {
    expect(resolveLoginTenantSlug('dianjie')).toBe('dianjie')
    expect(resolveLoginTenantSlug('test')).toBe('test')
  })

  it('accepts the configured preview tenant and the stable test alias', () => {
    expect(resolveLoginTenantSlug('yaohai-test', 'yaohai-test')).toBe('yaohai-test')
    expect(resolveLoginTenantSlug('test', 'yaohai-test')).toBe('yaohai-test')
  })

  it('rejects every other tenant while preview isolation is enabled', () => {
    expect(resolveLoginTenantSlug('dianjie', 'yaohai-test')).toBeNull()
    expect(resolveLoginTenantSlug('other-test', 'yaohai-test')).toBeNull()
  })
})
