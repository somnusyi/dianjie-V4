import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { isStoreScoped, resolveActiveStore } from '../lib/auth-scope'
import { hasInternalSupplyChainCapability } from '../lib/internal-supply-chain-access'
import { businessNoFloor, nextBusinessNo } from '../services/purchaseOrderIntegrity'
import { estimatedStoreInventory } from '../services/storeInventory'
import { revalueStoreConsumptionCosts } from '../services/inventoryCosting'
import { fireAndForget as notify } from '../services/notify'
import { signOssKey } from './upload'
import { productInventoryUnitCost } from '../services/unitContractGuard'

const VIEW_ROLES = new Set(['MANAGER', 'KITCHEN_LEAD', 'CHEF', 'CHEF_DIRECTOR', 'ADMIN', 'SUPER_ADMIN', 'BOSS'])
const WRITE_ROLES = new Set(['MANAGER', 'KITCHEN_LEAD', 'CHEF', 'CHEF_DIRECTOR', 'ADMIN', 'SUPER_ADMIN'])
const ACTIVE_STATUSES = ['DRAFT', 'COUNTING', 'REVIEWING'] as const
const EVIDENCE_RATE_THRESHOLD = new Prisma.Decimal('0.05')
const EVIDENCE_AMOUNT_THRESHOLD = new Prisma.Decimal('200')

function canViewInventoryCounts(role: string | undefined | null) {
  return Boolean(role && (
    VIEW_ROLES.has(role)
    || hasInternalSupplyChainCapability(role, 'inventory.read')
  ))
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
const createSchema = z.object({
  storeId: z.string().trim().min(1).optional(),
  countDate: dateSchema,
  note: z.string().trim().max(500).optional(),
}).strict()
const saveSchema = z.object({
  rowVersion: z.number().int().nonnegative(),
  items: z.array(z.object({
    id: z.string().min(1),
    countedQuantity: z.number().nonnegative().max(100_000_000).refine(value => new Prisma.Decimal(value).decimalPlaces() <= 6, '实盘数量最多 6 位小数'),
    reasonCode: z.string().trim().max(40).optional().nullable(),
    reasonNote: z.string().trim().max(500).optional().nullable(),
    evidenceKeys: z.array(z.string().trim().min(1).max(500)).max(6).optional(),
  }).strict()).min(1).max(1000),
}).strict()
const versionSchema = z.object({ rowVersion: z.number().int().nonnegative() }).strict()
const reverseSchema = z.object({
  rowVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(4, '冲销原因至少 4 个字').max(500),
}).strict()
const cancelSchema = z.object({
  rowVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(2, '取消原因至少 2 个字').max(500),
}).strict()

function strictDate(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw Object.assign(new Error('盘点日期无效'), { statusCode: 400 })
  }
  return parsed
}

function chinaToday() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

async function resolveStore(user: any, requestedStoreId?: string | null) {
  const storeId = resolveActiveStore(user, requestedStoreId) ?? user.storeId // 越权抛 403（多店集合校验）
  if (!storeId) throw Object.assign(new Error('当前账号未绑定或未选择门店'), { statusCode: 400 })
  const store = await prisma.store.findFirst({
    where: { id: storeId, tenantId: user.tenantId, status: 'ENABLED' },
    select: { id: true, no: true, name: true },
  })
  if (!store) throw Object.assign(new Error('门店不存在、已停用或不属于当前租户'), { statusCode: 404 })
  return store
}

function publicItem(item: any) {
  return {
    ...item,
    bookQuantity: Number(item.bookQuantity),
    countedQuantity: item.countedQuantity == null ? null : Number(item.countedQuantity),
    averageUnitCost: Number(item.averageUnitCost),
    differenceQuantity: item.differenceQuantity == null ? null : Number(item.differenceQuantity),
    differenceAmount: item.differenceAmount == null ? null : Number(item.differenceAmount),
    evidenceUrls: (item.evidenceKeys || []).map((key: string) => signOssKey(key)).filter(Boolean),
  }
}

