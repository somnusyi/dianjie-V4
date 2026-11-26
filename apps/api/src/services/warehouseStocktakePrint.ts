import { createHash } from 'node:crypto'
import { Prisma, prisma } from '@dianjie/db'
import { warehouseStocktakePrintDocument, warehouseStocktakeRenderFingerprint } from './warehouseStocktakeArtifacts'

const fail = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode })
const printInclude = {
  warehouse: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  submittedBy: { select: { id: true, name: true } },
  auditedBy: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
  sections: {
    include: {
      assignedTo: { select: { id: true, name: true } },
      items: { orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }] },
    },
    orderBy: [{ name: 'asc' as const }, { id: 'asc' as const }],
  },
} satisfies Prisma.WarehouseStocktakeInclude

async function serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 })
    } catch (error: any) {
      const serialization = error?.code === 'P2010' && String(error?.meta?.code || '') === '40001'
      if ((!['P2002', 'P2034'].includes(error?.code) && !serialization) || attempt === 4) throw error
    }
  }
  throw fail('打印任务并发处理失败，请重试')
}

const requestFingerprint = (actorId: string, ids: string[]) => createHash('sha256')
  .update(JSON.stringify({ actorId, ids }))
  .digest('hex')

function jobSummary(job: { id: string; requestKey: string; status: string; items: unknown[] }) {
  return { id: job.id, requestKey: job.requestKey, status: job.status, itemCount: job.items.length }
}

export async function prepareWarehouseStocktakePrintJob(input: {
  tenantId: string
  userId: string
  requestKey: string
  ids: string[]
}) {
  const ids = [...input.ids]
  const fingerprint = requestFingerprint(input.userId, ids)
  return serializable(async tx => {
    const replay = await tx.warehouseStocktakePrintJob.findUnique({
      where: { tenantId_requestKey: { tenantId: input.tenantId, requestKey: input.requestKey } },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    })
    if (replay) {
      if (replay.actorId !== input.userId || replay.requestFingerprint !== fingerprint) throw fail('同一请求编号不能用于不同的打印内容', 409)
      return { replayed: true, job: jobSummary(replay) }
    }
    const rows = await tx.warehouseStocktake.findMany({
      where: { tenantId: input.tenantId, deletedAt: null, id: { in: ids } },
      include: printInclude,
    })
    if (rows.length !== ids.length) throw fail('盘点单不存在或无权打印', 404)
    const byId = new Map(rows.map(row => [row.id, row]))
    const ordered = ids.map(id => byId.get(id)!)
    const created = await tx.warehouseStocktakePrintJob.create({
      data: {
        tenantId: input.tenantId,
        requestKey: input.requestKey,
        requestFingerprint: fingerprint,
        actorId: input.userId,
      },
    })
    await tx.warehouseStocktakePrintJobItem.createMany({
      data: ordered.map((row, sortOrder) => ({
          tenantId: input.tenantId,
          printJobId: created.id,
          stocktakeId: row.id,
          stocktakeRowVersion: row.rowVersion,
          renderFingerprint: warehouseStocktakeRenderFingerprint(row),
          sortOrder,
        })),
    })
    const job = await tx.warehouseStocktakePrintJob.findUniqueOrThrow({
      where: { id: created.id }, include: { items: { orderBy: { sortOrder: 'asc' } } },
    })
    return { replayed: false, job: jobSummary(job) }
  })
}

export async function getWarehouseStocktakePrintJob(tenantId: string, userId: string, id: string) {
  const job = await prisma.warehouseStocktakePrintJob.findFirst({
    where: { tenantId, id },
    include: { items: { include: { stocktake: { include: printInclude } }, orderBy: { sortOrder: 'asc' } } },
  })
  // Treat another actor's job as absent so neither its existence, request key,
  // selected documents nor their frozen contents can leak within a tenant.
  if (!job || job.actorId !== userId) throw fail('打印任务不存在', 404)
  if (job.status !== 'PREPARED') throw fail(job.status === 'COMPLETED' ? '打印任务已完成' : '打印任务已放弃', 409)
  const documents = job.items.map(item => {
    if (item.stocktake.deletedAt || item.stocktake.rowVersion !== item.stocktakeRowVersion
      || warehouseStocktakeRenderFingerprint(item.stocktake) !== item.renderFingerprint) {
      throw fail('准备打印后盘点单已变化或删除，请重新准备打印', 409)
    }
    return warehouseStocktakePrintDocument(item.stocktake)
  })
  return { id: job.id, requestKey: job.requestKey, status: job.status, documents }
}

