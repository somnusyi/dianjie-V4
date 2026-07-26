import { describe, expect, it } from 'vitest'
import { auditSupplierSupplyChain } from '../../src/services/supplyChainAudit'

type Row = Record<string, any>

function matchValue(actual: any, expected: any): boolean {
  if (expected === null || expected === undefined) return actual === expected
  if (expected instanceof Date) {
    const d = actual instanceof Date ? actual : new Date(actual)
    return d.getTime() <= expected.getTime()
  }
  if (typeof expected === 'object' && !Array.isArray(expected)) {
    if ('not' in expected) return actual !== expected.not
    if ('in' in expected) return Array.isArray(expected.in) && expected.in.includes(actual)
    if ('gte' in expected) {
      const a = actual instanceof Date ? actual.getTime() : Number(actual)
      const b = expected.gte instanceof Date ? expected.gte.getTime() : Number(expected.gte)
      return a >= b
    }
    if ('some' in expected) {
      return Array.isArray(actual) && actual.some((item: any) => matchWhere(item, expected.some))
    }
    return false
  }
  return actual === expected
}

function matchWhere(record: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue
    if (typeof cond === 'object' && cond !== null && !Array.isArray(cond)
      && !('not' in cond) && !('in' in cond) && !('gte' in cond) && !('some' in cond)
      && !(cond instanceof Date)) {
      const nested = record[key]
      if (Array.isArray(nested)) {
        if (!nested.some((item: Row) => matchWhere(item, cond as Row))) return false
      } else if (nested && typeof nested === 'object') {
        if (!matchWhere(nested, cond as Row)) return false
      } else {
        return false
      }
      continue
    }
    if (!matchValue(record[key], cond)) return false
  }
  return true
}

function applySelect(record: Row, select: Row | undefined): Row {
  if (!select) return { ...record }
  const result: Row = {}
  for (const [key, include] of Object.entries(select)) {
    if (include) result[key] = record[key]
  }
  return result
}

function applyInclude(record: Row, include: Row | undefined): Row {
  if (!include) return { ...record }
  const result = { ...record }
  for (const [key, spec] of Object.entries(include)) {
    if (spec === true) {
      result[key] = record[key] ?? []
    }
  }
  return result
}

function makeModel(rows: Row[]) {
  return {
    findFirst: async (args: { where: Row; select?: Row } | any = { where: {} }) => {
      const found = rows.find(r => matchWhere(r, args.where || {}))
      return found ? applySelect(found, args.select) : null
    },
    findMany: (args: { where?: Row; select?: Row; include?: Row; orderBy?: any; take?: number } | any = {}) => {
      let result = rows.filter(r => matchWhere(r, args.where || {}))
      result = result.map(r => {
        let mapped = applyInclude(r, args.include)
        mapped = applySelect(mapped, args.select)
        return mapped
      })
      if (args.take) result = result.slice(0, args.take)
      return Promise.resolve(result)
    },
  }
}

function buildDb(data: {
  suppliers?: Row[]
  products?: Row[]
  reservations?: Row[]
  movements?: Row[]
  batches?: Row[]
  deliveries?: Row[]
  receipts?: Row[]
  lossClaims?: Row[]
  warehouses?: Row[]
  warehouseStocks?: Row[]
}) {
  return {
    supplier: makeModel(data.suppliers ?? []),
    product: makeModel(data.products ?? []),
    supplierStockReservation: makeModel(data.reservations ?? []),
    supplierStockMovement: makeModel(data.movements ?? []),
    supplierStockBatch: makeModel(data.batches ?? []),
    deliveryOrder: makeModel(data.deliveries ?? []),
    receipt: makeModel(data.receipts ?? []),
    lossClaim: makeModel(data.lossClaims ?? []),
    warehouse: makeModel(data.warehouses ?? []),
    warehouseStock: makeModel(data.warehouseStocks ?? []),
  } as any
}

const WH_ID = 'wh-tenant-a-real'

const baseSupplier = { id: 'sup-1', tenantId: 'tenant-a', sourceType: null, inventoryMode: 'STRICT' as const }
const baseProducts = [
  { id: 'prod-1', tenantId: 'tenant-a', supplierId: 'sup-1', code: 'P001', name: '香菇', stock: 10.000 },
  { id: 'prod-2', tenantId: 'tenant-a', supplierId: 'sup-1', code: 'P002', name: '竹笋', stock: 5.500 },
]
const baseWarehouses = [
  { id: WH_ID, tenantId: 'tenant-a', code: 'default', name: '默认仓', isDefault: true, isActive: true },
]

