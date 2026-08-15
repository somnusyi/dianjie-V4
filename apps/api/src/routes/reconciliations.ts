import { FastifyPluginAsync } from 'fastify'
import { businessMonthKey } from '../lib/businessTime'
import dayjs from 'dayjs'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { isSupplierRole } from '../lib/auth-scope'
import { hasInternalSupplyChainCapability } from '../lib/internal-supply-chain-access'
import { nextBusinessNo } from '../services/purchaseOrderIntegrity'
import { buildSupplierStatement, supplierStatementToCsv } from '../services/supplierStatement'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const FINANCE_ROLES = new Set(['ADMIN', 'FINANCE', 'SUPER_ADMIN'])
const supplierStatementQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份格式应为 YYYY-MM'),
  supplierId: z.string().trim().min(1).max(100).optional(),
}).strict()

const businessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD').refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}, '日期无效')

const createSchema = z.object({
  supplierId: z.string().trim().min(1, '请选择供应商').max(100),
  periodStart: businessDateSchema,
  periodEnd: businessDateSchema,
}).strict().superRefine((value, context) => {
  const start = dayjs(value.periodStart)
  const end = dayjs(value.periodEnd)
  if (end.isBefore(start, 'day')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['periodEnd'], message: '结束日期不得早于开始日期' })
  } else if (end.diff(start, 'day') > 366) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['periodEnd'], message: '单次对账期间不得超过 366 天' })
  }
})

const reviewSchema = z.object({
  action: z.enum(['approve', 'reject']),
  note: z.string().trim().max(1000).optional(),
}).strict()

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode })
}

function isUniqueConflict(error: any) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