function publicCount(row: any, includeItems = false) {
  return {
    ...row,
    totalBookValue: Number(row.totalBookValue),
    totalCountedValue: Number(row.totalCountedValue),
    totalDifferenceValue: Number(row.totalDifferenceValue),
    countDate: row.countDate.toISOString().slice(0, 10),
    items: includeItems ? (row.items || []).map(publicItem) : undefined,
  }
}

function differenceValues(item: { bookQuantity: Prisma.Decimal; countedQuantity: Prisma.Decimal; averageUnitCost: Prisma.Decimal }) {
  const quantity = item.countedQuantity.minus(item.bookQuantity)
  return { quantity, amount: quantity.mul(item.averageUnitCost) }
}

function requiresEvidence(bookQuantity: Prisma.Decimal, differenceQuantity: Prisma.Decimal, differenceAmount: Prisma.Decimal) {
  const rate = bookQuantity.abs().gt(0)
    ? differenceQuantity.abs().div(bookQuantity.abs())
    : (differenceQuantity.abs().gt(0) ? new Prisma.Decimal(1) : new Prisma.Decimal(0))
  return rate.gt(EVIDENCE_RATE_THRESHOLD) || differenceAmount.abs().gt(EVIDENCE_AMOUNT_THRESHOLD)
}

async function serializableWithRetry<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  timeout = 15_000,
): Promise<T> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout,
      })
    } catch (error: any) {
      if (error?.code !== 'P2034' || attempt === 4) throw error
    }
  }
  throw new Error('事务重试失败')
}

