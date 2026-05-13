/**
 * 发票管理 (供应商上传 → 财务审核 → 关联订单解锁付款)
 *
 *   POST   /api/invoices                 供应商上传 (multipart: file + meta + receiptIds)
 *   GET    /api/invoices                 列表 (按 role 过滤)
 *   GET    /api/invoices/:id             详情
 *   PATCH  /api/invoices/:id/verify      财务审核 (action: APPROVE | REJECT)
 *   GET    /api/invoices/pending-payable 供应商: 待开票订单(已收货, 未关联发票)
 *
 * 数据模型: Invoice → Receipt 1:N
 *   - 一张发票可对多个订单(月底批量开)
 *   - 1 个订单当前最多对 1 张发票
 *   - 通过 receipt → paymentSchedule 派生付款流程
 */
import { FastifyPluginAsync } from 'fastify'
import OSS from 'ali-oss'
import { prisma } from '@dianjie/db'
import { isSupplierRole } from '../lib/auth-scope'

export const invoiceRoutes: FastifyPluginAsync = async (app) => {
  const auth = { preHandler: [(app as any).authenticate] }

  // ── 列表 ──────────────────────────────────────
  app.get('/', auth, async (req: any) => {
    const { tenantId, role, supplierId } = req.user
    const { status } = req.query as any
    const where: any = { tenantId }
    if (status) where.status = status
    if (isSupplierRole(role) && supplierId) where.supplierId = supplierId
    return prisma.invoice.findMany({
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
      orderBy: { uploadedAt: 'desc' },
      take: 50,
    })
  })

  // ── 详情 ──────────────────────────────────────
  app.get('/:id', auth, async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    const inv = await prisma.invoice.findFirst({
      where: { id: req.params.id, tenantId },
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
    if (!inv) return reply.status(404).send({ error: '发票不存在' })
    if (isSupplierRole(role) && inv.supplierId !== supplierId) {
      return reply.status(403).send({ error: '无权查看' })
    }
    return inv
  })

  // ── 待开票订单 (供应商上传时选关联) ──────────────
  // 已确认入库 + 未关联发票
  app.get('/pending-payable', auth, async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    if (!isSupplierRole(role)) return reply.status(403).send({ error: '仅供应商可见' })
    if (!supplierId) return []
    return prisma.receipt.findMany({
      where: {
        tenantId, supplierId, invoiceId: null,
        status: { notIn: ['VOID', 'REJECTED'] },
      },
      include: {
        store: { select: { name: true } },
        paymentSchedule: { select: { id: true, amount: true, dueAt: true, status: true } },
      },
      orderBy: { deliveryDate: 'desc' },
      take: 100,
    })
  })

  // ── 上传 (multipart) ──────────────────────────
  app.post('/', auth, async (req: any, reply: any) => {
    const { tenantId, role, supplierId, userId } = req.user
    if (!isSupplierRole(role)) return reply.status(403).send({ error: '仅供应商可上传发票' })
    if (!supplierId) return reply.status(400).send({ error: '当前账号未绑定供应商' })

    const parts = req.parts ? req.parts() : null
    if (!parts) return reply.status(400).send({ error: '需 multipart/form-data' })

    let fileUrl = ''
    let fileType = 'image'
    const fields: Record<string, string> = {}

    const ossClient = new OSS({
      region: process.env.OSS_REGION || 'oss-cn-hangzhou',
      accessKeyId: process.env.OSS_ACCESS_KEY_ID!,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET!,
      bucket: process.env.OSS_BUCKET || 'dianjie-upload',
    })

    for await (const part of parts) {
      if (part.type === 'file') {
        const buf = await part.toBuffer()
        if (buf.length > 10 * 1024 * 1024) {
          return reply.status(400).send({ error: '文件大小不能超过 10MB' })
        }
        const ts = Date.now()
        const ext = (part.filename?.split('.').pop() || 'jpg').toLowerCase()
        const key = `invoices/${supplierId}/${ts}-${Math.random().toString(36).slice(2, 8)}.${ext}`
        try {
          await ossClient.put(key, buf, {
            mime: part.mimetype,
            headers: { 'Cache-Control': 'public, max-age=31536000' },
          })
          fileUrl = `https://${process.env.OSS_BUCKET || 'dianjie-upload'}.oss-cn-hangzhou.aliyuncs.com/${key}`
        } catch (err: any) {
          req.log.error({ err }, 'OSS 上传失败')
          return reply.status(500).send({ error: 'OSS 上传失败: ' + err.message })
        }
        fileType = (part.mimetype || '').includes('pdf') ? 'pdf' : 'image'
      } else {
        fields[part.fieldname] = part.value as string
      }
    }

    if (!fileUrl) return reply.status(400).send({ error: '请上传发票文件' })
    const { invoiceNo, invoiceCode, amount, amountWithoutTax, taxRate, taxAmount, issueDate, note, receiptIds } = fields
    if (!invoiceNo) return reply.status(400).send({ error: '请填发票号码' })
    if (!amount || Number(amount) <= 0) return reply.status(400).send({ error: '请填开票金额' })
    if (!issueDate) return reply.status(400).send({ error: '请填开票日期' })

    const dup = await prisma.invoice.findFirst({ where: { tenantId, supplierId, invoiceNo } })
    if (dup) return reply.status(400).send({ error: '该发票号已上传' })

    const ids: string[] = receiptIds ? JSON.parse(receiptIds) : []
    if (ids.length > 0) {
      const valid = await prisma.receipt.findMany({
        where: { id: { in: ids }, tenantId, supplierId, invoiceId: null },
        select: { id: true, totalAmount: true },
      })
      if (valid.length !== ids.length) {
        return reply.status(400).send({ error: '部分订单不可关联(可能已绑发票或非本供应商)' })
      }
      // 校验:发票金额应等于关联订单合计 (允许 ¥1 容差)
      const orderSum = valid.reduce((s, r) => s + Number(r.totalAmount), 0)
      if (Math.abs(Number(amount) - orderSum) > 1) {
        return reply.status(400).send({
          error: `发票金额 ¥${amount} ≠ 关联订单合计 ¥${orderSum.toFixed(2)} (差额 ¥${Math.abs(Number(amount) - orderSum).toFixed(2)})`,
        })
      }
    }

    const inv = await prisma.invoice.create({
      data: {
        tenantId, supplierId,
        invoiceNo, invoiceCode: invoiceCode || null,
        amount: Number(amount),
        amountWithoutTax: amountWithoutTax ? Number(amountWithoutTax) : null,
        taxRate: taxRate ? Number(taxRate) : null,
        taxAmount: taxAmount ? Number(taxAmount) : null,
        issueDate: new Date(issueDate),
        fileUrl, fileType,
        note: note || null,
        uploadedById: userId,
        status: 'PENDING',
      },
    })
    if (ids.length > 0) {
      await prisma.receipt.updateMany({
        where: { id: { in: ids } },
        data: { invoiceId: inv.id },
      })
    }
    await prisma.opLog.create({
      data: { tenantId, userId, action: `上传发票 ${invoiceNo} ¥${amount} 关联 ${ids.length} 单`, entityType: 'Invoice', targetId: inv.id },
    })
    return reply.status(201).send(inv)
  })

  // ── 审核 ──────────────────────────────────────
  app.patch('/:id/verify', auth, async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!['ADMIN','SUPER_ADMIN','FINANCE'].includes(role)) {
      return reply.status(403).send({ error: '仅财务可审核' })
    }
    const { action, note } = req.body as any
    if (!['APPROVE', 'REJECT'].includes(action)) {
      return reply.status(400).send({ error: 'action 必须是 APPROVE 或 REJECT' })
    }
    if (action === 'REJECT' && !note?.trim()) {
      return reply.status(400).send({ error: '驳回必须填原因' })
    }
    const inv = await prisma.invoice.findFirst({
      where: { id: req.params.id, tenantId, status: 'PENDING' },
    })
    if (!inv) return reply.status(404).send({ error: '发票不存在或已审核' })

    if (action === 'APPROVE') {
      await prisma.invoice.update({
        where: { id: inv.id },
        data: { status: 'VERIFIED', reviewedById: userId, reviewedAt: new Date(), reviewNote: note || null },
      })
    } else {
      await prisma.invoice.update({
        where: { id: inv.id },
        data: { status: 'REJECTED', reviewedById: userId, reviewedAt: new Date(), reviewNote: note },
      })
      // 解关联, 让供应商可以重传
      await prisma.receipt.updateMany({
        where: { invoiceId: inv.id },
        data: { invoiceId: null },
      })
    }
    await prisma.opLog.create({
      data: { tenantId, userId,
        action: action === 'APPROVE' ? `审核通过发票 ${inv.invoiceNo}` : `驳回发票 ${inv.invoiceNo}: ${note}`,
        entityType: 'Invoice', targetId: inv.id },
    })
    return { success: true, action }
  })
}
