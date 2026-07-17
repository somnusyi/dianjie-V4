import { describe, expect, it } from 'vitest'
import { buildIdempotencyKey, hashRequestBody } from '../../src/lib/idempotency'

const base = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  method: 'PATCH',
  url: '/api/orders/order-a/ship',
  clientKey: 'request-12345678',
}

describe('idempotency identity', () => {
  it('is stable for the same authenticated command', () => {
    expect(buildIdempotencyKey(base)).toBe(buildIdempotencyKey({ ...base }))
  })

  it('is isolated by tenant and user', () => {
    expect(buildIdempotencyKey(base)).not.toBe(buildIdempotencyKey({ ...base, tenantId: 'tenant-b' }))
    expect(buildIdempotencyKey(base)).not.toBe(buildIdempotencyKey({ ...base, userId: 'user-b' }))
  })

  it('detects a reused key with a different request body', () => {
    const first = hashRequestBody({ shippedQty: 1 }, 'application/json')
    const second = hashRequestBody({ shippedQty: 2 }, 'application/json')
    expect(first).not.toBe(second)
    expect(first).toBe(hashRequestBody({ shippedQty: 1 }, 'application/json'))
  })
})