async function loadCount(id: string, tenantId: string) {
  return prisma.inventoryCount.findFirst({
    where: { id, tenantId },
    include: {
      store: { select: { id: true, no: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      submittedBy: { select: { id: true, name: true } },
      confirmedBy: { select: { id: true, name: true } },
      reversedBy: { select: { id: true, name: true } },
      items: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
    },
  })
}

export const inventoryCountRoutes: FastifyPluginAsync = async app => {
  const auth = { preHandler: [(app as any).authenticate] }

  app.get('/', auth, async (req: any, reply: any) => {
    if (!canViewInventoryCounts(req.user.role)) return reply.status(403).send({ error: '无权查看盘点单' })
    const query = z.object({
      storeId: z.string().optional(),
      status: z.enum(['DRAFT', 'COUNTING', 'REVIEWING', 'CONFIRMED', 'CANCELLED', 'REVERSED']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }).safeParse(req.query || {})
    if (!query.success) return reply.status(400).send({ error: query.error.issues[0].message })
    try {
      const store = isStoreScoped(req.user.role) || query.data.storeId
        ? await resolveStore(req.user, query.data.storeId)
        : null
      const rows = await prisma.inventoryCount.findMany({
        where: {
          tenantId: req.user.tenantId,
          ...(store ? { storeId: store.id } : {}),
          ...(query.data.status ? { status: query.data.status } : {}),
        },
        include: { store: { select: { id: true, no: true, name: true } } },
        orderBy: [{ countDate: 'desc' }, { revision: 'desc' }, { createdAt: 'desc' }],
        take: query.data.limit,
      })
      const countRows = rows.map(row => ({ ...publicCount(row), recordType: 'ONLINE_COUNT' as const }))
      if (query.data.status) return countRows

      // 早期 Excel/脚本导入的实物盘点只生成 InventorySnapshot，没有在线盘点单。
      // 将这些未关联快照补进历史列表，避免“最近基准存在但盘点历史为空”。
      const linked = await prisma.inventoryCount.findMany({
        where: {
          tenantId: req.user.tenantId,
          ...(store ? { storeId: store.id } : {}),
          snapshotId: { not: null },
        },
        select: { snapshotId: true },
      })
      const linkedSnapshotIds = linked.map(row => row.snapshotId!).filter(Boolean)
      const importedSnapshots = await prisma.inventorySnapshot.findMany({
        where: {
          tenantId: req.user.tenantId,
          ...(store ? { storeId: store.id } : {}),
          ...(linkedSnapshotIds.length > 0 ? { id: { notIn: linkedSnapshotIds } } : {}),
        },
        include: { store: { select: { id: true, no: true, name: true } } },
        orderBy: [{ snapshotDate: 'desc' }, { createdAt: 'desc' }],
        take: query.data.limit,
      })
      const baselineRows = importedSnapshots.map(snapshot => ({
        id: snapshot.id,
        recordType: 'IMPORTED_BASELINE' as const,
        no: '历史盘点基准',
        countDate: snapshot.snapshotDate.toISOString().slice(0, 10),
        revision: 1,
        status: 'BASELINE',
        itemCount: snapshot.itemCount,
        countedCount: snapshot.itemCount,
        differenceCount: 0,
        totalBookValue: Number(snapshot.totalValue),
        totalCountedValue: Number(snapshot.totalValue),
        totalDifferenceValue: 0,
        rowVersion: 0,
        store: snapshot.store,
        sourceFilename: snapshot.sourceFilename,
        createdAt: snapshot.createdAt,
      }))
      return [...countRows, ...baselineRows]
        .sort((a, b) => b.countDate.localeCompare(a.countDate) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, query.data.limit)
    } catch (error: any) {
      return reply.status(error.statusCode || 400).send({ error: error.message })
    }
  })

  app.post('/', auth, async (req: any, reply: any) => {
    if (!WRITE_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权创建盘点单' })
    const body = createSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })
    try {
      const store = await resolveStore(req.user, body.data.storeId)
      const countDate = strictDate(body.data.countDate)
      if (body.data.countDate > chinaToday()) return reply.status(400).send({ error: '不能创建未来日期的盘点单' })
      const newerBaseline = await prisma.inventorySnapshot.findFirst({
        where: { tenantId: req.user.tenantId, storeId: store.id, snapshotDate: { gt: countDate } },
        select: { snapshotDate: true }, orderBy: { snapshotDate: 'desc' },
      })
      if (newerBaseline) {
        return reply.status(409).send({ error: `盘点日期早于现有可信基准 ${newerBaseline.snapshotDate.toISOString().slice(0, 10)}，不能倒序创建` })
      }
      const estimate = await estimatedStoreInventory(req.user.tenantId, store.id, body.data.countDate)
      const estimatedByProduct = new Map((estimate.items || []).map((item: any) => [item.id, item]))
      const [recipeProducts, receiptProducts, baselineProducts] = await Promise.all([
        prisma.dishRecipe.findMany({
          where: { dish: { tenantId: req.user.tenantId }, product: { status: 'ENABLED' } },
          select: { productId: true }, distinct: ['productId'],
        }),
        prisma.receiptItem.findMany({
          where: { receipt: { tenantId: req.user.tenantId, storeId: store.id, status: { in: ['CONFIRMED', 'ACCOUNTED'] } }, product: { status: 'ENABLED' } },
          select: { productId: true }, distinct: ['productId'],
        }),
        prisma.inventorySnapshotItem.findMany({
          where: { snapshot: { tenantId: req.user.tenantId, storeId: store.id }, productId: { not: null }, product: { status: 'ENABLED' } },
          select: { productId: true }, distinct: ['productId'],
        }),
      ])
      const productIds = [...new Set([
        ...estimatedByProduct.keys(),
        ...recipeProducts.map(row => row.productId),
        ...receiptProducts.map(row => row.productId),
        ...baselineProducts.map(row => row.productId!).filter(Boolean),
      ])]
      const products = await prisma.product.findMany({
        where: { tenantId: req.user.tenantId, id: { in: productIds }, status: 'ENABLED' },
        orderBy: [{ category: 'asc' }, { name: 'asc' }, { code: 'asc' }],
      })
      if (products.length === 0) return reply.status(409).send({ error: '当前门店没有可盘点食材，请先完成食材主数据或盘点基准' })

      const created = await serializableWithRetry(async tx => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`inventory-count-create:${req.user.tenantId}:${store.id}`}))`)
        const active = await tx.inventoryCount.findFirst({ where: { tenantId: req.user.tenantId, storeId: store.id, status: { in: [...ACTIVE_STATUSES] } } })
        if (active) throw Object.assign(new Error(`门店已有进行中的盘点单 ${active.no}`), { statusCode: 409 })
        const latestRevision = await tx.inventoryCount.aggregate({ where: { storeId: store.id, countDate }, _max: { revision: true } })
        const period = body.data.countDate.slice(0, 7).replace('-', '')
        const latestNo = await tx.inventoryCount.findFirst({
          where: { tenantId: req.user.tenantId, no: { startsWith: `PD${period}` } }, orderBy: { no: 'desc' }, select: { no: true },
        })
        const no = await nextBusinessNo(tx, req.user.tenantId, 'INVENTORY_COUNT', period, 'PD', businessNoFloor(latestNo?.no, 'PD', period))
        const row = await tx.inventoryCount.create({
          data: {
            tenantId: req.user.tenantId, storeId: store.id, no, countDate,
            revision: (latestRevision._max.revision || 0) + 1, status: 'DRAFT',
            itemCount: products.length, note: body.data.note || null, createdById: req.user.userId,
            totalBookValue: products.reduce((sum, product) => {
              const estimateRow: any = estimatedByProduct.get(product.id)
              const fallbackCost = productInventoryUnitCost(product) || 0
              return sum.add(new Prisma.Decimal(estimateRow?.stock || 0).mul(estimateRow?.avgUnitCost || fallbackCost))
            }, new Prisma.Decimal(0)),
            items: {
              create: products.map((product, index) => {
                const estimateRow: any = estimatedByProduct.get(product.id)
                const fallbackCost = productInventoryUnitCost(product) || 0
                return {
                  productId: product.id, productCodeSnapshot: product.code,
                  productNameSnapshot: product.name, productSpecSnapshot: product.spec,
                  categorySnapshot: product.category, unitSnapshot: product.inventoryUnit || product.unit,
                  bookQuantity: new Prisma.Decimal(estimateRow?.stock || 0),
                  averageUnitCost: new Prisma.Decimal(estimateRow?.avgUnitCost || fallbackCost),
                  sortOrder: index,
                }
              }),
            },
          },
        })
        await tx.opLog.create({
          data: { tenantId: req.user.tenantId, userId: req.user.userId, action: `创建门店盘点单 ${no}`, entityType: 'InventoryCount', targetId: row.id, metadata: { storeId: store.id, countDate: body.data.countDate, itemCount: products.length } },
        })
        return row
      }, 30_000)
      const full = await loadCount(created.id, req.user.tenantId)
      return reply.status(201).send(publicCount(full!, true))
    } catch (error: any) {
      req.log.error({ error }, 'inventory count creation failed')
      return reply.status(error.statusCode || (error.code === 'P2002' ? 409 : 500)).send({ error: error.message || '创建盘点单失败' })
    }
  })

  app.get('/:id', auth, async (req: any, reply: any) => {
    if (!canViewInventoryCounts(req.user.role)) return reply.status(403).send({ error: '无权查看盘点单' })
    const row = await loadCount(req.params.id, req.user.tenantId)
    if (!row) return reply.status(404).send({ error: '盘点单不存在' })
    try {
      await resolveStore(req.user, row.storeId)
      return publicCount(row, true)
    } catch (error: any) {
      return reply.status(error.statusCode || 403).send({ error: error.message })
    }
  })

  app.post('/:id/start', auth, async (req: any, reply: any) => {
    if (!WRITE_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权开始盘点' })
    const body = versionSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })
    const row = await loadCount(req.params.id, req.user.tenantId)
    if (!row) return reply.status(404).send({ error: '盘点单不存在' })
    await resolveStore(req.user, row.storeId)
    const updated = await prisma.inventoryCount.updateMany({
      where: { id: row.id, status: 'DRAFT', rowVersion: body.data.rowVersion },
      data: { status: 'COUNTING', rowVersion: { increment: 1 } },
    })
    if (updated.count !== 1) return reply.status(409).send({ error: '盘点单状态已变化，请刷新' })
    return publicCount((await loadCount(row.id, req.user.tenantId))!, true)
  })

  app.post('/:id/cancel', auth, async (req: any, reply: any) => {
    if (!WRITE_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权取消盘点' })
    const body = cancelSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })
    const row = await loadCount(req.params.id, req.user.tenantId)
    if (!row) return reply.status(404).send({ error: '盘点单不存在' })
    await resolveStore(req.user, row.storeId)
    const updated = await prisma.$transaction(async tx => {
      const changed = await tx.inventoryCount.updateMany({
        where: { id: row.id, status: { in: ['DRAFT', 'COUNTING'] }, rowVersion: body.data.rowVersion },
        data: { status: 'CANCELLED', note: `${row.note ? `${row.note}\n` : ''}取消原因：${body.data.reason}`, rowVersion: { increment: 1 } },
      })
      if (changed.count !== 1) throw Object.assign(new Error('只有草稿或盘点中的单据可以取消'), { statusCode: 409 })
      await tx.opLog.create({
        data: { tenantId: row.tenantId, userId: req.user.userId, action: `取消门店盘点单 ${row.no}`, entityType: 'InventoryCount', targetId: row.id, metadata: { storeId: row.storeId, reason: body.data.reason } },
      })
      return changed
    })
    return publicCount((await loadCount(row.id, req.user.tenantId))!, true)
  })

  app.put('/:id/items', auth, async (req: any, reply: any) => {
    if (!WRITE_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权录入盘点' })
    const body = saveSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })
    const row = await loadCount(req.params.id, req.user.tenantId)
    if (!row) return reply.status(404).send({ error: '盘点单不存在' })
    await resolveStore(req.user, row.storeId)
    if (row.status !== 'COUNTING') return reply.status(409).send({ error: `当前状态 ${row.status} 不能录入` })
    const stored = new Map(row.items.map(item => [item.id, item]))
    if (new Set(body.data.items.map(item => item.id)).size !== body.data.items.length || body.data.items.some(item => !stored.has(item.id))) {
      return reply.status(400).send({ error: '盘点明细重复或不属于当前盘点单' })
    }
    try {
      await serializableWithRetry(async tx => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`inventory-count:${row.id}`}))`)
        const locked = await tx.inventoryCount.updateMany({
          where: { id: row.id, status: 'COUNTING', rowVersion: body.data.rowVersion },
          data: { rowVersion: { increment: 1 } },
        })
        if (locked.count !== 1) throw Object.assign(new Error('盘点内容已被其他人更新，请刷新后继续'), { statusCode: 409 })
        for (const input of body.data.items) {
          const current = stored.get(input.id)!
          const counted = new Prisma.Decimal(input.countedQuantity)
          const diff = differenceValues({ bookQuantity: current.bookQuantity, countedQuantity: counted, averageUnitCost: current.averageUnitCost })
          await tx.inventoryCountItem.update({
            where: { id: input.id },
            data: {
              countedQuantity: counted, differenceQuantity: diff.quantity, differenceAmount: diff.amount,
              reasonCode: input.reasonCode || null, reasonNote: input.reasonNote || null,
              evidenceKeys: input.evidenceKeys || [],
            },
          })
        }
        const items = await tx.inventoryCountItem.findMany({ where: { inventoryCountId: row.id } })
        const countedItems = items.filter(item => item.countedQuantity != null)
        await tx.inventoryCount.update({
          where: { id: row.id },
          data: {
            countedCount: countedItems.length,
            differenceCount: countedItems.filter(item => !new Prisma.Decimal(item.differenceQuantity || 0).equals(0)).length,
            totalCountedValue: countedItems.reduce((sum, item) => sum.add(item.countedQuantity!.mul(item.averageUnitCost)), new Prisma.Decimal(0)),
            totalDifferenceValue: countedItems.reduce((sum, item) => sum.add(item.differenceAmount || 0), new Prisma.Decimal(0)),
          },
        })
      })
      return publicCount((await loadCount(row.id, req.user.tenantId))!, true)
    } catch (error: any) {
      return reply.status(error.statusCode || 500).send({ error: error.message || '保存失败' })
    }
  })

  app.post('/:id/submit', auth, async (req: any, reply: any) => {
    if (!WRITE_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权提交盘点' })
    const body = versionSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })
    const row = await loadCount(req.params.id, req.user.tenantId)
    if (!row) return reply.status(404).send({ error: '盘点单不存在' })
    await resolveStore(req.user, row.storeId)
    if (row.status !== 'COUNTING') return reply.status(409).send({ error: `当前状态 ${row.status} 不能提交` })
    const issues: string[] = []
    for (const item of row.items) {
      if (item.countedQuantity == null) {
        issues.push(`${item.productNameSnapshot} 未填写实盘数量（零库存必须填 0）`)
        continue
      }
      const diff = differenceValues({ bookQuantity: item.bookQuantity, countedQuantity: item.countedQuantity, averageUnitCost: item.averageUnitCost })
      if (!diff.quantity.equals(0) && !item.reasonCode) issues.push(`${item.productNameSnapshot} 有差异但未选择原因`)
      if (requiresEvidence(item.bookQuantity, diff.quantity, diff.amount) && item.evidenceKeys.length === 0) {
        issues.push(`${item.productNameSnapshot} 差异超过阈值，必须上传图片证据`)
      }
    }
    if (issues.length > 0) return reply.status(409).send({ error: `还有 ${issues.length} 项不能提交`, issues: issues.slice(0, 50) })
    const updated = await prisma.inventoryCount.updateMany({
      where: { id: row.id, status: 'COUNTING', rowVersion: body.data.rowVersion },
      data: { status: 'REVIEWING', submittedById: req.user.userId, submittedAt: new Date(), rowVersion: { increment: 1 } },
    })
    if (updated.count !== 1) return reply.status(409).send({ error: '盘点单已被其他人更新，请刷新' })
    const fresh = (await loadCount(row.id, req.user.tenantId))!
    // 通知厨师长/店长确认 (提交人也会收到, 作为提交回执; 失败不阻塞提交)
    notify({
      tenantId: req.user.tenantId,
      event: 'COUNT_PENDING_CONFIRM',
      eventKey: `INVENTORY_COUNT:${row.id}:SUBMITTED`,
      payload: {
        countId: row.id,
        no: row.no,
        storeName: fresh.store.name,
        submittedByName: fresh.submittedBy?.name || '',
        itemCount: fresh.itemCount || fresh.items.length,
      },
      toStoreIds: [row.storeId],
    })
    return publicCount(fresh, true)
  })

  app.post('/:id/confirm', auth, async (req: any, reply: any) => {
    if (!WRITE_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权确认盘点' })
    const body = versionSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })
    const current = await loadCount(req.params.id, req.user.tenantId)
    if (!current) return reply.status(404).send({ error: '盘点单不存在' })
    await resolveStore(req.user, current.storeId)
    try {
      await serializableWithRetry(async tx => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`inventory-count:${current.id}`}))`)
        const row = await tx.inventoryCount.findFirst({ where: { id: current.id, tenantId: req.user.tenantId }, include: { items: true } })
        if (!row || row.status !== 'REVIEWING' || row.rowVersion !== body.data.rowVersion) {
          throw Object.assign(new Error('盘点单状态或版本已变化，请刷新'), { statusCode: 409 })
        }
        if (row.items.some(item => item.countedQuantity == null)) throw Object.assign(new Error('存在未填写的盘点品项'), { statusCode: 409 })
        const newerSnapshot = await tx.inventorySnapshot.findFirst({ where: { tenantId: row.tenantId, storeId: row.storeId, snapshotDate: { gt: row.countDate } } })
        if (newerSnapshot) throw Object.assign(new Error('盘点日期早于当前可信库存基准，不能倒序确认'), { statusCode: 409 })
        const sameDateSnapshot = await tx.inventorySnapshot.findFirst({ where: { tenantId: row.tenantId, storeId: row.storeId, snapshotDate: row.countDate } })
        if (sameDateSnapshot) throw Object.assign(new Error('该日期已经存在可信盘点基准，请先核查或冲销原盘点'), { statusCode: 409 })
        const snapshot = await tx.inventorySnapshot.create({
          data: {
            tenantId: row.tenantId, storeId: row.storeId, snapshotDate: row.countDate,
            sourceFilename: `在线盘点单 ${row.no}`,
            totalValue: row.totalCountedValue, itemCount: row.items.length,
            nonzeroCount: row.items.filter(item => item.countedQuantity!.gt(0)).length,
            zeroCount: row.items.filter(item => item.countedQuantity!.equals(0)).length,
            matchedCount: row.items.length,
            items: {
              create: row.items.sort((a, b) => a.sortOrder - b.sortOrder).map(item => ({
                productId: item.productId, section: item.categorySnapshot, rawName: item.productNameSnapshot,
                rawSpec: item.productSpecSnapshot, unit: item.unitSnapshot, quantity: item.countedQuantity!,
                unitPrice: item.averageUnitCost, amount: item.countedQuantity!.mul(item.averageUnitCost),
                normalizedQuantity: item.countedQuantity!, normalizedUnit: item.unitSnapshot,
                normalizationFactor: new Prisma.Decimal(1), normalizationStatus: 'EXACT',
                normalizationNote: `在线盘点单 ${row.no}`, sortOrder: item.sortOrder,
              })),
            },
          },
        })
        const updated = await tx.inventoryCount.updateMany({
          where: { id: row.id, status: 'REVIEWING', rowVersion: body.data.rowVersion },
          data: { status: 'CONFIRMED', snapshotId: snapshot.id, confirmedById: req.user.userId, confirmedAt: new Date(), rowVersion: { increment: 1 } },
        })
        if (updated.count !== 1) throw Object.assign(new Error('盘点单已被其他人确认'), { statusCode: 409 })
        await tx.opLog.create({
          data: { tenantId: row.tenantId, userId: req.user.userId, action: `确认门店盘点单 ${row.no}`, entityType: 'InventoryCount', targetId: row.id, metadata: { storeId: row.storeId, snapshotId: snapshot.id, differenceCount: row.differenceCount, differenceValue: row.totalDifferenceValue.toString() } },
        })
      }, 30_000)
      await revalueStoreConsumptionCosts(current.tenantId, current.storeId).catch(error => {
        req.log.error({ error, storeId: current.storeId }, 'inventory count cost snapshot refresh failed')
      })
      return publicCount((await loadCount(current.id, req.user.tenantId))!, true)
    } catch (error: any) {
      req.log.error({ error, inventoryCountId: current.id }, 'inventory count confirmation failed')
      return reply.status(error.statusCode || (error.code === 'P2002' ? 409 : 500)).send({ error: error.message || '确认失败，库存基准未改变' })
    }
  })

  app.post('/:id/reverse', auth, async (req: any, reply: any) => {
    if (!WRITE_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权冲销盘点' })
    const body = reverseSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })
    const current = await loadCount(req.params.id, req.user.tenantId)
    if (!current) return reply.status(404).send({ error: '盘点单不存在' })
    await resolveStore(req.user, current.storeId)
    try {
      await serializableWithRetry(async tx => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`inventory-count:${current.id}`}))`)
        const row = await tx.inventoryCount.findFirst({ where: { id: current.id, tenantId: req.user.tenantId } })
        if (!row || row.status !== 'CONFIRMED' || row.rowVersion !== body.data.rowVersion || !row.snapshotId) {
          throw Object.assign(new Error('只有当前版本的已确认盘点单可以冲销'), { statusCode: 409 })
        }
        const latestSnapshot = await tx.inventorySnapshot.findFirst({
          where: { tenantId: row.tenantId, storeId: row.storeId }, orderBy: [{ snapshotDate: 'desc' }, { createdAt: 'desc' }],
        })
        if (!latestSnapshot || latestSnapshot.id !== row.snapshotId) {
          throw Object.assign(new Error('该盘点之后已有新的库存基准，不能跨期冲销'), { statusCode: 409 })
        }
        await tx.inventorySnapshot.delete({ where: { id: row.snapshotId } })
        const updated = await tx.inventoryCount.updateMany({
          where: { id: row.id, status: 'CONFIRMED', rowVersion: body.data.rowVersion },
          data: {
            status: 'REVERSED', snapshotId: null, reversalReason: body.data.reason,
            reversedById: req.user.userId, reversedAt: new Date(), rowVersion: { increment: 1 },
          },
        })
        if (updated.count !== 1) throw Object.assign(new Error('盘点单已被其他人处理'), { statusCode: 409 })
        await tx.opLog.create({
          data: { tenantId: row.tenantId, userId: req.user.userId, action: `冲销门店盘点单 ${row.no}`, entityType: 'InventoryCount', targetId: row.id, metadata: { storeId: row.storeId, reason: body.data.reason } },
        })
      })
      return publicCount((await loadCount(current.id, req.user.tenantId))!, true)
    } catch (error: any) {
      return reply.status(error.statusCode || 500).send({ error: error.message || '冲销失败' })
    }
  })
}
