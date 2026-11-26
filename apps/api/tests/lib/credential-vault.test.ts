import { afterEach, describe, expect, it, vi } from 'vitest'
import { sealCredential, openCredential } from '../../src/lib/credential-vault'

const ring = (current = 'current', keys = { current: 'ab'.repeat(32) }) => JSON.stringify({ current, keys })
afterEach(() => vi.unstubAllEnvs())

describe('credential vault', () => {
  it('stores authenticated ciphertext and randomizes repeated writes', () => {
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', ring())
    const a = sealCredential('synthetic-token-仅测试', 'wecom:tenant-a:secret')!
    const b = sealCredential('synthetic-token-仅测试', 'wecom:tenant-a:secret')!
    expect(a).not.toContain('synthetic-token')
    expect(a).not.toBe(b)
    expect(openCredential(a, 'wecom:tenant-a:secret')).toBe('synthetic-token-仅测试')
  })
  it('rejects copied ciphertext under another tenant or field', () => {
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', ring())
    const value = sealCredential('synthetic-token', 'wecom:tenant-a:secret')!
    expect(() => openCredential(value, 'wecom:tenant-b:secret')).toThrow('凭据加密')
    expect(() => openCredential(value, 'wecom:tenant-a:token')).toThrow('凭据加密')
  })
  it('rejects tampered ciphertext without leaking the value', () => {
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', ring())
    const value = sealCredential('synthetic-token', 'ctx')!
    const parts = value.split(':'); parts[parts.length - 1] = 'AAAA'
    expect(() => openCredential(parts.join(':'), 'ctx')).toThrow('凭据加密')
  })
  it('supports explicit key rotation while retaining access to older records', () => {
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', ring('older', { older: 'ab'.repeat(32) } as any))
    const old = sealCredential('old-token', 'ctx')!
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', ring('newer', { older: 'ab'.repeat(32), newer: 'cd'.repeat(32) } as any))
    expect(openCredential(old, 'ctx')).toBe('old-token')
    expect(sealCredential('new-token', 'ctx')).toContain('djenc:v1:newer:')
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', ring('newer', { newer: 'cd'.repeat(32) } as any))
    expect(() => openCredential(old, 'ctx')).toThrow('凭据加密')
  })
  it.each(['', 'not-json', '{"current":"x","keys":{"x":"short"}}'])('refuses writes with invalid or missing keys', config => {
    vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', config)
    expect(() => sealCredential('synthetic-token', 'ctx')).toThrow('凭据加密')
  })
  it('only reads legacy values with a deliberate compatibility flag', () => {
    vi.stubEnv('CREDENTIAL_LEGACY_READ_ALLOWED', 'false')
    expect(() => openCredential('legacy-test-token', 'ctx')).toThrow('凭据加密')
    vi.stubEnv('CREDENTIAL_LEGACY_READ_ALLOWED', 'true')
    expect(openCredential('legacy-test-token', 'ctx')).toBe('legacy-test-token')
    expect(() => sealCredential('legacy-test-token', 'ctx')).toThrow('凭据加密')
  })
  it('preserves absent and deliberately cleared credentials', () => {
    expect(sealCredential(null, 'ctx')).toBeNull()
    expect(openCredential(undefined, 'ctx')).toBeNull()
    expect(sealCredential('', 'ctx')).toBe('')
    expect(openCredential('', 'ctx')).toBe('')
  })
  it('refuses unknown envelope versions even when legacy reads are allowed', () => {
    vi.stubEnv('CREDENTIAL_LEGACY_READ_ALLOWED', 'true')
    expect(() => openCredential('djenc:v2:future-record', 'ctx')).toThrow('凭据加密')
  })
})
