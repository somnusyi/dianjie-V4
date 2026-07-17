import { describe, expect, it } from 'vitest'
import { clientRequestId } from './client-id'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('clientRequestId', () => {
  it('uses native randomUUID when it is available', () => {
    const expected = '123e4567-e89b-42d3-a456-426614174000'
    expect(clientRequestId({ randomUUID: () => expected })).toBe(expected)
  })

  it('creates a standards-compliant UUID with getRandomValues only', () => {
    const value = clientRequestId({
      getRandomValues: bytes => { bytes.fill(0xab); return bytes },
    })
    expect(value).toMatch(UUID_V4)
    expect(value).toBe('abababab-abab-4bab-abab-abababababab')
  })

  it('still creates unique valid UUIDs when Web Crypto is unavailable', () => {
    const first = clientRequestId(null)
    const second = clientRequestId(null)
    expect(first).toMatch(UUID_V4)
    expect(second).toMatch(UUID_V4)
    expect(second).not.toBe(first)
  })
})
