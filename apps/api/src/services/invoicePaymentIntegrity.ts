import { randomUUID } from 'node:crypto'
import dayjs from 'dayjs'
import { Prisma, prisma } from '@dianjie/db'
import { cashLedgerAccount, writeCashTransaction } from './cashbook'
import { lockSchedulesForInvoicePayment } from './paymentMutex'
import { createVoucher } from './voucher'

const ACCOUNT_TYPE_BY_METHOD: Record<string, 'BANK' | 'ALIPAY' | 'WECHAT' | 'CASH'> = {
  cmb: 'BANK',
  manual: 'BANK',
  wechat: 'WECHAT',
  alipay: 'ALIPAY',
  cash: 'CASH',
}

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode })
}

function normalizedText(value: string | null | undefined) {
  const trimmed = value?.trim()
  return trimmed || null
}

function isUniqueConflict(error: any) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export type CreateInvoicePaymentInput = {
  tenantId: string
  userId: string
  role: string
  invoiceId: string
  amount: Prisma.Decimal
  paymentMethod: string
  requestId?: string | null
  note?: string | null
}

export async function createInvoicePayment(input: CreateInvoicePaymentInput) {
  const requestId = input.requestId || randomUUID()
  const note = normalizedText(input.note)
  try {
    return await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-payment-request:${input.tenantId}:${requestId}`}))`
      const existing = await tx.invoicePayment.findFirst({
        where: { tenantId: input.tenantId, requestId },
      })
      if (existing) {
        const same = existing.invoiceId === input.invoiceId
          && existing.amount.equals(input.amount)
          && existing.paymentMethod === input.paymentMethod
          && normalizedText(existing.note) === note
        if (!same) throw httpError('该付款操作号已使用，且付款参数不同', 409)
        return { payment: existing, duplicated: true }
      }

      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "invoices"
        WHERE "id" = ${input.invoiceId} AND "tenantId" = ${input.tenantId}
        FOR UPDATE
      `)
      if (locked.length !== 1) throw httpError('发票不存在', 404)
      const invoice = await tx.invoice.findFirst({
        where: { id: input.invoiceId, tenantId: input.tenantId, status: 'VERIFIED' },
        include: { payments: { where: { status: { in: ['PENDING', 'SUCCESS'] } } } },
      })
      if (!invoice) throw httpError('发票不存在或未审核通过', 404)
      if (invoice.fullyPaidAt) throw httpError('该发票已付清', 409)
      const reserved = invoice.payments.reduce(
        (sum, payment) => sum.plus(payment.amount),
        new Prisma.Decimal(0),
      )
      const available = invoice.amount.minus(reserved)
      if (input.amount.greaterThan(available)) {
        throw httpError(
          `本次付款 ¥${input.amount.toFixed(2)} 超过剩余可付 ¥${available.toFixed(2)}`,
          409,
        )
      }

      const { cancelledCount } = await lockSchedulesForInvoicePayment(
        tx, input.invoiceId, input.userId,
      )
      const payment = await tx.invoicePayment.create({
        data: {
          tenantId: input.tenantId,
          invoiceId: input.invoiceId,
          amount: input.amount,
          paymentMethod: input.paymentMethod,
          requestId,
          status: 'PENDING',
          initiatedById: input.userId,
          note,
        },
      })
      await tx.opLog.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          role: input.role,
          action: `发起发票付款 #${invoice.invoiceNo} ¥${input.amount.toFixed(2)}`
            + (cancelledCount > 0 ? ` · 锁定 ${cancelledCount} 条关联账期` : ''),
          entityType: 'InvoicePayment',
          targetId: payment.id,
          metadata: {
            invoiceId: invoice.id,
            requestId,
            paymentMethod: input.paymentMethod,
            amount: input.amount.toFixed(2),
            availableAfter: available.minus(input.amount).toFixed(2),
          },
        },
      })
      return { payment, duplicated: false }
    })
  } catch (error: any) {
    if (!isUniqueConflict(error)) throw error
    const existing = await prisma.invoicePayment.findFirst({
      where: { tenantId: input.tenantId, requestId },
    })
    if (existing
      && existing.invoiceId === input.invoiceId
      && existing.amount.equals(input.amount)
      && existing.paymentMethod === input.paymentMethod
      && normalizedText(existing.note) === note) {
      return { payment: existing, duplicated: true }
    }
    throw httpError('付款操作号或外部流水发生冲突，请刷新后重试', 409)
  }
}

type SuccessInput = {
  tenantId: string
  userId: string
  role: string
  paymentId: string
  accountId: string
  paidAt: string
  bankTxNo?: string | null
  note?: string | null
}

