/** 供应商发票：上传、入库单关联、财务审核与付款前查询。 */
import { randomUUID } from 'node:crypto'
import { FastifyPluginAsync } from 'fastify'
import OSS from 'ali-oss'
import dayjs from 'dayjs'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import { isSupplierRole } from '../lib/auth-scope'
import { resignOssUrl } from './upload'
import { createSupplierInvoice, reviewInvoice } from '../services/invoiceIntegrity'

const FINANCE_ROLES = new Set(['FINANCE', 'ADMIN', 'SUPER_ADMIN'])
const INVOICE_READ_ROLES = FINANCE_ROLES
const INVOICE_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'] as const
const INVOICE_MIMES: Record<string, { extension: string; fileType: 'image' | 'pdf' }> = {
  'image/jpeg': { extension: 'jpg', fileType: 'image' },
  'image/png': { extension: 'png', fileType: 'image' },
  'image/webp': { extension: 'webp', fileType: 'image' },
  'application/pdf': { extension: 'pdf', fileType: 'pdf' },
}
const MAX_FILE_BYTES = 10 * 1024 * 1024

const moneyValue = z.preprocess(value => {
  if (value === undefined || value === null || value === '') return undefined
  return Number(value)
}, z.number().positive('金额必须大于 0').max(9_999_999_999.99, '金额超出系统上限').refine(
  value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8,
  '金额最多保留两位小数',
))
const optionalMoneyValue = z.preprocess(value => {
  if (value === undefined || value === null || value === '') return undefined
  return Number(value)
}, z.number().positive('金额必须大于 0').max(9_999_999_999.99).refine(
  value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8,
  '金额最多保留两位小数',
).optional())
const optionalTaxRate = z.preprocess(value => {
  if (value === undefined || value === null || value === '') return undefined
  return Number(value)
}, z.number().min(0, '税率不能小于 0').max(1, '税率不能大于 1').refine(
  value => Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-8,
  '税率最多保留四位小数',
).optional())
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD').refine(value => {
  const date = dayjs(value)
  return date.isValid() && date.format('YYYY-MM-DD') === value
}, '日期无效').refine(value => !dayjs(value).isAfter(dayjs(), 'day'), '开票日期不得晚于今天')

export const invoiceUploadSchema = z.object({
  invoiceNo: z.string().trim().min(1, '请填写发票号码').max(50),
  invoiceCode: z.string().trim().max(50).optional(),
  amount: moneyValue,
  amountWithoutTax: optionalMoneyValue,
  taxRate: optionalTaxRate,
  taxAmount: optionalMoneyValue,
  issueDate: businessDate,
  note: z.string().trim().max(1000).optional(),
  receiptIds: z.array(z.string().trim().min(1).max(100)).min(1, '请至少关联一张已确认入库单').max(200),
}).strict().superRefine((value, context) => {
  if (new Set(value.receiptIds).size !== value.receiptIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['receiptIds'], message: '关联入库单不能重复' })
  }
  if (value.amountWithoutTax !== undefined && value.amountWithoutTax > value.amount) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['amountWithoutTax'], message: '不含税金额不能大于价税合计' })
  }
  if (value.taxAmount !== undefined && value.taxAmount > value.amount) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['taxAmount'], message: '税额不能大于价税合计' })
  }
  if (value.amountWithoutTax !== undefined && value.taxAmount !== undefined
      && Math.abs(value.amountWithoutTax + value.taxAmount - value.amount) > 0.01) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['taxAmount'], message: '不含税金额与税额之和必须等于价税合计' })
  }
})

const listSchema = z.object({ status: z.enum(INVOICE_STATUSES).optional() }).strict()
const reviewSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT']),
  note: z.string().trim().max(1000).optional().nullable(),
}).strict()

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode })
}

function isUniqueConflict(error: any) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

function normalizeText(value: string | null | undefined) {
  const trimmed = value?.trim()
  return trimmed || null
}

function withSignedFile<T extends { fileUrl: string }>(invoice: T) {
  return { ...invoice, fileUrl: resignOssUrl(invoice.fileUrl) }
}

function ossClient() {
  return new OSS({
    region: process.env.OSS_REGION || 'oss-cn-hangzhou',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID!,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET!,
    bucket: process.env.OSS_BUCKET || 'dianjie-upload',
    secure: true,
  })
}