export async function completeWarehouseStocktakePrintJob(input: {
  tenantId: string
  userId: string
  id: string
  requestKey: string
}) {
  return serializable(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "warehouse_stocktake_print_jobs" WHERE "tenantId"=${input.tenantId} AND "id"=${input.id} FOR UPDATE`)
    const job = await tx.warehouseStocktakePrintJob.findFirst({
      where: { tenantId: input.tenantId, id: input.id },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    })
    if (!job) throw fail('打印任务不存在', 404)
    if (job.actorId !== input.userId || job.requestKey !== input.requestKey) throw fail('无权完成该打印任务', 403)
    if (job.status === 'COMPLETED') return { replayed: true, job: jobSummary(job) }
    if (job.status === 'ABANDONED') throw fail('已放弃的打印任务不能完成', 409)
    const stocktakeIds = job.items.map(item => item.stocktakeId).sort()
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "warehouse_stocktakes" WHERE "tenantId"=${input.tenantId} AND "id" IN (${Prisma.join(stocktakeIds)}) ORDER BY "id" FOR UPDATE`)
    const rows = await tx.warehouseStocktake.findMany({
      where: { tenantId: input.tenantId, deletedAt: null, id: { in: stocktakeIds } },
      include: printInclude,
    })
    if (rows.length !== stocktakeIds.length) throw fail('盘点单已删除，不能完成打印任务', 409)
    const byId = new Map(rows.map(row => [row.id, row]))
    for (const item of job.items) {
      const row = byId.get(item.stocktakeId)
      if (!row || row.rowVersion !== item.stocktakeRowVersion || warehouseStocktakeRenderFingerprint(row) !== item.renderFingerprint) {
        throw fail('准备打印后盘点单已变化，请重新准备打印', 409)
      }
    }
    const completedAt = new Date()
    for (const item of job.items) {
      const updated = await tx.warehouseStocktake.updateMany({
        where: { tenantId: input.tenantId, id: item.stocktakeId, deletedAt: null, rowVersion: item.stocktakeRowVersion },
        data: {
          printCount: { increment: 1 },
          lastPrintedAt: completedAt,
          lastPrintedById: input.userId,
          lastPrintedRowVersion: item.stocktakeRowVersion,
        },
      })
      if (updated.count !== 1) throw fail('盘点单已变化，不能完成打印任务', 409)
      const row = byId.get(item.stocktakeId)!
      await tx.opLog.create({ data: {
        tenantId: input.tenantId, userId: input.userId, action: '完成盘点单打印流程',
        entityType: 'WarehouseStocktake', targetId: row.id, target: row.no,
        metadata: { printJobId: job.id, stocktakeRowVersion: item.stocktakeRowVersion },
      } })
    }
    const completed = await tx.warehouseStocktakePrintJob.update({
      where: { id: job.id }, data: { status: 'COMPLETED', completedAt }, include: { items: true },
    })
    return { replayed: false, job: jobSummary(completed) }
  })
}

export async function abandonWarehouseStocktakePrintJob(input: {
  tenantId: string
  userId: string
  id: string
  requestKey: string
}) {
  return serializable(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "warehouse_stocktake_print_jobs" WHERE "tenantId"=${input.tenantId} AND "id"=${input.id} FOR UPDATE`)
    const job = await tx.warehouseStocktakePrintJob.findFirst({
      where: { tenantId: input.tenantId, id: input.id }, include: { items: true },
    })
    if (!job) throw fail('打印任务不存在', 404)
    if (job.actorId !== input.userId || job.requestKey !== input.requestKey) throw fail('无权放弃该打印任务', 403)
    if (job.status === 'ABANDONED') return { replayed: true, job: jobSummary(job) }
    if (job.status === 'COMPLETED') throw fail('已完成的打印任务不能放弃', 409)
    const abandoned = await tx.warehouseStocktakePrintJob.update({
      where: { id: job.id }, data: { status: 'ABANDONED', abandonedAt: new Date() }, include: { items: true },
    })
    const stocktakes = await tx.warehouseStocktake.findMany({
      where: { tenantId: input.tenantId, id: { in: job.items.map(item => item.stocktakeId) } }, select: { id: true, no: true },
    })
    for (const row of stocktakes) await tx.opLog.create({ data: {
      tenantId: input.tenantId, userId: input.userId, action: '放弃盘点单打印任务',
      entityType: 'WarehouseStocktake', targetId: row.id, target: row.no, metadata: { printJobId: job.id },
    } })
    return { replayed: false, job: jobSummary(abandoned) }
  })
}
