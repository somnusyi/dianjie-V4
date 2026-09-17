import { afterEach, describe, expect, it } from 'vitest'
import { upstreamFeatureEnabled, upstreamFeatureSnapshot } from '../../src/lib/upstream-feature-flags'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('upstream feature flags', () => {
  it('enables procurement locally and keeps manual inbound open by default', () => {
    process.env.NODE_ENV = 'test'
    delete process.env.UPSTREAM_PROCUREMENT_ENABLED
    delete process.env.UPSTREAM_RECEIPT_POSTING_ENABLED
    delete process.env.UPSTREAM_MANUAL_INBOUND_RESTRICTED
    expect(upstreamFeatureSnapshot()).toEqual({
      procurement: true,
      receiptPosting: true,
      manualInboundRestricted: false,
    })
  })

  it('defaults production writes to off until explicitly enabled', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.UPSTREAM_PROCUREMENT_ENABLED
    delete process.env.UPSTREAM_RECEIPT_POSTING_ENABLED
    expect(upstreamFeatureEnabled('UPSTREAM_PROCUREMENT_ENABLED')).toBe(false)
    expect(upstreamFeatureEnabled('UPSTREAM_RECEIPT_POSTING_ENABLED')).toBe(false)
  })

  it('accepts explicit boolean-like values', () => {
    process.env.UPSTREAM_PROCUREMENT_ENABLED = 'yes'
    process.env.UPSTREAM_MANUAL_INBOUND_RESTRICTED = '1'
    expect(upstreamFeatureEnabled('UPSTREAM_PROCUREMENT_ENABLED')).toBe(true)
    expect(upstreamFeatureEnabled('UPSTREAM_MANUAL_INBOUND_RESTRICTED')).toBe(true)
  })
})