async function ensureInvoicePaymentVoucher(result: {
  tenantId: string
  userId: string
  paymentId: string
  invoiceNo: string
  supplierName: string
  amount: Prisma.Decimal
  paidAt: Date
  account: { name: string; type: string; accountNo: string | null; cmbBindAccount: string | null }
}) {
  const legacy = await prisma.voucher.findFirst({
    where: {
      tenantId: result.tenantId,
      sourceId: result.paymentId,
      sourceType: { in: ['InvoicePayment', 'Payment'] },
    },
    select: { id: true },
  })
  if (legacy) return legacy.id
  const ledger = cashLedgerAccount(result.account)
  return createVoucher({
    tenantId: result.tenantId,
    date: result.paidAt,
    summary: `发票付款 ${result.invoiceNo} ${result.supplierName}`,
    sourceType: 'InvoicePayment',
    sourceId: result.paymentId,
    entries: [
      { accountCode: '2202', accountName: '应付账款', debit: Number(result.amount), summary: `应付 ${result.supplierName}` },
      { accountCode: ledger.code, accountName: ledger.name, credit: Number(result.amount) },
    ],
    createdById: result.userId,
    autoPost: true,
  })
}

export async function confirmInvoicePaymentSuccess(input: SuccessInput) {
  const bankTxNo = normalizedText(input.bankTxNo)
  const note = normalizedText(input.note)
  const result = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-payment:${input.paymentId}`}))`
    if (bankTxNo) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-payment-reference:${input.tenantId}:${bankTxNo}`}))`
    }
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "invoice_payments"
      WHERE "id" = ${input.paymentId} AND "tenantId" = ${input.tenantId}
      FOR UPDATE
    `)
    if (locked.length !== 1) throw httpError('付款单不存在', 404)
    const payment = await tx.invoicePayment.findUniqueOrThrow({
      where: { id: input.paymentId },
      include: { invoice: { include: { supplier: { select: { name: true } } } } },
    })
    const expectedType = ACCOUNT_TYPE_BY_METHOD[payment.paymentMethod]
    if (!expectedType) throw httpError(`不支持的付款方式 ${payment.paymentMethod}`, 409)
    const account = await tx.cashAccount.findFirst({
      where: { id: input.accountId, tenantId: input.tenantId, status: 'ACTIVE' },
      select: { id: true, name: true, type: true, accountNo: true, cmbBindAccount: true },
    })
    if (!account) throw httpError('付款账户不存在或已停用', 409)
    if (account.type !== expectedType) {
      throw httpError(`付款方式与资金账户类型不匹配，应选择 ${expectedType} 账户`, 400)
    }
    if (expectedType !== 'CASH' && !bankTxNo) {
      throw httpError('非现金付款必须填写实际支付流水号', 400)
    }
    const paidAt = new Date(`${input.paidAt}T00:00:00.000+08:00`)
    const cashNote = `${payment.invoice.supplier.name} 发票 ${payment.invoice.invoiceNo}`
      + (bankTxNo ? ` 流水 ${bankTxNo}` : '')
      + (note ? ` · ${note}` : '')

    if (payment.status === 'SUCCESS') {
      const cashTx = await tx.cashTransaction.findFirst({
        where: { tenantId: input.tenantId, refType: 'InvoicePayment', refId: payment.id },
        orderBy: { createdAt: 'asc' },
      })
      if (!cashTx) throw httpError('付款已完成但缺少资金流水，请联系管理员修复', 409)
      const same = payment.cashAccountId === input.accountId
        && dayjs(payment.paidAt).format('YYYY-MM-DD') === input.paidAt
        && normalizedText(payment.bankTxNo) === bankTxNo
        && normalizedText(cashTx.note) === cashNote
      if (!same) throw httpError('付款已完成，重复请求参数与原记录不一致', 409)
      return {
        duplicated: true,
        payment,
        invoiceNo: payment.invoice.invoiceNo,
        supplierName: payment.invoice.supplier.name,
        paidAt,
        account,
        cashTransactionId: cashTx.id,
      }
    }
    if (payment.status !== 'PENDING') {
      throw httpError(`付款单当前状态 ${payment.status}，不能确认成功`, 409)
    }
    if (bankTxNo) {
      const duplicate = await tx.invoicePayment.findFirst({
        where: { tenantId: input.tenantId, bankTxNo, id: { not: payment.id } },
        select: { id: true },
      })
      if (duplicate) throw httpError('支付流水号已被其他发票付款使用', 409)
    }
    const invoiceRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "invoices"
      WHERE "id" = ${payment.invoiceId} AND "tenantId" = ${input.tenantId}
      FOR UPDATE
    `)
    if (invoiceRows.length !== 1) throw httpError('发票不存在', 404)
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: payment.invoiceId } })
    const newPaid = invoice.paidAmount.plus(payment.amount)
    if (newPaid.greaterThan(invoice.amount)) {
      throw httpError('付款累计超过发票金额，已阻断到账确认', 409)
    }
    const cashTx = await writeCashTransaction(tx, {
      tenantId: input.tenantId,
      accountId: input.accountId,
      direction: -1,
      category: '发票付款',
      amount: Number(payment.amount),
      note: cashNote,
      txDate: paidAt,
      refType: 'InvoicePayment',
      refId: payment.id,
      createdById: input.userId,
    })
    if (!cashTx) throw new Error('资金账户写入失败')
    const updated = await tx.invoicePayment.update({
      where: { id: payment.id },
      data: {
        status: 'SUCCESS',
        paidAt,
        bankTxNo,
        cashAccountId: input.accountId,
        failReason: null,
      },
      include: { invoice: { include: { supplier: { select: { name: true } } } } },
    })
    await tx.invoice.update({
      where: { id: payment.invoiceId },
      data: { paidAmount: newPaid, fullyPaidAt: newPaid.equals(invoice.amount) ? paidAt : null },
    })
    await tx.opLog.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        role: input.role,
        action: `确认发票付款到账 ¥${payment.amount.toFixed(2)}`,
        entityType: 'InvoicePayment',
        targetId: payment.id,
        metadata: {
          invoiceId: payment.invoiceId,
          accountId: input.accountId,
          cashTransactionId: cashTx.id,
          bankTxNo,
          paidAt: input.paidAt,
          note,
        },
      },
    })
    return {
      duplicated: false,
      payment: updated,
      invoiceNo: updated.invoice.invoiceNo,
      supplierName: updated.invoice.supplier.name,
      paidAt,
      account,
      cashTransactionId: cashTx.id,
    }
  })

  let voucherId: string | null = null
  let voucherWarning: string | null = null
  try {
    voucherId = await ensureInvoicePaymentVoucher({
      tenantId: input.tenantId,
      userId: input.userId,
      paymentId: result.payment.id,
      invoiceNo: result.invoiceNo,
      supplierName: result.supplierName,
      amount: result.payment.amount,
      paidAt: result.paidAt,
      account: result.account,
    })
    if (!voucherId) voucherWarning = '付款已完成，但凭证生成失败；可用相同参数重试补建'
  } catch {
    voucherWarning = '付款已完成，但凭证生成失败；可用相同参数重试补建或在失败队列处理'
  }
  return { ...result, voucherId, voucherWarning }
}

