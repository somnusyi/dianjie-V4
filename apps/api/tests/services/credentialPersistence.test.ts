import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sealCredential, openCredential, credentialContext } from '../../src/lib/credential-vault'
import { getAccessToken, getContactToken } from '../../src/services/wecom'
import { DbTokenStore } from '../../src/services/meituan/tokenStore'
import { prisma } from '@dianjie/db'

vi.mock('@dianjie/db', () => ({ prisma: {
  weComConfig: { findUnique: vi.fn(), update: vi.fn() },
  meituanAuthToken: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn(), update: vi.fn() },
} }))
const context = (field: string) => credentialContext('tenant-a', 'wecom', field)
beforeEach(() => {
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', JSON.stringify({ current: 'test', keys: { test: 'ab'.repeat(32) } }))
  vi.stubEnv('CREDENTIAL_LEGACY_READ_ALLOWED', 'false')
})
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('WeCom stored credentials', () => {
  it('reads an encrypted cached token without contacting the provider', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    vi.mocked(prisma.weComConfig.findUnique).mockResolvedValue({ enabled: true,
      appSecret: sealCredential('fake-secret', context('appSecret')),
      accessToken: sealCredential('fake-cached-token', context('accessToken')),
      accessTokenExp: new Date(Date.now() + 3600000),
    } as any)
    expect(await getAccessToken('tenant-a')).toBe('fake-cached-token')
    expect(fetch).not.toHaveBeenCalled()
    expect(prisma.weComConfig.update).not.toHaveBeenCalled()
  })
  it.each([['appSecret', 'accessToken', getAccessToken], ['contactSecret', 'contactToken', getContactToken]] as const)('encrypts a newly cached %s token', async (secretField, tokenField, getToken) => {
    vi.mocked(prisma.weComConfig.findUnique).mockResolvedValue({ enabled: true, corpId: 'fake-corp',
      appSecret: sealCredential('fake-secret', context('appSecret')),
      [secretField]: sealCredential('fake-secret', context(secretField)),
    } as any)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ errcode: 0, access_token: 'fake-new-token', expires_in: 7200 }) }))
    expect(await getToken('tenant-a')).toBe('fake-new-token')
    const data = vi.mocked(prisma.weComConfig.update).mock.calls[0][0].data as any
    expect(data[tokenField]).toMatch(/^djenc:v1:/)
    expect(data[tokenField]).not.toContain('fake-new-token')
    expect(openCredential(data[tokenField], context(tokenField))).toBe('fake-new-token')
  })
})

describe('Meituan stored credentials', () => {
  it('protects bootstrap values before database creation', async () => {
    vi.stubEnv('MEITUAN_BOOTSTRAP_AUTH_TOKEN', 'fake-bootstrap-token')
    vi.stubEnv('MEITUAN_BOOTSTRAP_REFRESH_TOKEN', 'fake-refresh-token')
    vi.mocked(prisma.meituanAuthToken.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.meituanAuthToken.create).mockImplementation(async args => args.data as any)
    expect(await new DbTokenStore(7).getActive()).toBe('fake-bootstrap-token')
    const data = vi.mocked(prisma.meituanAuthToken.create).mock.calls[0][0].data
    expect(data.appAuthToken).toMatch(/^djenc:v1:/)
    expect(data.refreshToken).toMatch(/^djenc:v1:/)
    expect(JSON.stringify(data)).not.toContain('fake-bootstrap-token')
  })
  it('encrypts both upsert branches without changing expiry metadata', async () => {
    const expiresAt = new Date('2027-01-01T00:00:00Z')
    await new DbTokenStore(7).update({ appAuthToken: 'fake-updated-token', refreshToken: 'fake-updated-refresh', expiresAt })
    const args = vi.mocked(prisma.meituanAuthToken.upsert).mock.calls[0][0]
    expect(args.create.appAuthToken).toMatch(/^djenc:v1:/)
    expect(args.update.appAuthToken).toBe(args.create.appAuthToken)
    expect(args.create.expiresAt).toEqual(expiresAt)
    expect(openCredential(args.create.refreshToken, credentialContext(7, 'meituan', 'refreshToken'))).toBe('fake-updated-refresh')
  })
  it('refuses a token copied from another organization', async () => {
    vi.mocked(prisma.meituanAuthToken.findUnique).mockResolvedValue({ appAuthToken: sealCredential('fake-token', credentialContext(7, 'meituan', 'appAuthToken')) } as any)
    await expect(new DbTokenStore(8).getActive()).rejects.toThrow('凭据加密')
  })
})
