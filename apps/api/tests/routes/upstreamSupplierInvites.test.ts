import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

const mocks = vi.hoisted(() => ({
  supplierFindFirst: vi.fn(),
  inviteCreate: vi.fn(),
  inviteFindMany: vi.fn(),
  opLogCreate: vi.fn(),
}))

vi.mock('@dianjie/db', () => {
  const prismaMock: any = {
    supplier: { findFirst: (...args: any[]) => mocks.supplierFindFirst(...args) },
    inviteToken: {
      create: (...args: any[]) => mocks.inviteCreate(...args),
      findMany: (...args: any[]) => mocks.inviteFindMany(...args),
    },
    opLog: { create: (...args: any[]) => mocks.opLogCreate(...args) },
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
})
