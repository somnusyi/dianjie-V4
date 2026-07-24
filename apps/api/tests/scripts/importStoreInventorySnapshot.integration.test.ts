import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '@dianjie/db'
import { runInventorySnapshotImport } from '../../scripts/import-store-inventory-snapshot'

const suffix = `snapshot-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let tenantId = ''
let otherTenantId = ''
let storeId = ''
let supplierId = ''
let productId = ''
let pendingProductId = ''
let tempDir = ''

async function writeInventoryWorkbook(
  filename: string,
  rows: Array<{
    section: string
    name: string
    spec: string
    unitPrice: number
    unit: string
    quantity: number
    richTextUnit?: boolean
  }>,
) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sheet1')
  sheet.addRow(['岗位', '物品名称', '包装规格', '盘点单位金额', '盘点单位', '盘点数量', '盘点金额'])
  let total = 0
  for (const row of rows) {
    const amount = row.unitPrice * row.quantity
    total += amount
    const added = sheet.addRow([row.section, row.name, row.spec, row.unitPrice, row.unit, row.quantity, amount])
    if (row.richTextUnit) {
      added.getCell(5).value = {
        richText: [{ text: row.unit }, { text: '\n', font: { name: '微软雅黑', size: 11 } }],
      }
    }
  }
  // 真实门店模板把总金额放在标签上一行；导入器也兼容旧模板的标签同行总计。
  sheet.addRow([null, null, null, null, null, null, total])
  sheet.addRow(['合计金额', null, null, null, null, null, null])
  const target = path.join(tempDir, filename)
  await workbook.xlsx.writeFile(target)
  return target
}

describe('inventory snapshot import script (integration)', () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dianjie-snapshot-import-'))
    const [tenant, otherTenant] = await Promise.all([
      prisma.tenant.create({ data: { name: `盘点导入测试 ${suffix}`, slug: suffix } }),
      prisma.tenant.create({ data: { name: `盘点导入隔离 ${suffix}`, slug: `${suffix}-other` } }),
    ])
    tenantId = tenant.id
    otherTenantId = otherTenant.id
    const [store, supplier, otherSupplier] = await Promise.all([
      prisma.store.create({ data: { tenantId, no: `STORE-${suffix}`, name: '盘点导入测试门店' } }),
      prisma.supplier.create({ data: { tenantId, no: `SUP-${suffix}`, name: '盘点导入测试供应商' } }),
      prisma.supplier.create({ data: { tenantId: otherTenantId, no: `SUP-OTHER-${suffix}`, name: '其他租户供应商' } }),
    ])
    storeId = store.id
    supplierId = supplier.id
    const [currentProduct, pendingProduct] = await Promise.all([
      prisma.product.create({
        data: {
          tenantId, supplierId, code: `OYSTER-${suffix}`, name: '生蚝测试',
          spec: '18个/箱', unit: '箱', inventoryUnit: '个',
          inventoryUnitsPerPurchaseUnit: 18, unitConversionStatus: 'VERIFIED',
          price: 180, stock: 10,
        },
      }),
      prisma.product.create({
        data: {
          tenantId, supplierId, code: `SAUCE-${suffix}`, name: '待确认酱料',
          spec: '8袋/箱', unit: '箱', inventoryUnit: '箱',
          inventoryUnitsPerPurchaseUnit: 1, unitConversionStatus: 'VERIFIED',
          price: 80, stock: 10,
        },
      }),
    ])
    productId = currentProduct.id
    pendingProductId = pendingProduct.id
    await prisma.product.create({
      data: {
        tenantId: otherTenantId, supplierId: otherSupplier.id, code: `OYSTER-${suffix}`,
        name: '生蚝测试', spec: '18个/箱', unit: '箱', inventoryUnit: '个',
        inventoryUnitsPerPurchaseUnit: 18, unitConversionStatus: 'VERIFIED',
        price: 999, stock: 999,
      },
    })
  })

  afterAll(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
    if (tenantId) {
      await prisma.inventorySnapshotItem.deleteMany({ where: { snapshot: { tenantId } } })
      await prisma.inventorySnapshot.deleteMany({ where: { tenantId } })
      await prisma.product.deleteMany({ where: { tenantId } })
      await prisma.supplier.deleteMany({ where: { tenantId } })
      await prisma.store.deleteMany({ where: { tenantId } })
      await prisma.tenant.delete({ where: { id: tenantId } })
    }
    if (otherTenantId) {
      await prisma.product.deleteMany({ where: { tenantId: otherTenantId } })
      await prisma.supplier.deleteMany({ where: { tenantId: otherTenantId } })
      await prisma.tenant.delete({ where: { id: otherTenantId } })
    }
  })

  it('writes the current inventory unit atomically and keeps tenant selection exact', async () => {
    const source = await writeInventoryWorkbook('complete.xlsx', [{
      section: '海鲜岗',
      name: '生蚝测试',
      spec: '18个/箱',
      unitPrice: 180,
      unit: '箱',
      quantity: 2,
      richTextUnit: true,
    }])
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const result = await runInventorySnapshotImport([
        source,
        '--date=2026-07-22',
        `--tenant=${suffix}`,
        `--store-no=STORE-${suffix}`,
        '--commit',
        '--confirm=import-reviewed-inventory-snapshot',
      ])
      expect(result).toMatchObject({
        committed: true,
        matchedCount: 1,
        normalizationPendingCount: 0,
        canCommit: true,
      })
    } finally {
      log.mockRestore()
    }

    const snapshot = await prisma.inventorySnapshot.findUniqueOrThrow({
      where: {
        storeId_snapshotDate: {
          storeId,
          snapshotDate: new Date('2026-07-22T00:00:00.000Z'),
        },
      },
      include: { items: true },
    })
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0].productId).toBe(productId)
    expect(Number(snapshot.items[0].normalizedQuantity)).toBe(36)
    expect(snapshot.items[0].normalizedUnit).toBe('个')
    expect(Number(snapshot.items[0].normalizationFactor)).toBe(18)
  })

  it('blocks an incomplete replacement before deleting the existing baseline', async () => {
    const existing = await prisma.inventorySnapshot.create({
      data: {
        tenantId,
        storeId,
        snapshotDate: new Date('2026-07-23T00:00:00.000Z'),
        sourceFilename: 'existing-safe-baseline.xlsx',
        sourceHash: 'a'.repeat(64),
        totalValue: 80,
        itemCount: 1,
        nonzeroCount: 1,
        zeroCount: 0,
        matchedCount: 1,
        items: {
          create: {
            productId: pendingProductId,
            section: '调料岗',
            rawName: '待确认酱料',
            rawSpec: '8袋/箱',
            unit: '箱',
            quantity: 1,
            unitPrice: 80,
            amount: 80,
            normalizedQuantity: 1,
            normalizedUnit: '箱',
            normalizationFactor: 1,
            normalizationStatus: 'EXACT',
            sortOrder: 1,
          },
        },
      },
    })
    const source = await writeInventoryWorkbook('pending.xlsx', [{
      section: '调料岗',
      name: '待确认酱料',
      spec: '8袋/箱',
      unitPrice: 10,
      unit: '袋',
      quantity: 7,
    }])
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await expect(runInventorySnapshotImport([
        source,
        '--date=2026-07-23',
        `--tenant=${suffix}`,
        `--store-no=STORE-${suffix}`,
        '--commit',
        '--replace',
        '--confirm=import-reviewed-inventory-snapshot',
      ])).rejects.toThrow('盘点导入被门禁阻止')
    } finally {
      log.mockRestore()
    }

    const preserved = await prisma.inventorySnapshot.findUniqueOrThrow({ where: { id: existing.id } })
    expect(preserved.sourceFilename).toBe('existing-safe-baseline.xlsx')
    expect(await prisma.inventorySnapshot.count({
      where: { tenantId, storeId, snapshotDate: new Date('2026-07-23T00:00:00.000Z') },
    })).toBe(1)
  })
})
