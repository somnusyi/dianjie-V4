import Fastify from 'fastify'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  recordBaseline: vi.fn(),
}))

vi.mock('../../src/services/warehouseLedgerBaselineImport', () => ({
  recordWarehouseBaselineSnapshot: (...args: any[]) => mocks.recordBaseline(...args),
}))

import { warehouseInventoryImportRoutes } from '../../src/routes/warehouseInventoryImports'

describe('warehouse inventory baseline route', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        tenantId: 'tenant-1',
        userId: 'user-1',
        role: 'SUPPLY_CHAIN',
      }
    })
    await app.register(warehouseInventoryImportRoutes, { prefix: '/api/warehouse-inventory-imports' })
    await app.ready()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.recordBaseline.mockResolvedValue({
      blocked: false,
      importId: 'import-1',
      importNo: 'WBI-001',
      warehouseId: 'warehouse-1',
      snapshotAt: '2026-07-31T15:59:59.999Z',
      items: [],
      blockingIssues: [],
      createdCount: 1,
      adjustedCount: 0,
    })
  })

  it('accepts only rowVersion and lets the service derive the Shanghai snapshot cutoff', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/warehouse-inventory-imports/import-1/baseline',
      payload: { rowVersion: 3 },
    })

    expect(response.statusCode).toBe(200)
    expect(mocks.recordBaseline).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'SUPPLY_CHAIN',
      importId: 'import-1',
      rowVersion: 3,
    })
    expect(response.json()).toMatchObject({
      ok: true,
      importId: 'import-1',
      snapshotAt: '2026-07-31T15:59:59.999Z',
    })
  })

  it('returns blocking issues without applying a legacy confirm write', async () => {
    mocks.recordBaseline.mockResolvedValueOnce({
      blocked: true,
      importId: 'import-1',
      importNo: 'WBI-001',
      warehouseId: 'warehouse-1',
      snapshotAt: '2026-07-31T15:59:59.999Z',
      items: [],
      blockingIssues: [{ code: 'SKU_UNMATCHED', message: '商品未匹配' }],
      createdCount: 0,
      adjustedCount: 0,
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/warehouse-inventory-imports/import-1/baseline',
      payload: { rowVersion: 3 },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      blockingIssues: [{ code: 'SKU_UNMATCHED' }],
    })
  })
})