export const invoiceRoutes: FastifyPluginAsync = async app => {
  const auth = { preHandler: [(app as any).authenticate] }

  app.get('/', auth, async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    if (!INVOICE_READ_ROLES.has(role) && !isSupplierRole(role)) {
      return reply.status(403).send({ error: '无权查看发票' })
    }
    if (isSupplierRole(role) && !supplierId) {
      return reply.status(403).send({ error: '供应商账号未绑定供应商' })
    }
    const parsed = listSchema.safeParse(req.query || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const where: Prisma.InvoiceWhereInput = { tenantId }
    if (parsed.data.status) where.status = parsed.data.status
    if (isSupplierRole(role)) where.supplierId = supplierId
    const invoices = await prisma.invoice.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true } },
        uploadedBy: { select: { id: true, name: true } },
        receipts: {
          select: {
            id: true, no: true, totalAmount: true, deliveryDate: true,
            store: { select: { name: true } },
            paymentSchedule: { select: { id: true, amount: true, dueAt: true, status: true } },
          },
        },
        payments: {
          select: { id: true, amount: true, status: true, paidAt: true, createdAt: true, note: true },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { uploadedAt: 'desc' }, take: 50,
    })
    return invoices.map(withSignedFile)
  })

  app.get('/pending-from-finance', auth, async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务/老板可访问' })
    const paid = await prisma.receipt.findMany({
      where: {
        tenantId, invoiceId: null, status: { in: ['CONFIRMED', 'ACCOUNTED'] },
        paymentSchedule: { status: 'PAID' }, supplier: { NOT: { sourceType: 'HEADQ_WAREHOUSE' } },
      },
      include: {
        supplier: { select: { id: true, name: true, contactName: true, contactPhone: true } },
        store: { select: { id: true, name: true, managerName: true, phone: true } },
        paymentSchedule: { select: { paidAt: true, amount: true, status: true } },
      },
      orderBy: { paymentSchedule: { paidAt: 'asc' } }, take: 200,
    })
    const now = Date.now()
    const enriched = paid.map(receipt => ({
      ...receipt,
      daysSincePaid: receipt.paymentSchedule?.paidAt
        ? Math.floor((now - receipt.paymentSchedule.paidAt.getTime()) / 86_400_000) : null,
    }))
    const pending = await prisma.receipt.findMany({
      where: {
        tenantId, invoiceId: null, status: { in: ['CONFIRMED', 'ACCOUNTED'] },
        supplier: { NOT: { sourceType: 'HEADQ_WAREHOUSE' } },
        OR: [
          { paymentSchedule: { status: { in: ['PENDING', 'APPROVED', 'PENDING_APPROVAL', 'OVERDUE'] } } },
          { paymentSchedule: null },
        ],
      },
      include: {
        supplier: { select: { id: true, name: true, contactName: true, contactPhone: true } },
        store: { select: { id: true, name: true } },
        paymentSchedule: { select: { dueAt: true, amount: true, status: true } },
      },
      orderBy: { deliveryDate: 'asc' }, take: 200,
    })
    return {
      paid: enriched, pending,
      summary: {
        paidCount: enriched.length,
        paidAmount: enriched.reduce((sum, receipt) => sum + Number(receipt.totalAmount), 0),
        pendingCount: pending.length,
        pendingAmount: pending.reduce((sum, receipt) => sum + Number(receipt.totalAmount), 0),
        oldestPaidDays: enriched[0]?.daysSincePaid || 0,
      },
    }
  })

  app.get('/pending-payable', auth, async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    if (!isSupplierRole(role)) return reply.status(403).send({ error: '仅供应商可见' })
    if (!supplierId) return reply.status(403).send({ error: '供应商账号未绑定供应商' })
    return prisma.receipt.findMany({
      where: {
        tenantId, supplierId, invoiceId: null, status: { in: ['CONFIRMED', 'ACCOUNTED'] },
      },
      include: {
        store: { select: { name: true } },
        paymentSchedule: { select: { id: true, amount: true, dueAt: true, status: true } },
      },
      orderBy: { deliveryDate: 'desc' }, take: 100,
    })
  })

  app.get('/:id', auth, async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    if (!INVOICE_READ_ROLES.has(role) && !isSupplierRole(role)) {
      return reply.status(403).send({ error: '无权查看发票' })
    }
    if (isSupplierRole(role) && !supplierId) {
      return reply.status(403).send({ error: '供应商账号未绑定供应商' })
    }
    const invoice = await prisma.invoice.findFirst({
      where: {
        id: req.params.id, tenantId,
        ...(isSupplierRole(role) ? { supplierId } : {}),
      },
      include: {
        supplier: { select: { id: true, name: true } },
        uploadedBy: { select: { id: true, name: true } },
        receipts: {
          include: {
            store: { select: { name: true } },
            paymentSchedule: { select: { id: true, amount: true, dueAt: true, status: true } },
          },
        },
      },
    })
    if (!invoice) return reply.status(404).send({ error: '发票不存在' })
    return withSignedFile(invoice)
  })

  app.post('/', auth, async (req: any, reply: any) => {
    const { tenantId, role, supplierId, userId } = req.user
    if (!isSupplierRole(role)) return reply.status(403).send({ error: '仅供应商可上传发票' })
    if (!supplierId) return reply.status(403).send({ error: '供应商账号未绑定供应商' })
    if (!req.parts) return reply.status(400).send({ error: '需 multipart/form-data' })

    const fields: Record<string, string> = {}
    let file: { buffer: Buffer; mimetype: string } | null = null
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (file) throw httpError('只能上传一个发票文件', 400)
          const mime = INVOICE_MIMES[part.mimetype]
          if (!mime) throw httpError('发票文件仅支持 JPG、PNG、WebP 或 PDF', 400)
          const buffer = await part.toBuffer()
          if ((part.file as any).truncated || buffer.length > MAX_FILE_BYTES) {
            throw httpError('文件大小不能超过 10MB', 400)
          }
          if (buffer.length === 0) throw httpError('发票文件不能为空', 400)
          file = { buffer, mimetype: part.mimetype }
        } else {
          if (Object.prototype.hasOwnProperty.call(fields, part.fieldname)) {
            throw httpError(`字段 ${part.fieldname} 不能重复`, 400)
          }
          fields[part.fieldname] = String(part.value)
        }
      }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.warn({ err: error }, 'invoice multipart parse failed')
      return reply.status(400).send({ error: '发票表单解析失败' })
    }

    let receiptIds: unknown = []
    try {
      receiptIds = JSON.parse(fields.receiptIds || '[]')
    } catch {
      return reply.status(400).send({ error: '关联入库单格式无效' })
    }
    const parsed = invoiceUploadSchema.safeParse({ ...fields, receiptIds })
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    if (!file) return reply.status(400).send({ error: '请上传发票文件' })

    const mime = INVOICE_MIMES[file.mimetype]
    const region = process.env.OSS_REGION || 'oss-cn-hangzhou'
    const bucket = process.env.OSS_BUCKET || 'dianjie-upload'
    const key = `invoices/${tenantId}/${supplierId}/${randomUUID()}.${mime.extension}`
    const client = ossClient()
    try {
      await client.put(key, file.buffer, {
        mime: file.mimetype, headers: { 'Cache-Control': 'private, max-age=300' },
      })
    } catch (error: any) {
      req.log.error({ err: error }, 'invoice OSS upload failed')
      return reply.status(502).send({ error: '发票文件上传失败，请稍后重试' })
    }
    const fileUrl = `https://${bucket}.${region}.aliyuncs.com/${key}`
    const values = parsed.data
    try {
      const result = await createSupplierInvoice({
        tenantId, supplierId, uploadedById: userId, role,
        invoiceNo: values.invoiceNo,
        invoiceCode: normalizeText(values.invoiceCode),
        amount: new Prisma.Decimal(values.amount),
        amountWithoutTax: values.amountWithoutTax === undefined ? null : new Prisma.Decimal(values.amountWithoutTax),
        taxRate: values.taxRate === undefined ? null : new Prisma.Decimal(values.taxRate),
        taxAmount: values.taxAmount === undefined ? null : new Prisma.Decimal(values.taxAmount),
        issueDate: new Date(`${values.issueDate}T00:00:00.000+08:00`),
        fileUrl, fileType: mime.fileType, note: normalizeText(values.note), receiptIds: values.receiptIds,
      })
      if (result.duplicated) {
        await client.delete(key).catch((error: unknown) => req.log.warn({ err: error, key }, 'duplicate invoice orphan cleanup failed'))
      }
      return reply.status(result.duplicated ? 200 : 201).send({
        ...result.invoice, fileUrl: resignOssUrl(result.invoice.fileUrl), duplicated: result.duplicated,
      })
    } catch (error: any) {
      await client.delete(key).catch((cleanupError: unknown) => req.log.warn({ err: cleanupError, key }, 'invoice orphan cleanup failed'))
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      if (isUniqueConflict(error)) return reply.status(409).send({ error: '发票号码或关联入库单已被占用，请刷新后重试' })
      req.log.error({ err: error }, 'invoice create failed')
      return reply.status(500).send({ error: '发票保存失败，未关联任何入库单' })
    }
  })

  app.patch('/:id/verify', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务可审核' })
    const parsed = reviewSchema.safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })
    const note = normalizeText(parsed.data.note)
    if (parsed.data.action === 'REJECT' && !note) {
      return reply.status(400).send({ error: '驳回必须填写原因' })
    }
    try {
      return await reviewInvoice({
        tenantId, invoiceId: req.params.id, userId, role,
        action: parsed.data.action, note,
      })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'invoice review failed')
      return reply.status(500).send({ error: '发票审核失败，未保存任何变更' })
    }
  })
}
