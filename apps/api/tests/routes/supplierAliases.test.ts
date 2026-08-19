import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  supplierFindMany: vi.fn(),
  supplierFindFirst: vi.fn(),
  aliasFindMany: vi.fn(),
  aliasFindUnique: vi.fn(),
  aliasCreate: vi.fn(),
  aliasDelete: vi.fn(),
  movementGroupBy: vi.fn(),
  movementUpdateMany: vi.fn(),
  opLogCreate: vi.fn(),
  resolveWarehouseId: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  const prismaMock: any = {
    supplier: {
      findMany: (...args: any[]) => mocks.supplierFindMany(...args),
      findFirst: (...args: any[]) => mocks.supplierFindFirst(...args),
    },
    supplierNameAlias: {
      findMany: (...args: any[]) => mocks.aliasFindMany(...args),
      findUnique: (...args: any[]) => mocks.aliasFindUnique(...args),
      create: (...args: any[]) => mocks.aliasCreate(...args),
      delete: (...args: any[]) => mocks.aliasDelete(...args),
    },
    warehouseLedgerMovement: {
      groupBy: (...args: any[]) => mocks.movementGroupBy(...args),
      updateMany: (...args: any[]) => mocks.movementUpdateMany(...args),
    },
    opLog: { create: (...args: any[]) => mocks.opLogCreate(...args) },
  }
  return { ...actual, prisma: prismaMock }
})

vi.mock('../../src/services/defaultWarehouse', () => ({
  resolveTenantWarehouseId: (...args: any[]) => mocks.resolveWarehouseId(...args),
}))

import { supplierAliasRoutes } from '../../src/routes/supplierAliases'
import { resolveSupplierIdsByNames } from '../../src/services/supplierAliases'

function buildApp(actor: Record<string, unknown>) {
  const app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = actor })
  app.register(supplierAliasRoutes)
  return app
}

