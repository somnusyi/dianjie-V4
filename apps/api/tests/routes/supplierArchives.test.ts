import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { supplierArchivePermissions, supplierArchiveRoutes } from '../../src/routes/supplierArchives'

const mocks = vi.hoisted(() => ({
  supplierFindFirst: vi.fn(),
  recordFindMany: vi.fn(),
  recordGroupBy: vi.fn(),
  recordFindUnique: vi.fn(),
  recordFindFirst: vi.fn(),
  recordCreate: vi.fn(),
  recordUpdateMany: vi.fn(),
  contractFindMany: vi.fn(),
  userFindFirst: vi.fn(),
  opLogCreate: vi.fn(),
  assertObject: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  const prismaMock: any = {
    supplier: { findFirst: (...args: any[]) => mocks.supplierFindFirst(...args) },
    supplierArchiveRecord: {
      findMany: (...args: any[]) => mocks.recordFindMany(...args),
      groupBy: (...args: any[]) => mocks.recordGroupBy(...args),
      findUnique: (...args: any[]) => mocks.recordFindUnique(...args),
      findFirst: (...args: any[]) => mocks.recordFindFirst(...args),
      create: (...args: any[]) => mocks.recordCreate(...args),
      updateMany: (...args: any[]) => mocks.recordUpdateMany(...args),
    },
    upstreamSupplierContract: { findMany: (...args: any[]) => mocks.contractFindMany(...args) },
    user: { findFirst: (...args: any[]) => mocks.userFindFirst(...args) },
    opLog: { create: (...args: any[]) => mocks.opLogCreate(...args) },
  }
  prismaMock.$transaction = vi.fn(async (fn: any) => fn(prismaMock))
  return { ...actual, prisma: prismaMock }
})

vi.mock('../../src/routes/upload', () => ({
  assertSupplierArchiveObject: (...args: any[]) => mocks.assertObject(...args),
  canManageSupplierArchiveGeneral: (role: unknown) => ['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'SUPPLY_CHAIN'].includes(String(role)),
  canManageSupplierArchiveSensitive: (role: unknown) => ['SUPER_ADMIN', 'ADMIN', 'FINANCE'].includes(String(role)),
  signOssKey: (key: string | null) => key ? `signed:${key}` : null,
}))

const tenantId = 'tenant-archive'
const supplierId = 'supplier-archive'
const baseSupplier = {
  id: supplierId,
  no: 'SUP027',
  name: '云南世通进出口有限公司',
  category: '干货',
  status: 'ENABLED',
  businessScopes: ['WAREHOUSE_UPSTREAM'],
  contactName: '张三',
  contactPhone: '13800138000',
  address: '昆明市',
  creditType: 'MONTHLY',
  creditDays: 0,
  bankName: '测试银行',
  bankAccount: 'FAKE-ACCOUNT',
  bankAccountName: '云南世通',
  bankCode: 'FAKE-CODE',
}
const records = [
  { id: 'q1', section: 'QUALIFICATION', title: '营业执照', note: '', objectKey: 'supplier-archive-general/tenant-archive/q1.pdf', fileName: 'q1.pdf', fileMime: 'application/pdf', fileSize: 10, validFrom: null, validUntil: null, createdByNameSnapshot: '采购', createdByRoleSnapshot: 'SUPPLY_CHAIN', createdAt: new Date(), updatedAt: new Date() },
  { id: 'f1', section: 'FINANCE', title: '财务档案', note: '敏感内容', objectKey: 'supplier-archive-sensitive/tenant-archive/f1.pdf', fileName: 'f1.pdf', fileMime: 'application/pdf', fileSize: 10, validFrom: null, validUntil: null, createdByNameSnapshot: '财务', createdByRoleSnapshot: 'FINANCE', createdAt: new Date(), updatedAt: new Date() },
]

async function makeApp(role: string) {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => {
    request.user = { tenantId, userId: 'user-1', role }
  })
  await app.register(supplierArchiveRoutes, { prefix: '/api/suppliers' })
  await app.ready()
  return app
}

describe('供应商集中档案', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.supplierFindFirst.mockResolvedValue(baseSupplier)
    mocks.recordFindMany.mockResolvedValue(records)
    mocks.recordGroupBy.mockResolvedValue([
      { section: 'QUALIFICATION', _count: { _all: 1 } },
      { section: 'FINANCE', _count: { _all: 1 } },
    ])
    mocks.contractFindMany.mockResolvedValue([{ id: 'c1', contractNo: 'HT001', title: '年度合同', attachments: [], status: 'ACTIVE' }])
    mocks.userFindFirst.mockResolvedValue({ id: 'user-1', name: '测试用户', role: 'FINANCE' })
    mocks.assertObject.mockResolvedValue(undefined)
    mocks.opLogCreate.mockResolvedValue({})
  })

  it('把合同复用为现有合同真相，供应链只得到财务/开票摘要', async () => {
    mocks.recordFindMany.mockResolvedValue([records[0]])
    const app = await makeApp('SUPPLY_CHAIN')
    const response = await app.inject({ method: 'GET', url: `/api/suppliers/${supplierId}/archive` })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.sections.contracts.source).toBe('UpstreamSupplierContract')
    expect(body.sections.contracts.records[0].contractNo).toBe('HT001')
    expect(body.sections.finance).toMatchObject({ restricted: true, count: null })
    expect(body.sections.finance.records).toBeUndefined()
    expect(body.supplier.bankAccount).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('FAKE-ACCOUNT')
    expect(JSON.stringify(body)).not.toContain('敏感内容')
    expect(JSON.stringify(body)).not.toContain('supplier-archive-sensitive')
    expect(mocks.recordFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ section: 'QUALIFICATION' }),
    }))
    await app.close()
  })

  it('财务角色可读财务信息与开票档案', async () => {
    const app = await makeApp('FINANCE')
    const response = await app.inject({ method: 'GET', url: `/api/suppliers/${supplierId}/archive` })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.permissions.canViewSensitive).toBe(true)
    expect(body.supplier.bankAccount).toBe('FAKE-ACCOUNT')
    expect(body.sections.finance.records[0]).toMatchObject({ title: '财务档案', fileUrl: expect.stringContaining('signed:') })
    await app.close()
  })

  it('服务端禁止供应链写财务档案，不依赖前端隐藏', async () => {
    const app = await makeApp('SUPPLY_CHAIN')
    const response = await app.inject({
      method: 'POST',
      url: `/api/suppliers/${supplierId}/archive`,
      payload: { section: 'FINANCE', title: '财务档案', requestKey: 'request-finance-1' },
    })
    expect(response.statusCode).toBe(403)
    expect(mocks.assertObject).not.toHaveBeenCalled()
    expect(mocks.recordCreate).not.toHaveBeenCalled()
    await app.close()
  })

  it('创建资质档案时固化创建人快照并写操作日志', async () => {
    mocks.recordFindUnique.mockResolvedValue(null)
    mocks.recordCreate.mockImplementation(async ({ data }: any) => ({
      id: 'new-q', ...data, createdAt: new Date(), updatedAt: new Date(),
    }))
    const app = await makeApp('SUPPLY_CHAIN')
    const response = await app.inject({
      method: 'POST',
      url: `/api/suppliers/${supplierId}/archive`,
      payload: { section: 'QUALIFICATION', title: '营业执照', requestKey: 'request-qualification-1' },
    })
    expect(response.statusCode).toBe(201)
    expect(mocks.recordCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      supplierId,
      section: 'QUALIFICATION',
      createdById: 'user-1',
      createdByNameSnapshot: '测试用户',
    }) }))
    expect(mocks.opLogCreate).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('同一请求标识不能跨供应商串档', async () => {
    mocks.recordFindUnique.mockResolvedValue({
      ...records[0], supplierId: 'other-supplier', requestFingerprint: 'not-current',
    })
    const app = await makeApp('SUPPLY_CHAIN')
    const response = await app.inject({
      method: 'POST',
      url: `/api/suppliers/${supplierId}/archive`,
      payload: { section: 'QUALIFICATION', title: '营业执照', requestKey: 'shared-request-key' },
    })
    expect(response.statusCode).toBe(409)
    expect(mocks.recordCreate).not.toHaveBeenCalled()
    await app.close()
  })

  it('附件在 OSS 不存在或元数据不符时不建档', async () => {
    const missing: any = new Error('档案附件不存在')
    missing.statusCode = 400
    mocks.assertObject.mockRejectedValueOnce(missing)
    const app = await makeApp('SUPPLY_CHAIN')
    const response = await app.inject({
      method: 'POST',
      url: `/api/suppliers/${supplierId}/archive`,
      payload: {
        section: 'QUALIFICATION', title: '营业执照', requestKey: 'request-with-file',
        attachment: { key: 'supplier-archive-general/tenant-archive/missing.pdf', name: 'missing.pdf', mime: 'application/pdf', size: 10 },
      },
    })
    expect(response.statusCode).toBe(400)
    expect(mocks.recordCreate).not.toHaveBeenCalled()
    await app.close()
  })

  it('归档并发仅一次写入操作日志', async () => {
    mocks.recordUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    const archivedAt = new Date()
    mocks.recordFindFirst.mockImplementation(async (args: any) => args?.select
      ? { archivedAt }
      : { ...records[0], supplierId, archivedAt: null })
    const app = await makeApp('SUPPLY_CHAIN')
    const [first, second] = await Promise.all([
      app.inject({ method: 'PATCH', url: `/api/suppliers/${supplierId}/archive/q1/archive` }),
      app.inject({ method: 'PATCH', url: `/api/suppliers/${supplierId}/archive/q1/archive` }),
    ])
    expect([first.statusCode, second.statusCode]).toEqual([200, 200])
    expect(mocks.opLogCreate).toHaveBeenCalledTimes(1)
    expect([first.json().duplicated, second.json().duplicated].sort()).toEqual([false, true])
    await app.close()
  })

  it('门店与供应商角色直接请求集中档案也被服务端拒绝', async () => {
    for (const role of ['MANAGER', 'SUPPLIER_OWNER']) {
      const app = await makeApp(role)
      const response = await app.inject({ method: 'GET', url: `/api/suppliers/${supplierId}/archive` })
      expect(response.statusCode).toBe(403)
      await app.close()
    }
  })

  it('权限表不将门店或供应商角色纳入集中档案', () => {
    expect(supplierArchivePermissions('SUPPLY_CHAIN')).toMatchObject({ canView: true, canViewSensitive: false })
    expect(supplierArchivePermissions('FINANCE')).toMatchObject({ canView: true, canViewSensitive: true })
    expect(supplierArchivePermissions('MANAGER')).toMatchObject({ canView: false, canViewSensitive: false })
    expect(supplierArchivePermissions('SUPPLIER_OWNER')).toMatchObject({ canView: false, canViewSensitive: false })
  })
})
