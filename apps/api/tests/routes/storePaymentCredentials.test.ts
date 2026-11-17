import Fastify from 'fastify'
import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {credentialContext, openCredential} from '../../src/lib/credential-vault'

const db = vi.hoisted(() => ({store: {findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn()}, opLog: {create: vi.fn()}, receipt: {groupBy: vi.fn(), findMany: vi.fn()}, paymentSchedule: {findMany: vi.fn()}, lossClaim: {groupBy: vi.fn(), findMany: vi.fn()}, $queryRaw: vi.fn(), $executeRaw: vi.fn(), $transaction: vi.fn()}))
vi.mock('@dianjie/db', () => ({prisma: db}))
vi.mock('../../src/lib/cache', () => ({cached: vi.fn(async (_key, _ttl, callback) => callback()), invalidatePattern: vi.fn(async () => {})}))
import {storeRoutes} from '../../src/routes/stores'
import {cached} from '../../src/lib/cache'

let record: any
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(cached).mockImplementation(async (_key, _ttl, callback: any) => callback())
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', JSON.stringify({current: 'test', keys: {test: 'cd'.repeat(32)}}))
  record = {id: 'store-a', tenantId: 'tenant-a', name: '青禾门店', no: 'QH01', bankAccountNo: '12340000', aggregatorApiKeyEnc: 'legacy-synthetic-key'}
  db.store.findFirst.mockImplementation(async () => record)
  db.store.findMany.mockImplementation(async () => [record])
  db.store.update.mockImplementation(async ({data}) => Object.assign(record, data))
  db.$transaction.mockImplementation(async callback => callback(db))
  db.$executeRaw.mockResolvedValue(1)
  db.$queryRaw.mockResolvedValue([])
  db.receipt.groupBy.mockResolvedValue([])
  db.receipt.findMany.mockResolvedValue([])
  db.paymentSchedule.findMany.mockResolvedValue([])
  db.lossClaim.groupBy.mockResolvedValue([])
  db.lossClaim.findMany.mockResolvedValue([])
  db.opLog.create.mockResolvedValue({id: 'log-a'})
})
afterEach(() => vi.unstubAllEnvs())
async function appFor(role = 'FINANCE') {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => {req.user = {role, tenantId: 'tenant-a', userId: 'finance-a'}})
  await app.register(storeRoutes, {prefix: '/stores'})
  return app
}

it.each([
  ['aggregatorApiKey', 'aggregatorApiKeyEnc'], ['aggregatorSecret', 'aggregatorSecretEnc'],
  ['wechatApiV3Key', 'wechatApiV3KeyEnc'], ['alipayPrivateKey', 'alipayPrivateKeyEnc'],
])('encrypts %s on the real configuration route without returning or auditing its value', async (field, column) => {
  const app = await appFor()
  try {
    const raw = `synthetic-${field}-value`
    const response = await app.inject({method: 'PATCH', url: '/stores/store-a/payment-config', payload: {[field]: raw}})
    expect(response.statusCode, response.body).toBe(200)
    const data = db.store.update.mock.calls[0][0].data
    expect(data[column]).toMatch(/^djenc:v1:/)
    expect(data[column]).not.toContain(raw)
    const ctx = credentialContext('tenant-a:store-a', 'store-payment', field)
    expect(openCredential(data[column], ctx)).toBe(raw)
    expect(() => openCredential(data[column], credentialContext('tenant-b:store-a', 'store-payment', field))).toThrow()
    expect(() => openCredential(data[column], credentialContext('tenant-a:store-b', 'store-payment', field))).toThrow()
    expect(JSON.stringify(db.opLog.create.mock.calls)).not.toContain(raw)
    const read = await app.inject({url: '/stores/store-a/payment-config'})
    expect(read.statusCode).toBe(200)
    expect(read.body).not.toContain(raw)
    expect(read.body).not.toContain('djenc:')
    expect(response.body).not.toContain(raw)
  } finally {await app.close()}
})

it('leaves stored credentials unchanged when only ordinary configuration is edited', async () => {
  const app = await appFor()
  try {
    const response = await app.inject({method: 'PATCH', url: '/stores/store-a/payment-config', payload: {aggregatorVendor: 'qianqian'}})
    expect(response.statusCode).toBe(200)
    expect(db.store.update.mock.calls[0][0].data).toEqual({aggregatorVendor: 'qianqian'})
    expect(record.aggregatorApiKeyEnc).toBe('legacy-synthetic-key')
  } finally {await app.close()}
})

it('refuses new credential writes when no encryption key is configured', async () => {
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', '')
  const app = await appFor()
  try {
    const response = await app.inject({method: 'PATCH', url: '/stores/store-a/payment-config', payload: {aggregatorSecret: 'synthetic-private-value'}})
    expect(response.statusCode).toBe(503)
    expect(db.store.update).not.toHaveBeenCalled()
    expect(response.body).not.toContain('synthetic-private-value')
  } finally {await app.close()}
})

it('preserves role and tenant restrictions before saving', async () => {
  const supplier = await appFor('SUPPLIER_OWNER')
  try {
    expect((await supplier.inject({method: 'PATCH', url: '/stores/store-a/payment-config', payload: {aggregatorSecret: 'synthetic-private-value'}})).statusCode).toBe(403)
    expect(db.store.update).not.toHaveBeenCalled()
  } finally {await supplier.close()}
  db.store.findFirst.mockResolvedValue(null)
  const finance = await appFor()
  try {
    expect((await finance.inject({method: 'PATCH', url: '/stores/other-store/payment-config', payload: {aggregatorSecret: 'synthetic-private-value'}})).statusCode).toBe(404)
    expect(db.store.update).not.toHaveBeenCalled()
    expect(db.store.findFirst).toHaveBeenCalledWith({where: {id: 'other-store', tenantId: 'tenant-a'}})
  } finally {await finance.close()}
})

it('never returns legacy plaintext or encrypted credential fields in ordinary store list/detail/update responses', async () => {
  const fields = ['aggregatorApiKeyEnc', 'aggregatorSecretEnc', 'wechatApiV3KeyEnc', 'alipayPrivateKeyEnc']
  for (const field of fields) record[field] = `legacy-private-${field}`
  const app = await appFor('ADMIN')
  try {
    const responses = [
      await app.inject({url: '/stores'}),
      await app.inject({url: '/stores/store-a'}),
      await app.inject({method: 'PATCH', url: '/stores/store-a', payload: {address: '青禾路'}}),
    ]
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(200)
      expect(response.body).toContain('store-a')
      for (const field of fields) expect(response.body).not.toContain(field)
    }
    expect(responses[0].json()[0]).toHaveProperty('stats')
    expect(responses[1].json()).toHaveProperty('purchaseTrend')
  } finally {await app.close()}
})
