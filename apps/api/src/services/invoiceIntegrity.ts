import { Prisma, prisma } from '@dianjie/db'

export interface SupplierInvoiceData {
  tenantId: string
  supplierId: string
  uploadedById: string
  role: string
  invoiceNo: string
  invoiceCode: string | null
  amount: Prisma.Decimal
  amountWithoutTax: Prisma.Decimal | null
  taxRate: Prisma.Decimal | null
  taxAmount: Prisma.Decimal | null
  issueDate: Date
  fileUrl: string
  fileType: 'image' | 'pdf'
  note: string | null
  receiptIds: string[]
}

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode })
}

function normalizedText(value: string | null | undefined) {
  const trimmed = value?.trim()
  return trimmed || null
}

function sameInvoice(existing: any, input: SupplierInvoiceData, receiptIds: string[]) {
  const existingReceiptIds = existing.receipts.map((receipt: { id: string }) => receipt.id).sort()
  return existing.amount.equals(input.amount)
    && normalizedText(existing.invoiceCode) === input.invoiceCode
    && (existing.amountWithoutTax === null
      ? input.amountWithoutTax === null
      : input.amountWithoutTax !== null && existing.amountWithoutTax.equals(input.amountWithoutTax))
    && (existing.taxRate === null
      ? input.taxRate === null
      : input.taxRate !== null && existing.taxRate.equals(input.taxRate))
    && (existing.taxAmount === null
      ? input.taxAmount === null
      : input.taxAmount !== null && existing.taxAmount.equals(input.taxAmount))
    && existing.issueDate.toISOString().slice(0, 10) === input.issueDate.toISOString().slice(0, 10)
    && normalizedText(existing.note) === input.note
    && existingReceiptIds.length === receiptIds.length
    && existingReceiptIds.every((id: string, index: number) => id === receiptIds[index])
}

export async function createSupplierInvoice(input: SupplierInvoiceData) {
  const receiptIds = [...new Set(input.receiptIds)].sort()
  if (receiptIds.length !== input.receiptIds.length) throw httpError('关联入库单不能重复', 400)
  if (receiptIds.length === 0) throw httpError('请至少关联一张已确认入库单', 400)

  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-number:${input.tenantId}:${input.supplierId}:${input.invoiceNo}`}))`
    for (const receiptId of receiptIds) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-receipt:${receiptId}`}))`
    }

    const supplier = await tx.supplier.findFirst({
      where: { id: input.supplierId, tenantId: input.tenantId, status: 'ENABLED' }, select: { id: true },
    })
    if (!supplier) throw httpError('供应商不存在或已停用', 409)

    const existing = await tx.invoice.findFirst({
      where: {
        tenantId: input.tenantId, supplierId: input.supplierId, invoiceNo: input.invoiceNo,
      },
      include: {
        receipts: { select: { id: true, totalAmount: true, status: true, supplierId: true } },
      },
    })
    if (existing) {
      if (sameInvoice(existing, input, receiptIds)) return { invoice: existing, duplicated: true }
      throw httpError('该发票号码已存在，且上传参数不同', 409)
    }

    const receipts = await tx.receipt.findMany({
      where: {
        id: { in: receiptIds }, tenantId: input.tenantId, supplierId: input.supplierId,
        invoiceId: null, status: { in: ['CONFIRMED', 'ACCOUNTED'] },
      },
      orderBy: { id: 'asc' }, select: { id: true, no: true, totalAmount: true },
    })
    if (receipts.length !== receiptIds.length) {
      throw httpError('部分入库单不可关联：可能未确认、已绑定发票或不属于当前供应商', 409)
    }
    const receiptTotal = receipts.reduce(
      (sum, receipt) => sum.add(receipt.totalAmount), new Prisma.Decimal(0),
    ).toDecimalPlaces(2)
    if (!receiptTotal.equals(input.amount)) {
      throw httpError(
        `发票金额 ¥${input.amount.toFixed(2)} 与关联入库单合计 ¥${receiptTotal.toFixed(2)} 不一致`, 400,
      )
    }

    const invoice = await tx.invoice.create({
      data: {
        tenantId: input.tenantId, supplierId: input.supplierId,
        invoiceNo: input.invoiceNo, invoiceCode: input.invoiceCode,
        amount: input.amount, amountWithoutTax: input.amountWithoutTax,
        taxRate: input.taxRate, taxAmount: input.taxAmount,
        issueDate: input.issueDate, fileUrl: input.fileUrl, fileType: input.fileType,
        note: input.note, uploadedById: input.uploadedById, status: 'PENDING',
      },
    })
    const linked = await tx.receipt.updateMany({
      where: {
        id: { in: receiptIds }, tenantId: input.tenantId, supplierId: input.supplierId,
        invoiceId: null, status: { in: ['CONFIRMED', 'ACCOUNTED'] },
      },
      data: { invoiceId: invoice.id },
    })
    if (linked.count !== receiptIds.length) {
      throw httpError('入库单状态已变化，发票未保存', 409)
    }
    await tx.opLog.create({
      data: {
        tenantId: input.tenantId, userId: input.uploadedById, role: input.role,
        action: `上传发票 ${input.invoiceNo} ¥${input.amount.toFixed(2)} 关联 ${receiptIds.length} 单`,
        target: input.invoiceNo, entityType: 'Invoice', targetId: invoice.id,
        metadata: { supplierId: input.supplierId, receiptIds, amount: input.amount.toFixed(2) },
      },
    })
    return { invoice: { ...invoice, receipts: receipts.map(receipt => ({ id: receipt.id })) }, duplicated: false }
  })
}