export async function failInvoicePayment(input: {
  tenantId: string
  userId: string
  role: string
  paymentId: string
  failReason: string
}) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-payment:${input.paymentId}`}))`
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "invoice_payments"
      WHERE "id" = ${input.paymentId} AND "tenantId" = ${input.tenantId}
      FOR UPDATE
    `)
    if (rows.length !== 1) throw httpError('付款单不存在', 404)
    const payment = await tx.invoicePayment.findUniqueOrThrow({ where: { id: input.paymentId } })
    if (payment.status === 'FAILED') {
      if (normalizedText(payment.failReason) !== normalizedText(input.failReason)) {
        throw httpError('付款已标记失败，重复请求原因不一致', 409)
      }
      return { payment, duplicated: true }
    }
    if (payment.status !== 'PENDING') {
      throw httpError(`付款单当前状态 ${payment.status}，不能确认失败`, 409)
    }
    const updated = await tx.invoicePayment.update({
      where: { id: payment.id }, data: { status: 'FAILED', failReason: input.failReason },
    })
    await tx.opLog.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        role: input.role,
        action: `发票付款失败 ¥${payment.amount.toFixed(2)} · ${input.failReason}`,
        entityType: 'InvoicePayment',
        targetId: payment.id,
        metadata: { failReason: input.failReason },
      },
    })
    return { payment: updated, duplicated: false }
  })
}

export async function cancelInvoicePayment(input: {
  tenantId: string
  userId: string
  role: string
  paymentId: string
  reason?: string | null
}) {
  const reason = normalizedText(input.reason)
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-payment:${input.paymentId}`}))`
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "invoice_payments"
      WHERE "id" = ${input.paymentId} AND "tenantId" = ${input.tenantId}
      FOR UPDATE
    `)
    if (rows.length !== 1) throw httpError('付款单不存在', 404)
    const payment = await tx.invoicePayment.findUniqueOrThrow({ where: { id: input.paymentId } })
    if (payment.status === 'CANCELED') return { payment, duplicated: true }
    if (payment.status !== 'PENDING') {
      throw httpError(`付款单当前状态 ${payment.status}，不可取消`, 409)
    }
    const updated = await tx.invoicePayment.update({
      where: { id: payment.id }, data: { status: 'CANCELED' },
    })
    await tx.opLog.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        role: input.role,
        action: `取消发票付款 ¥${payment.amount.toFixed(2)}${reason ? ` · ${reason}` : ''}`,
        entityType: 'InvoicePayment',
        targetId: payment.id,
        metadata: { reason },
      },
    })
    return { payment: updated, duplicated: false }
  })
}