const actor = { tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN' }
const upstreamSupplier = { id: 'sup-1', name: '井育苗菇', status: 'ENABLED', businessScopes: ['WAREHOUSE_UPSTREAM'] }

describe('supplier alias resolution service', () => {
  beforeEach(() => {
    mocks.supplierFindMany.mockReset()
    mocks.aliasFindMany.mockReset()
  })

  it('matches exact supplier names and falls back to aliases', async () => {
    mocks.supplierFindMany.mockResolvedValue([{ id: 'sup-1', name: '井育苗菇', status: 'ENABLED' }])
    mocks.aliasFindMany.mockResolvedValue([{ alias: '井育菌菇（美团）', supplierId: 'sup-2' }])

    const resolved = await resolveSupplierIdsByNames('tenant-1', ['井育苗菇', '井育菌菇（美团）', '查无此人'])

    expect(resolved.get('井育苗菇')).toBe('sup-1')
    expect(resolved.get('井育菌菇（美团）')).toBe('sup-2')
    expect(resolved.has('查无此人')).toBe(false)
  })

  it('prefers the enabled record when supplier names collide, and skips true ambiguity', async () => {
    mocks.supplierFindMany.mockResolvedValue([
      { id: 'sup-old', name: '老王蔬菜', status: 'DISABLED' },
      { id: 'sup-new', name: '老王蔬菜', status: 'ENABLED' },
    ])
    const resolved = await resolveSupplierIdsByNames('tenant-1', ['老王蔬菜'])
    expect(resolved.get('老王蔬菜')).toBe('sup-new')

    mocks.supplierFindMany.mockResolvedValue([
      { id: 'sup-a', name: '双活供应商', status: 'ENABLED' },
      { id: 'sup-b', name: '双活供应商', status: 'ENABLED' },
    ])
    mocks.aliasFindMany.mockResolvedValue([])
    const ambiguous = await resolveSupplierIdsByNames('tenant-1', ['双活供应商'])
    expect(ambiguous.has('双活供应商')).toBe(false)
  })
})

describe('supplier alias routes', () => {
  beforeEach(() => {
    mocks.supplierFindFirst.mockReset()
    mocks.supplierFindFirst.mockResolvedValue(upstreamSupplier)
    mocks.aliasFindUnique.mockReset()
    mocks.aliasFindUnique.mockResolvedValue(null)
    mocks.aliasCreate.mockReset()
    mocks.aliasCreate.mockImplementation(async ({ data }: any) => ({ id: 'alias-1', ...data }))
    mocks.aliasDelete.mockReset()
    mocks.aliasDelete.mockResolvedValue({})
    mocks.aliasFindMany.mockReset()
    mocks.aliasFindMany.mockResolvedValue([])
    mocks.movementGroupBy.mockReset()
    mocks.movementGroupBy.mockResolvedValue([])
    mocks.movementUpdateMany.mockReset()
    mocks.movementUpdateMany.mockResolvedValue({ count: 3 })
    mocks.opLogCreate.mockReset()
    mocks.opLogCreate.mockResolvedValue({})
    mocks.resolveWarehouseId.mockReset()
    mocks.resolveWarehouseId.mockResolvedValue('warehouse-1')
  })

  it('lists only truly unclaimed source names and flags multi-supplier rows', async () => {
    mocks.movementGroupBy.mockResolvedValue([
      { sourceName: '井育苗菇', _count: { _all: 12 }, _max: { effectiveAt: new Date('2026-08-10') } },
      { sourceName: '美团老王', _count: { _all: 5 }, _max: { effectiveAt: new Date('2026-08-09') } },
      { sourceName: 'A供应商、B供应商', _count: { _all: 2 }, _max: { effectiveAt: new Date('2026-08-08') } },
    ])
    // 「井育苗菇」能被精确名自动解析 → 不进待认领
    mocks.supplierFindMany.mockResolvedValue([{ id: 'sup-1', name: '井育苗菇', status: 'ENABLED' }])

    const app = buildApp(actor)
    const response = await app.inject({ method: 'GET', url: '/unclaimed' })

    expect(response.statusCode).toBe(200)
    const { items } = response.json()
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ sourceName: '美团老王', rowCount: 5, multi: false })
    expect(items[1]).toMatchObject({ sourceName: 'A供应商、B供应商', multi: true })
    await app.close()
  })

  it('claims an alias, backfills ledger rows and writes an opLog', async () => {
    // 第一次 findFirst 是查目标供应商（按 id），第二次是撞名检查（按 name）→ 无撞名
    mocks.supplierFindFirst.mockReset()
    mocks.supplierFindFirst.mockImplementation(async ({ where }: any) => (typeof where?.id === 'string' ? upstreamSupplier : null))
    const app = buildApp(actor)
    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: { supplierId: 'sup-1', alias: '美团老王' },
    })

    expect(response.statusCode).toBe(200)
    expect(mocks.aliasCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: 'tenant-1', supplierId: 'sup-1', alias: '美团老王' }),
    }))
    expect(mocks.movementUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sourceName: '美团老王', supplierId: null, type: 'MANUAL_INBOUND' }),
      data: { supplierId: 'sup-1' },
    }))
    expect(response.json()).toMatchObject({ ok: true, backfilled: 3 })
    expect(mocks.opLogCreate).toHaveBeenCalled()
    await app.close()
  })

  it('rejects claiming a multi-supplier aggregate name', async () => {
    const app = buildApp(actor)
    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: { supplierId: 'sup-1', alias: 'A供应商、B供应商' },
    })

    expect(response.statusCode).toBe(400)
    expect(mocks.aliasCreate).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects aliases colliding with another supplier profile name', async () => {
    mocks.supplierFindFirst
      .mockResolvedValueOnce(upstreamSupplier) // 目标供应商
      .mockResolvedValueOnce({ id: 'sup-9', name: '美团老王' }) // 撞名档案
    const app = buildApp(actor)
    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: { supplierId: 'sup-1', alias: '美团老王' },
    })

    expect(response.statusCode).toBe(409)
    expect(mocks.aliasCreate).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects non-upstream suppliers as alias target', async () => {
    mocks.supplierFindFirst.mockResolvedValue({ ...upstreamSupplier, businessScopes: ['STORE_FULFILLER'] })
    const app = buildApp(actor)
    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: { supplierId: 'sup-1', alias: '美团老王' },
    })

    expect(response.statusCode).toBe(409)
    expect(mocks.aliasCreate).not.toHaveBeenCalled()
    await app.close()
  })

  it('deletes an alias without touching backfilled ledger rows', async () => {
    mocks.aliasFindMany.mockReset()
    const existing = { id: 'alias-1', tenantId: 'tenant-1', alias: '美团老王', supplierId: 'sup-1' }
    mocks.aliasFindUnique.mockReset()
    // DELETE 走 findFirst
    mocks.supplierFindFirst.mockResolvedValue(upstreamSupplier)
    const app = buildApp(actor)
    // 先造一条再删：直接用 delete 路径
    const prismaModule = await import('@dianjie/db')
    ;(prismaModule.prisma as any).supplierNameAlias.findFirst = vi.fn().mockResolvedValue(existing)
    const response = await app.inject({ method: 'DELETE', url: '/alias-1' })

    expect(response.statusCode).toBe(200)
    expect(mocks.aliasDelete).toHaveBeenCalledWith({ where: { id: 'alias-1' } })
    expect(mocks.movementUpdateMany).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects supplier accounts', async () => {
    const app = buildApp({ tenantId: 'tenant-1', userId: 'supplier-user', role: 'SUPPLIER_OWNER' })
    const response = await app.inject({ method: 'GET', url: '/unclaimed' })

    expect(response.statusCode).toBe(403)
    await app.close()
  })
})
