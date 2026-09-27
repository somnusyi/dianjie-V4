import { prisma } from '@dianjie/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureWarehouseDoc, normalizeWarehouseDocAttachments } from '../../src/services/warehouseDocs'

const suffix = `warehouse-doc-attachments-${Date.now()}`
const shortSuffix = suffix.slice(-13)
let tenantId = ''
let warehouseId = ''

describe('warehouse document supplier delivery attachments (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `随货单据测试 ${suffix}`, slug: suffix } })
    tenantId = tenant.id
    warehouseId = (await prisma.warehouse.findFirstOrThrow({ where: { tenantId, isDefault: true } })).id
  })

  afterAll(async () => {
    if (tenantId) {
      await prisma.warehouseDocLog.deleteMany({ where: { tenantId } })
      await prisma.warehouseDocLine.deleteMany({ where: { tenantId } })
      await prisma.warehouseDoc.deleteMany({ where: { tenantId } })
      await prisma.warehouse.deleteMany({ where: { tenantId } })
      await prisma.tenant.deleteMany({ where: { id: tenantId } })
    }
    await prisma.$disconnect()
  })

  it('persists durable metadata once and preserves first-write idempotency', async () => {
    const attachments = normalizeWarehouseDocAttachments(tenantId, [{
      key: `warehouse-docs/${tenantId}/delivery-note.pdf`,
      name: '供应商送货单.pdf',
      mime: 'application/pdf',
      size: 2048,
    }])
    const input = {
      tenantId,
      userId: 'attachment-test-user',
      type: 'MANUAL_INBOUND' as const,
      warehouseId,
      effectiveAt: new Date('2026-09-27T02:00:00.000Z'),
      idempotencyKey: `attachment-${suffix}`,
      supplierName: '附件测试供应商',
      attachments,
      lines: [{
        productId: 'attachment-product', productName: '附件测试商品', quantity: 1, unit: '箱', unitPrice: 10,
        amount: 10, inventoryQuantity: 10, inventoryUnit: '件',
      }],
    }
    const first = await ensureWarehouseDoc(input)
    expect(first.created).toBe(true)
    expect(first.doc.attachments).toEqual(attachments)

    const replay = await ensureWarehouseDoc({
      ...input,
      attachments: [{ ...attachments[0], name: '重试时不同名称.pdf' }],
    })
    expect(replay.created).toBe(false)
    expect(replay.doc.id).toBe(first.doc.id)
    expect(replay.doc.attachments).toEqual(attachments)
    expect(await prisma.warehouseDoc.count({ where: { tenantId, idempotencyKey: input.idempotencyKey } })).toBe(1)
  })

  it('returns one winner for concurrent calls with the same idempotency key', async () => {
    const idempotencyKey = `attachment-concurrent-${suffix}`
    const calls = Array.from({ length: 8 }, () => ensureWarehouseDoc({
      tenantId,
      userId: 'attachment-test-user',
      type: 'MANUAL_INBOUND',
      warehouseId,
      effectiveAt: new Date('2026-09-27T03:00:00.000Z'),
      idempotencyKey,
      supplierName: '并发测试供应商',
      attachments: normalizeWarehouseDocAttachments(tenantId, [{
        key: `warehouse-docs/${tenantId}/concurrent.pdf`,
        name: '并发送货单.pdf',
        mime: 'application/pdf',
        size: 1024,
      }]),
      lines: [{
        productId: 'concurrent-product', productName: '并发测试商品', quantity: 1, unit: '箱', unitPrice: 10,
        amount: 10, inventoryQuantity: 10, inventoryUnit: '件',
      }],
    }))

    const results = await Promise.all(calls)
    expect(new Set(results.map(result => result.doc.id)).size).toBe(1)
    expect(results.filter(result => result.created)).toHaveLength(1)
    expect(await prisma.warehouseDoc.count({ where: { tenantId, type: 'MANUAL_INBOUND', idempotencyKey } })).toBe(1)
  })

  it('treats existing null metadata as empty and rejects cross-purpose or cross-tenant keys', async () => {
    const legacy = await prisma.warehouseDoc.create({ data: {
      tenantId, docNo: `RK-LEGACY-${shortSuffix}`, type: 'MANUAL_INBOUND', warehouseId,
      effectiveAt: new Date('2026-09-26T02:00:00.000Z'), idempotencyKey: `legacy-${suffix}`,
    } })
    expect(legacy.attachments).toBeNull()
    expect(normalizeWarehouseDocAttachments(tenantId, legacy.attachments)).toEqual([])

    for (const key of [`loss-claims/${tenantId}/proof.jpg`, 'warehouse-docs/another-tenant/delivery.pdf']) {
      expect(() => normalizeWarehouseDocAttachments(tenantId, [{ key, name: '错误.pdf', mime: 'application/pdf', size: 100 }]))
        .toThrow('不属于当前租户')
    }
  })
})
