import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const mocks = vi.hoisted(() => ({
  supplierFindFirst: vi.fn(),
  inviteCreate: vi.fn(),
  inviteFindMany: vi.fn(),
  opLogCreate: vi.fn(),
  opLogFindMany: vi.fn(),
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
}))

vi.mock('@dianjie/db', () => {
  const prismaMock: any = {
    supplier: { findFirst: (...args: any[]) => mocks.supplierFindFirst(...args) },
    inviteToken: {
      create: (...args: any[]) => mocks.inviteCreate(...args),
      findMany: (...args: any[]) => mocks.inviteFindMany(...args),
    },
    opLog: { create: (...args: any[]) => mocks.opLogCreate(...args), findMany: (...args: any[]) => mocks.opLogFindMany(...args) },
    user: { findUnique: (...args: any[]) => mocks.userFindUnique(...args), create: (...args: any[]) => mocks.userCreate(...args) },
  }
  prismaMock.$transaction = vi.fn(async (fn: any) => fn(prismaMock))
  return { prisma: prismaMock }
})
import { upstreamSupplierInviteRoutes } from '../../src/routes/upstreamSupplierInvites'

describe('upstream supplier restricted invitations', () => {
  const tenantId = 'tenant-upstream-invite'
  const supplierId = 'supplier-upstream'
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId,
        userId: 'supply-chain-user',
        role: request.headers['x-test-role'] || 'SUPPLY_CHAIN',
      }
    })
    await app.register(upstreamSupplierInviteRoutes, { prefix: '/api/upstream' })
    await app.ready()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.supplierFindFirst.mockResolvedValue({ id: supplierId, name: '云南蔬菜供应商' })
    mocks.inviteCreate.mockImplementation(async ({ data }: any) => ({
      id: 'invite-1',
      ...data,
      createdAt: new Date('2026-09-16T00:00:00.000Z'),
    }))
    mocks.opLogCreate.mockResolvedValue({})
    mocks.userFindUnique.mockResolvedValue(null)
    mocks.userCreate.mockResolvedValue({ id: 'new-user' })
    mocks.opLogFindMany.mockResolvedValue([])
  })

  it('allows supply chain to invite only an account bound to an enabled upstream supplier', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/upstream/suppliers/${supplierId}/invites`,
      payload: { role: 'SUPPLIER_OWNER', note: '负责人' },
    })

    expect(response.statusCode).toBe(201)
    expect(mocks.supplierFindFirst).toHaveBeenCalledWith({
      where: {
        id: supplierId,
        tenantId,
        status: 'ENABLED',
        businessScopes: { has: 'WAREHOUSE_UPSTREAM' },
      },
      select: { id: true, name: true },
    })
    expect(mocks.inviteCreate.mock.calls[0][0].data).toMatchObject({
      tenantId,
      supplierId,
      role: 'SUPPLIER_OWNER',
      storeIds: [],
    })
  })

  it('rejects internal roles even when called by supply chain', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/upstream/suppliers/${supplierId}/invites`,
      payload: { role: 'FINANCE' },
    })

    expect(response.statusCode).toBe(400)
    expect(mocks.inviteCreate).not.toHaveBeenCalled()
  })

  it('rejects a supplier without the warehouse-upstream scope', async () => {
    mocks.supplierFindFirst.mockResolvedValue(null)
    const response = await app.inject({
      method: 'POST',
      url: `/api/upstream/suppliers/${supplierId}/invites`,
      payload: { role: 'SUPPLIER_STAFF' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().error).toContain('上游供应商')
  })

  it('does not grant the restricted endpoint to ordinary store roles', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/upstream/suppliers/${supplierId}/invites`,
      headers: { 'x-test-role': 'MANAGER' },
      payload: { role: 'SUPPLIER_STAFF' },
    })

    expect(response.statusCode).toBe(403)
    expect(mocks.supplierFindFirst).not.toHaveBeenCalled()
  })
  it('direct creation fixes company/role and saves only company/name/phone history without password', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/upstream/suppliers/${supplierId}/accounts`, payload: { name: '张先生', phone: '13970000999', password: 'test-password' } })
    expect(response.statusCode).toBe(201)
    expect(mocks.supplierFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: supplierId, tenantId, status: 'ENABLED', businessScopes: { has: 'WAREHOUSE_UPSTREAM' } } }))
    const data = mocks.userCreate.mock.calls[0][0].data
    expect(data).toMatchObject({ supplierId, role: 'SUPPLIER_OWNER', status: 'ACTIVE', tenantId, name: '张先生', phone: '13970000999' })
    expect(data.password).not.toBe('test-password')
    expect(mocks.opLogCreate.mock.calls[0][0].data.metadata).toEqual({ supplierId, supplierName: '云南蔬菜供应商', name: '张先生', phone: '13970000999' })
    expect(response.json()).toEqual({ company: '云南蔬菜供应商', name: '张先生', phone: '13970000999' })
  })
  it('rejects unowned or disabled companies before creating an account', async () => {
    mocks.supplierFindFirst.mockResolvedValue(null)
    const r = await app.inject({ method: 'POST', url: `/api/upstream/suppliers/${supplierId}/accounts`, payload: { name: '张先生', phone: '13970000999', password: 'test-password' } })
    expect(r.statusCode).toBe(404); expect(mocks.userCreate).not.toHaveBeenCalled()
  })
  it('never overwrites an existing phone or rebinds its company', async () => {
    mocks.userFindUnique.mockResolvedValue({ id: 'existing-user' })
    const r = await app.inject({ method: 'POST', url: `/api/upstream/suppliers/${supplierId}/accounts`, payload: { name: '张先生', phone: '13970000999', password: 'test-password' } })
    expect(r.statusCode).toBe(409); expect(mocks.userCreate).not.toHaveBeenCalled(); expect(mocks.opLogCreate).not.toHaveBeenCalled()
  })
  it('handles a concurrent duplicate as a conflict', async () => {
    mocks.userCreate.mockRejectedValue({ code: 'P2002' })
    const r = await app.inject({ method: 'POST', url: `/api/upstream/suppliers/${supplierId}/accounts`, payload: { name: '张先生', phone: '13970000999', password: 'test-password' } })
    expect(r.statusCode).toBe(409); expect(mocks.opLogCreate).not.toHaveBeenCalled()
  })
  it('denies supplier and finance access and rejects extra role/company fields', async () => {
    for (const role of ['SUPPLIER_OWNER', 'FINANCE']) {
      const r = await app.inject({ method: 'POST', url: `/api/upstream/suppliers/${supplierId}/accounts`, headers: { 'x-test-role': role }, payload: { name: '张先生', phone: '13970000999', password: 'test-password' } })
      expect(r.statusCode).toBe(403)
      expect((await app.inject({ method: 'GET', url: '/api/upstream/supplier-accounts/history', headers: { 'x-test-role': role } })).statusCode).toBe(403)
    }
    expect((await app.inject({ method: 'POST', url: `/api/upstream/suppliers/${supplierId}/accounts`, payload: { name: '张先生', phone: '13970000999', password: 'test-password', role: 'ADMIN', supplierId: 'other' } })).statusCode).toBe(400)
    expect(mocks.userCreate).not.toHaveBeenCalled()
  })
  it('history projects only three fields and restricts tenant and creation action', async () => {
    mocks.opLogFindMany.mockResolvedValue([{ metadata: { supplierName: '旧公司名', name: '张先生', phone: '13970000999', secret: 'must-not-return' } }])
    const r = await app.inject({ method: 'GET', url: '/api/upstream/supplier-accounts/history' })
    expect(r.json()).toEqual({ items: [{ company: '旧公司名', name: '张先生', phone: '13970000999' }], hasMore: false })
    expect(mocks.opLogFindMany.mock.calls[0][0].where).toEqual({ tenantId, entityType: 'User', action: '供应链直接添加供应商账号' })
  })

  it('paginates retained history and refuses invalid page numbers', async () => {
    mocks.opLogFindMany.mockResolvedValue(Array.from({ length: 101 }, () => ({ metadata: { supplierName: 'A', name: '人员', phone: '13970000999' } })))
    const r = await app.inject({ method: 'GET', url: '/api/upstream/supplier-accounts/history?page=1' })
    expect(r.json().items).toHaveLength(100); expect(r.json().hasMore).toBe(true)
    expect(mocks.opLogFindMany.mock.calls[0][0]).toMatchObject({ skip: 100, take: 101 })
    expect((await app.inject({ method: 'GET', url: '/api/upstream/supplier-accounts/history?page=-1' })).statusCode).toBe(400)
  })
  it('does not report success if writing the transactional history fails', async () => {
    mocks.opLogCreate.mockRejectedValueOnce(new Error('history failure'))
    const r = await app.inject({ method: 'POST', url: `/api/upstream/suppliers/${supplierId}/accounts`, payload: { name: '张先生', phone: '13970000999', password: 'test-password' } })
    expect(r.statusCode).toBe(500)
    expect(r.body).not.toContain('test-password')
  })

})