function baseDb(overrides: {
  supplier?: Row
  products?: Row[]
  batches?: Row[]
  warehouses?: Row[]
  warehouseStocks?: Row[]
} = {}) {
  return buildDb({
    suppliers: [overrides.supplier ?? baseSupplier],
    products: overrides.products ?? baseProducts,
    batches: overrides.batches ?? [],
    warehouses: overrides.warehouses ?? baseWarehouses,
    warehouseStocks: overrides.warehouseStocks ?? [
      { id: 'ws-1', tenantId: 'tenant-a', warehouseId: WH_ID, productId: 'prod-1', physicalQty: 10.000, isActive: true },
      { id: 'ws-2', tenantId: 'tenant-a', warehouseId: WH_ID, productId: 'prod-2', physicalQty: 5.500, isActive: true },
    ],
    reservations: [],
    movements: [],
    deliveries: [],
    receipts: [],
    lossClaims: [],
  })
}

describe('supplyChainAudit — warehouse stock dual-source check', () => {
  describe('non-STRICT inventoryMode', () => {
    it('skips warehouse stock checks entirely for NOT_TRACKED supplier', async () => {
      const db = baseDb({ supplier: { ...baseSupplier, inventoryMode: 'NOT_TRACKED' } })
      const result = await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)
      expect(result.issues).toEqual([])
      expect(result.summary.warehouseId).toBeUndefined()
      expect(result.summary.warehouseStockRowsChecked).toBeUndefined()
    })

    it('does not query warehouse or warehouseStock for NOT_TRACKED supplier', async () => {
      const whFindFirstCalls: any[] = []
      const wsFindManyCalls: any[] = []
      const db = baseDb({ supplier: { ...baseSupplier, inventoryMode: 'NOT_TRACKED' } })
      const origWhFirst = db.warehouse.findFirst
      const origWsMany = db.warehouseStock.findMany
      db.warehouse.findFirst = async (args: any) => { whFindFirstCalls.push(args); return origWhFirst(args) }
      db.warehouseStock.findMany = (args: any) => { wsFindManyCalls.push(args); return origWsMany(args) }

      await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)
      expect(whFindFirstCalls).toEqual([])
      expect(wsFindManyCalls).toEqual([])
    })
  })

  describe('STRICT — fail closed', () => {
    it('throws when tenant has no enabled default warehouse', async () => {
      const db = baseDb({ warehouses: [] })
      await expect(
        auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db),
      ).rejects.toMatchObject({ message: '当前租户不存在启用的默认仓', statusCode: 404 })
    })

    it('throws when default warehouse exists but is disabled', async () => {
      const db = baseDb({
        warehouses: [{ id: 'wh-disabled', tenantId: 'tenant-a', code: 'default', name: '默认仓', isDefault: true, isActive: false }],
      })
      await expect(
        auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db),
      ).rejects.toMatchObject({ statusCode: 404 })
    })
  })

  describe('STRICT — warehouse stock checks', () => {
    it('no issues when all WarehouseStock rows match Product.stock exactly', async () => {
      const db = baseDb()
      const result = await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)
      const wsIssues = result.issues.filter(i => i.entityType === 'WarehouseStock')
      expect(wsIssues).toEqual([])
      expect(result.summary.warehouseId).toBe(WH_ID)
      expect(result.summary.warehouseStockRowsChecked).toBe(2)
    })

    it('reports WAREHOUSE_STOCK_MISSING when no WarehouseStock row exists for a product', async () => {
      const db = baseDb({
        warehouseStocks: [
          { id: 'ws-1', tenantId: 'tenant-a', warehouseId: WH_ID, productId: 'prod-1', physicalQty: 10.000, isActive: true },
        ],
      })
      const result = await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)
      const missing = result.issues.filter(i => i.code === 'WAREHOUSE_STOCK_MISSING')
      expect(missing).toHaveLength(1)
      expect(missing[0].entityId).toBe('prod-2')
      expect(missing[0].entityType).toBe('WarehouseStock')
      expect(missing[0].severity).toBe('ERROR')
      expect(missing[0].detail).toContain(WH_ID)
      expect(result.summary.warehouseStockRowsChecked).toBe(1)
    })

    it('reports WAREHOUSE_STOCK_INACTIVE when the row exists but isActive is false', async () => {
      const db = baseDb({
        warehouseStocks: [
          { id: 'ws-1', tenantId: 'tenant-a', warehouseId: WH_ID, productId: 'prod-1', physicalQty: 10.000, isActive: true },
          { id: 'ws-2', tenantId: 'tenant-a', warehouseId: WH_ID, productId: 'prod-2', physicalQty: 5.500, isActive: false },
        ],
      })
      const result = await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)
      const inactive = result.issues.filter(i => i.code === 'WAREHOUSE_STOCK_INACTIVE')
      expect(inactive).toHaveLength(1)
      expect(inactive[0].entityId).toBe('ws-2')
      expect(inactive[0].entityType).toBe('WarehouseStock')
      expect(inactive[0].detail).toContain(WH_ID)
    })

    it('no mismatch when difference is within 0.001 tolerance', async () => {
      const db = baseDb({
        warehouseStocks: [
          { id: 'ws-1', tenantId: 'tenant-a', warehouseId: WH_ID, productId: 'prod-1', physicalQty: 10.001, isActive: true },
          { id: 'ws-2', tenantId: 'tenant-a', warehouseId: WH_ID, productId: 'prod-2', physicalQty: 5.500, isActive: true },
        ],
      })
      const result = await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)
      const mismatch = result.issues.filter(i => i.code === 'WAREHOUSE_STOCK_PRODUCT_MISMATCH')
      expect(mismatch).toEqual([])
    })

    it('reports WAREHOUSE_STOCK_PRODUCT_MISMATCH when difference exceeds 0.001', async () => {
      const db = baseDb({
        warehouseStocks: [
          { id: 'ws-1', tenantId: 'tenant-a', warehouseId: WH_ID, productId: 'prod-1', physicalQty: 10.500, isActive: true },
          { id: 'ws-2', tenantId: 'tenant-a', warehouseId: WH_ID, productId: 'prod-2', physicalQty: 5.500, isActive: true },
        ],
      })
      const result = await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)
      const mismatch = result.issues.filter(i => i.code === 'WAREHOUSE_STOCK_PRODUCT_MISMATCH')
      expect(mismatch).toHaveLength(1)
      expect(mismatch[0].entityId).toBe('ws-1')
      expect(mismatch[0].entityType).toBe('WarehouseStock')
      expect(mismatch[0].detail).toContain(WH_ID)
      expect(mismatch[0].detail).toContain('10.500')
      expect(mismatch[0].detail).toContain('10.000')
    })

    it('reports mismatch when difference is exactly 0.002 (just beyond tolerance)', async () => {
      const db = baseDb({
        warehouseStocks: [
          { id: 'ws-1', tenantId: 'tenant-a', warehouseId: WH_ID, productId: 'prod-1', physicalQty: 10.002, isActive: true },
          { id: 'ws-2', tenantId: 'tenant-a', warehouseId: WH_ID, productId: 'prod-2', physicalQty: 5.500, isActive: true },
        ],
      })
      const result = await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)
      const mismatch = result.issues.filter(i => i.code === 'WAREHOUSE_STOCK_PRODUCT_MISMATCH')
      expect(mismatch).toHaveLength(1)
    })
  })

  describe('tenant + warehouse + product scope', () => {
    it('scopes reservations, movements and batches to the same resolved default warehouse', async () => {
      const seen: Record<string, any> = {}
      const db = baseDb()
      for (const modelName of ['supplierStockReservation', 'supplierStockMovement', 'supplierStockBatch'] as const) {
        const original = db[modelName].findMany
        db[modelName].findMany = (args: any) => {
          seen[modelName] = args.where
          return original(args)
        }
      }

      await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)

      expect(seen.supplierStockReservation).toMatchObject({
        tenantId: 'tenant-a',
        supplierId: 'sup-1',
        warehouseId: WH_ID,
        status: 'ACTIVE',
      })
      expect(seen.supplierStockMovement).toEqual({
        tenantId: 'tenant-a',
        supplierId: 'sup-1',
        warehouseId: WH_ID,
      })
      expect(seen.supplierStockBatch).toEqual({
        tenantId: 'tenant-a',
        supplierId: 'sup-1',
        warehouseId: WH_ID,
      })
    })

    it('only queries WarehouseStock scoped to the resolved warehouseId and supplier products', async () => {
      const wsFindManyArgs: any[] = []
      const db = baseDb()
      const origFindMany = db.warehouseStock.findMany
      db.warehouseStock.findMany = (args: any) => { wsFindManyArgs.push(args); return origFindMany(args) }

      await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)

      expect(wsFindManyArgs).toHaveLength(1)
      const where = wsFindManyArgs[0].where
      expect(where.tenantId).toBe('tenant-a')
      expect(where.warehouseId).toBe(WH_ID)
      expect(where.productId).toEqual({ in: ['prod-1', 'prod-2'] })
    })

    it('does not see WarehouseStock rows from another tenant', async () => {
      const db = baseDb({
        warehouseStocks: [
          { id: 'ws-other', tenantId: 'tenant-b', warehouseId: WH_ID, productId: 'prod-1', physicalQty: 99.000, isActive: true },
        ],
      })
      const result = await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)
      const wsIssues = result.issues.filter(i => i.entityType === 'WarehouseStock')
      expect(wsIssues.filter(i => i.code === 'WAREHOUSE_STOCK_PRODUCT_MISMATCH')).toEqual([])
      const missing = wsIssues.filter(i => i.code === 'WAREHOUSE_STOCK_MISSING')
      expect(missing).toHaveLength(2)
    })

    it('does not see WarehouseStock rows from a different warehouse', async () => {
      const db = baseDb({
        warehouseStocks: [
          { id: 'ws-wrong-wh', tenantId: 'tenant-a', warehouseId: 'wh-other', productId: 'prod-1', physicalQty: 10.000, isActive: true },
          { id: 'ws-wrong-wh-2', tenantId: 'tenant-a', warehouseId: 'wh-other', productId: 'prod-2', physicalQty: 5.500, isActive: true },
        ],
      })
      const result = await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)
      const missing = result.issues.filter(i => i.code === 'WAREHOUSE_STOCK_MISSING')
      expect(missing).toHaveLength(2)
    })
  })

  describe('read-only — no auto-create or auto-update', () => {
    it('does not call create, update, upsert, or delete on warehouseStock', async () => {
      const calls: string[] = []
      const db = baseDb({
        warehouseStocks: [],
      })
      db.warehouseStock = {
        ...db.warehouseStock,
        create: (args: any) => { calls.push('create'); return Promise.resolve(args) },
        update: (args: any) => { calls.push('update'); return Promise.resolve(args) },
        upsert: (args: any) => { calls.push('upsert'); return Promise.resolve(args) },
        delete: (args: any) => { calls.push('delete'); return Promise.resolve(args) },
        deleteMany: (args: any) => { calls.push('deleteMany'); return Promise.resolve({ count: 0 }) },
      } as any

      await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)
      expect(calls).toEqual([])
    })
  })

  describe('existing audit issues still reported', () => {
    it('still reports NEGATIVE_BATCH_BALANCE in STRICT mode alongside warehouse issues', async () => {
      const db = baseDb({
        warehouseStocks: [
          { id: 'ws-1', tenantId: 'tenant-a', warehouseId: WH_ID, productId: 'prod-1', physicalQty: 10.000, isActive: true },
          { id: 'ws-2', tenantId: 'tenant-a', warehouseId: WH_ID, productId: 'prod-2', physicalQty: 5.500, isActive: true },
        ],
        batches: [
          { id: 'batch-1', tenantId: 'tenant-a', warehouseId: WH_ID, supplierId: 'sup-1', productId: 'prod-1', batchNo: 'B001', initialQty: 10, remainingQty: -1 },
        ],
      })
      const result = await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)
      expect(result.issues.some(i => i.code === 'NEGATIVE_BATCH_BALANCE')).toBe(true)
    })

    it('still reports STOCK_BATCH_BALANCE_MISMATCH in STRICT mode', async () => {
      const db = baseDb({
        batches: [
          { id: 'batch-1', tenantId: 'tenant-a', warehouseId: WH_ID, supplierId: 'sup-1', productId: 'prod-1', batchNo: 'B001', initialQty: 10, remainingQty: 8 },
        ],
      })
      const result = await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)
      expect(result.issues.some(i => i.code === 'STOCK_BATCH_BALANCE_MISMATCH')).toBe(true)
    })
  })

  describe('summary reports real warehouseId and row count', () => {
    it('includes warehouseId and warehouseStockRowsChecked in STRICT summary', async () => {
      const db = baseDb()
      const result = await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)
      expect(result.summary.warehouseId).toBe(WH_ID)
      expect(result.summary.warehouseStockRowsChecked).toBe(2)
    })

    it('omits warehouseId and warehouseStockRowsChecked in NOT_TRACKED summary', async () => {
      const db = baseDb({ supplier: { ...baseSupplier, inventoryMode: 'NOT_TRACKED' } })
      const result = await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)
      expect(result.summary).not.toHaveProperty('warehouseId')
      expect(result.summary).not.toHaveProperty('warehouseStockRowsChecked')
    })
  })

  describe('detail contains real warehouseId but no sensitive info', () => {
    it('issue detail contains the real warehouseId', async () => {
      const db = baseDb({ warehouseStocks: [] })
      const result = await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)
      for (const issue of result.issues.filter(i => i.entityType === 'WarehouseStock')) {
        expect(issue.detail).toContain(WH_ID)
      }
    })

    it('issue detail does not contain tenantId', async () => {
      const safeWhId = 'wh-primary'
      const db = baseDb({
        warehouses: [{ id: safeWhId, tenantId: 'tenant-a', code: 'default', name: '默认仓', isDefault: true, isActive: true }],
        warehouseStocks: [],
      })
      const result = await auditSupplierSupplyChain({ tenantId: 'tenant-a', supplierId: 'sup-1' }, db)
      for (const issue of result.issues.filter(i => i.entityType === 'WarehouseStock')) {
        expect(issue.detail).not.toContain('tenant-a')
        expect(issue.detail).toContain(safeWhId)
      }
    })
  })
})