export async function reviewInvoice(input: {
  tenantId: string
  invoiceId: string
  userId: string
  role: string
  action: 'APPROVE' | 'REJECT'
  note: string | null
}) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-review:${input.invoiceId}`}))`
    const invoice = await tx.invoice.findFirst({
      where: { id: input.invoiceId, tenantId: input.tenantId },
      include: {
        receipts: { select: { id: true, totalAmount: true, status: true, supplierId: true } },
      },
    })
    if (!invoice) throw httpError('发票不存在', 404)
    const targetStatus = input.action === 'APPROVE' ? 'VERIFIED' : 'REJECTED'
    if (invoice.status !== 'PENDING') {
      const priorLog = await tx.opLog.findFirst({
        where: {
          tenantId: input.tenantId, userId: input.userId,
          entityType: 'Invoice', targetId: invoice.id,
          metadata: { path: ['action'], equals: input.action },
        },
        select: { id: true },
      })
      if (invoice.status === targetStatus && normalizedText(invoice.reviewNote) === input.note && priorLog) {
        return { success: true, action: input.action, status: targetStatus, duplicated: true }
      }
      throw httpError(`发票当前状态 ${invoice.status}，不可重复审核`, 409)
    }

    if (input.action === 'APPROVE') {
      if (invoice.receipts.length === 0) throw httpError('发票未关联入库单，不能审核通过', 409)
      if (invoice.receipts.some(receipt => !['CONFIRMED', 'ACCOUNTED'].includes(receipt.status)
        || receipt.supplierId !== invoice.supplierId)) {
        throw httpError('关联入库单状态或供应商已变化，不能审核通过', 409)
      }
      const receiptTotal = invoice.receipts.reduce(
        (sum, receipt) => sum.add(receipt.totalAmount), new Prisma.Decimal(0),
      ).toDecimalPlaces(2)
      if (!receiptTotal.equals(invoice.amount)) {
        throw httpError(
          `发票金额 ¥${invoice.amount.toFixed(2)} 与当前关联入库单合计 ¥${receiptTotal.toFixed(2)} 不一致`, 409,
        )
      }
    }

    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        status: targetStatus, reviewedById: input.userId,
        reviewedAt: new Date(), reviewNote: input.note,
      },
    })
    if (input.action === 'REJECT') {
      await tx.receipt.updateMany({
        where: { tenantId: input.tenantId, invoiceId: invoice.id }, data: { invoiceId: null },
      })
    }
    await tx.opLog.create({
      data: {
        tenantId: input.tenantId, userId: input.userId, role: input.role,
        action: input.action === 'APPROVE'
          ? `审核通过发票 ${invoice.invoiceNo}`
          : `驳回发票 ${invoice.invoiceNo}: ${input.note}`,
        target: invoice.invoiceNo, entityType: 'Invoice', targetId: invoice.id,
        metadata: {
          action: input.action, note: input.note, previousStatus: invoice.status,
          targetStatus, receiptCount: invoice.receipts.length,
        },
      },
    })
    return { success: true, action: input.action, status: targetStatus, duplicated: false }
  })
}
