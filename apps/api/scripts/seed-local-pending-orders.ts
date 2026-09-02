/** 本机沙盒专用：从已有真实订单结构生成可接单的 SUBMITTED 订单。 */
import { Prisma, prisma } from '@dianjie/db'
import { buildOrderSnapshot, lineAmount, snapshotHash } from '../src/services/purchaseOrderIntegrity'

const DATABASE_URL = process.env.DATABASE_URL || ''
const TENANT_SLUG = process.env.LOCAL_TENANT_SLUG || 'dianjie'
// 2 张合并成 1 个集合，再加 4 张单独订单，界面共 5 个接单入口。
const COUNT = 6

function assertLocalSandbox() {
  const url = new URL(DATABASE_URL)
  const database = decodeURIComponent(url.pathname.slice(1))
  if (
    process.env.NODE_ENV === 'production'
    || process.env.PREVIEW_MODE !== 'true'
    || !['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    || !database.includes('dianjie_v4_local')
  ) throw new Error('安全护栏：只允许在 localhost/dianjie_v4_local 预览库执行')
}

async function main() {
  assertLocalSandbox()
  const tenant = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } })
  if (!tenant) throw new Error(`本地租户不存在: ${TENANT_SLUG}`)

  // 只清理本脚本上一次创建且尚未操作的沙盒订单。
  const staleFixtures = await prisma.purchaseOrder.findMany({
    where: {
      tenantId: tenant.id,
      no: { startsWith: 'LOCAL-PO-' },
      idempotencyKey: { startsWith: 'local-pending:' },
      status: 'SUBMITTED',
    },
    select: { id: true },
  })
  const staleIds = staleFixtures.map(item => item.id)
  if (staleIds.length) {
    await prisma.$transaction([
      prisma.opLog.deleteMany({ where: { tenantId: tenant.id, entityType: 'PurchaseOrder', targetId: { in: staleIds } } }),
      prisma.purchaseOrderEvent.deleteMany({ where: { tenantId: tenant.id, purchaseOrderId: { in: staleIds } } }),
      prisma.purchaseOrder.deleteMany({ where: { tenantId: tenant.id, id: { in: staleIds }, status: 'SUBMITTED' } }),
    ])
  }

  const templates = await prisma.purchaseOrder.findMany({
    where: {
      tenantId: tenant.id,
      status: { in: ['COMPLETED', 'RECEIVED', 'DELIVERING'] },
      items: { some: { isActive: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: {
      store: true,
      supplier: true,
      createdBy: { select: { id: true, name: true, role: true } },
      items: {
        where: { isActive: true },
        orderBy: { id: 'asc' },
        include: { product: true },
      },
    },
    take: 20,
  })

  // 前两张共用同一边界形成集合；后四张使用不同门店，保持为独立接单入口。
  const groupTemplate = templates[0]
  if (!groupTemplate) throw new Error('本地库中没有可用订单模板')
  const standaloneTemplates = [] as typeof templates
  const usedStores = new Set([groupTemplate.storeId])
  for (const candidate of templates) {
    if (usedStores.has(candidate.storeId)) continue
    standaloneTemplates.push(candidate)
    usedStores.add(candidate.storeId)
    if (standaloneTemplates.length === 4) break
  }
  if (standaloneTemplates.length < 4) throw new Error('本地库中没有足够的不同门店订单模板')
  const selected = [groupTemplate, groupTemplate, ...standaloneTemplates]

  const batchId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const created = []
  for (let index = 0; index < COUNT; index += 1) {
    const template = selected[index]
    const sourceItems = template.items.slice(0, 3)
    if (!sourceItems.length) throw new Error(`模板 ${template.no} 没有有效商品`)
    const expectedDate = new Date(Date.UTC(2026, 8, index < 2 ? 3 : 3 + index))
    const no = `LOCAL-PO-${batchId}-${String(index + 1).padStart(2, '0')}`
    const note = index < 2
      ? `【本地测试】待接单集合 ${index + 1}/2（源模板 ${template.no}）`
      : `【本地测试】独立待接单 ${index - 1}/4（源模板 ${template.no}）`

    const result = await prisma.$transaction(async tx => {
      const lines = sourceItems.map(item => {
        const quantity = new Prisma.Decimal(item.originalQuantity ?? item.quantity)
        const unitPrice = new Prisma.Decimal(item.originalUnitPrice ?? item.unitPrice)
        const amount = lineAmount(quantity, unitPrice)
        return {
          productId: item.productId,
          quantity,
          originalQuantity: quantity,
          unitPrice,
          originalUnitPrice: unitPrice,
          amount,
          originalAmount: amount,
          purchaseUnitSnapshot: item.purchaseUnitSnapshot,
          inventoryUnitSnapshot: item.inventoryUnitSnapshot,
          orderUnitSnapshot: item.orderUnitSnapshot,
          costUnitSnapshot: item.costUnitSnapshot,
          unitConversionStatusSnapshot: item.unitConversionStatusSnapshot,
          inventoryUnitsPerPurchaseUnitSnapshot: item.inventoryUnitsPerPurchaseUnitSnapshot,
          inventoryUnitsPerOrderUnitSnapshot: item.inventoryUnitsPerOrderUnitSnapshot,
          inventoryUnitsPerCostUnitSnapshot: item.inventoryUnitsPerCostUnitSnapshot,
          lineOrigin: 'ORIGINAL' as const,
          isActive: true,
        }
      })
      const totalAmount = lines.reduce((sum, line) => sum.add(line.amount), new Prisma.Decimal(0))
      const submittedAt = new Date()
      const order = await tx.purchaseOrder.create({
        data: {
          tenantId: tenant.id,
          no,
          storeId: template.storeId,
          supplierId: template.supplierId,
          expectedDate,
          totalAmount,
          originalTotalAmount: totalAmount,
          currentOrderAmount: totalAmount,
          status: 'SUBMITTED',
          note,
          submittedAt,
          currentRevisionNo: 0,
          idempotencyKey: `local-pending:${batchId}:${index + 1}`,
          createdById: template.createdById,
          items: { create: lines },
        },
        include: {
          store: true,
          supplier: true,
          createdBy: { select: { id: true, name: true, role: true } },
          items: { include: { product: true } },
        },
      })
      const snapshot = buildOrderSnapshot(order, 'original')
      const hash = snapshotHash(snapshot)
      await tx.purchaseOrder.update({
        where: { id: order.id },
        data: { submittedSnapshot: snapshot as any, submittedSnapshotHash: hash },
      })
      await tx.purchaseOrderEvent.createMany({
        data: [
          {
            tenantId: tenant.id,
            purchaseOrderId: order.id,
            eventType: 'CREATED',
            actorId: template.createdById,
            actorRole: template.createdBy.role || null,
            toStatus: 'SUBMITTED',
            metadata: { localFixture: true, sourceTemplateNo: template.no },
          },
          {
            tenantId: tenant.id,
            purchaseOrderId: order.id,
            eventType: 'SUBMITTED',
            actorId: template.createdById,
            actorRole: template.createdBy.role || null,
            toStatus: 'SUBMITTED',
            metadata: { localFixture: true, snapshotHash: hash },
          },
        ],
      })
      await tx.opLog.create({
        data: {
          tenantId: tenant.id,
          userId: template.createdById,
          role: template.createdBy.role || null,
          action: `本地沙盒生成待接单 ${no}`,
          target: no,
          entityType: 'PurchaseOrder',
          targetId: order.id,
          metadata: { localFixture: true, sourceTemplateNo: template.no },
        },
      })
      return { id: order.id, no, store: order.store.name, supplier: order.supplier.name, itemCount: order.items.length, totalAmount: totalAmount.toFixed(2) }
    })
    created.push(result)
  }

  console.log(JSON.stringify({ ok: true, batchId, count: created.length, orders: created }))
}

main()
  .catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