async function loadSupplierStatement(params: {
  tenantId: string
  role: string
  actorSupplierId?: string | null
  query: z.infer<typeof supplierStatementQuerySchema>
}) {
  const scopedSupplierId = isSupplierRole(params.role) ? params.actorSupplierId : params.query.supplierId
  if (!scopedSupplierId) {
    throw httpError(isSupplierRole(params.role) ? '供应商账号未绑定供应商' : '请选择供应商', 403)
  }
  const supplier = await prisma.supplier.findFirst({
    where: { id: scopedSupplierId, tenantId: params.tenantId }, select: { id: true, no: true, name: true },
  })
  if (!supplier) throw httpError('供应商不存在或无权查看', 404)

  const periodStart = new Date(`${params.query.month}-01T00:00:00.000Z`)
  const periodEnd = dayjs(periodStart).add(1, 'month').toDate()
  const rows = await prisma.receipt.findMany({
    where: {
      tenantId: params.tenantId, supplierId: scopedSupplierId,
      status: { in: ['CONFIRMED', 'ACCOUNTED'] },
      deliveryDate: { gte: periodStart, lt: periodEnd },
    },
    select: {
      id: true, no: true, deliveryDate: true, totalAmount: true,
      store: { select: { id: true, name: true } },
      purchaseOrder: { select: { id: true, no: true, totalAmount: true, currentOrderAmount: true } },
      deliveryOrder: { select: { id: true, no: true, actualTotalAmount: true } },
      paymentSchedule: {
        select: { id: true, amount: true, status: true, dueAt: true, paidAt: true, bankTxNo: true },
      },
      lossClaims: {
        where: { kind: { in: ['ARRIVAL_SHORTAGE', 'ARRIVAL_DAMAGE', 'LEGACY_UNRESOLVED'] } },
        select: {
          id: true, no: true, kind: true, status: true, payableBasis: true,
          totalLossAmount: true, resolvedDeductAmount: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: [{ deliveryDate: 'asc' }, { no: 'asc' }],
  })
  return {
    supplier,
    month: params.query.month,
    periodStart,
    periodEnd: dayjs(periodEnd).subtract(1, 'day').toDate(),
    ...buildSupplierStatement(rows),
  }
}

export const reconciliationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/supplier-statement', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, supplierId: actorSupplierId } = req.user
    if (!FINANCE_ROLES.has(role)
        && !isSupplierRole(role)
        && !hasInternalSupplyChainCapability(role, 'finance.read')) {
      return reply.status(403).send({ error: '无权查看供应商月度对账' })
    }
    const parsed = supplierStatementQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    try {
      return await loadSupplierStatement({ tenantId, role, actorSupplierId, query: parsed.data })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.get('/supplier-statement/export', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role, supplierId: actorSupplierId } = req.user
    if (!FINANCE_ROLES.has(role)
        && !isSupplierRole(role)
        && !hasInternalSupplyChainCapability(role, 'finance.read')) {
      return reply.status(403).send({ error: '无权导出供应商月度对账' })
    }
    const parsed = supplierStatementQuerySchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    try {
      const statement = await loadSupplierStatement({ tenantId, role, actorSupplierId, query: parsed.data })
      await prisma.opLog.create({
        data: {
          tenantId, userId, role,
          action: `导出供应商月度对账 ${statement.supplier.name} ${statement.month}`,
          entityType: 'SupplierStatement', targetId: statement.supplier.id,
          metadata: { month: statement.month, supplierId: statement.supplier.id, receiptCount: statement.summary.receiptCount },
        },
      })
      const filename = `${statement.supplier.name}_${statement.month}_月度对账.csv`
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
        .header('Cache-Control', 'private, no-store')
        .send(supplierStatementToCsv(statement))
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  app.get('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    if (!FINANCE_ROLES.has(role)
        && !isSupplierRole(role)
        && !hasInternalSupplyChainCapability(role, 'finance.read')) {
      return reply.status(403).send({ error: '无权查看对账单' })
    }
    if (isSupplierRole(role) && !supplierId) {
      return reply.status(403).send({ error: '供应商账号未绑定供应商' })
    }
    const where: Prisma.ReconciliationWhereInput = { tenantId }
    if (isSupplierRole(role)) where.supplierId = supplierId
    return prisma.reconciliation.findMany({
      where,
      include: {
        supplier: { select: { name: true, no: true } },
        items: { include: { receipt: { select: { no: true, totalAmount: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    })
  })

  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const parsed = createSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })

    const { supplierId, periodStart, periodEnd } = parsed.data
    try {
      const recon = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reconciliation-create:${tenantId}:${supplierId}`}))`
        const supplier = await tx.supplier.findFirst({ where: { id: supplierId, tenantId }, select: { id: true } })
        if (!supplier) throw httpError('供应商不存在', 404)

        const receipts = await tx.receipt.findMany({
          where: {
            tenantId, supplierId, status: 'CONFIRMED',
            deliveryDate: {
              gte: new Date(`${periodStart}T00:00:00.000Z`),
              lte: new Date(`${periodEnd}T00:00:00.000Z`),
            },
            reconciliationItems: { none: {} },
          },
          orderBy: [{ deliveryDate: 'asc' }, { id: 'asc' }],
        })
        if (!receipts.length) throw httpError('该供应商在此期间无未对账的已确认入库单', 409)

        const totalAmount = receipts.reduce(
          (sum, receipt) => sum.add(receipt.totalAmount), new Prisma.Decimal(0),
        ).toDecimalPlaces(2)
        if (totalAmount.lte(0)) throw httpError('对账金额必须大于 0', 409)

        const ym = businessMonthKey()
        const prefix = `DC${ym}`
        const latest = await tx.reconciliation.findFirst({
          where: { tenantId, no: { startsWith: prefix } }, orderBy: { no: 'desc' }, select: { no: true },
        })
        const parsedFloor = Number(latest?.no.slice(prefix.length) || 0)
        const floor = Number.isFinite(parsedFloor) ? parsedFloor : 0
        const no = await nextBusinessNo(tx, tenantId, 'RECONCILIATION', ym, 'DC', floor)

        const created = await tx.reconciliation.create({
          data: {
            tenantId, no, supplierId,
            periodStart: new Date(`${periodStart}T00:00:00.000Z`),
            periodEnd: new Date(`${periodEnd}T00:00:00.000Z`),
            totalAmount, status: 'DRAFT',
            items: { create: receipts.map(receipt => ({ receiptId: receipt.id, amount: receipt.totalAmount })) },
          },
          include: {
            supplier: { select: { name: true, no: true } },
            items: { include: { receipt: { select: { no: true, totalAmount: true } } } },
          },
        })
        const updated = await tx.receipt.updateMany({
          where: { id: { in: receipts.map(receipt => receipt.id) }, tenantId, status: 'CONFIRMED' },
          data: { status: 'ACCOUNTED' },
        })
        if (updated.count !== receipts.length) throw httpError('入库单状态已变化，请刷新后重试', 409)
        await tx.opLog.create({
          data: {
            tenantId, userId, role, action: `生成对账单 ${no}`,
            target: no, entityType: 'Reconciliation', targetId: created.id,
            metadata: { supplierId, periodStart, periodEnd, receiptCount: receipts.length, totalAmount: totalAmount.toFixed(2) },
          },
        })
        return created
      })
      return reply.status(201).send(recon)
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      if (isUniqueConflict(error)) return reply.status(409).send({ error: '入库单已被其他对账流程占用，请刷新后重试' })
      req.log.error({ err: error }, 'reconciliation create failed')
      return reply.status(500).send({ error: '生成对账单失败，未保存任何变更' })
    }
  })

  app.patch('/:id/review', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '无权限' })
    const parsed = reviewSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const { action, note } = parsed.data
    if (action === 'reject' && !note) return reply.status(400).send({ error: '驳回必须填写原因' })

    try {
      const result = await prisma.$transaction(async tx => {
        const id = req.params.id as string
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reconciliation-review:${id}`}))`
        const recon = await tx.reconciliation.findFirst({ where: { id, tenantId } })
        if (!recon) throw httpError('对账单不存在', 404)
        const targetStatus = action === 'approve' ? 'APPROVED' : 'REJECTED'
        if (recon.status !== 'DRAFT') {
          const priorLog = await tx.opLog.findFirst({
            where: {
              tenantId, userId, entityType: 'Reconciliation', targetId: recon.id,
              metadata: { path: ['action'], equals: action },
            },
            select: { id: true },
          })
          if (recon.status === targetStatus && recon.reviewNote === (note || null) && priorLog) {
            return { message: action === 'approve' ? '审核通过' : '已驳回', status: targetStatus, duplicated: true }
          }
          throw httpError(`对账单当前状态 ${recon.status}，不可重复审核`, 409)
        }

        await tx.reconciliation.update({
          where: { id: recon.id }, data: { status: targetStatus, reviewedAt: new Date(), reviewNote: note || null },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId, role,
            action: action === 'approve' ? `审核通过对账单 ${recon.no}` : `驳回对账单 ${recon.no}: ${note}`,
            target: recon.no, entityType: 'Reconciliation', targetId: recon.id,
            metadata: { action, note: note || null, previousStatus: recon.status, targetStatus },
          },
        })
        return { message: action === 'approve' ? '审核通过' : '已驳回', status: targetStatus, duplicated: false }
      })
      return result
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'reconciliation review failed')
      return reply.status(500).send({ error: '对账审核失败，未保存任何变更' })
    }
  })
}
