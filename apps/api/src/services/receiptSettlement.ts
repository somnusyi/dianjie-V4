import { Prisma } from '@dianjie/db'

type ScheduleStatus =
  | 'PENDING'
  | 'NOTIFIED'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'PROCESSING'
  | 'PAID'
  | 'OVERDUE'
  | 'CANCELLED'
  | 'ON_HOLD'

/**
 * Keep every mutable settlement projection of one confirmed receipt aligned.
 * Receipt.totalAmount remains the immutable confirmed-receipt fact; accepted
 * post-receipt differences are represented in schedule/reconciliation/payment.
 */
export async function setReceiptSettlementAmountInTransaction(
  tx: Prisma.TransactionClient,
  input: { receiptId: string; amount: Prisma.Decimal.Value; scheduleStatus: ScheduleStatus },
) {
  const amount = new Prisma.Decimal(input.amount).toDecimalPlaces(2)
  if (amount.lt(0)) throw { statusCode: 409, message: '结算金额不能小于 0' }

  const item = await tx.reconciliationItem.findUnique({
    where: { receiptId: input.receiptId },
    include: {
      reconciliation: {
        include: { payments: { select: { id: true, status: true } } },
      },
    },
  })
  if (item?.reconciliation.payments.some(payment => ['PAYING', 'PAID'].includes(payment.status))) {
    throw { statusCode: 409, message: '该收货单已进入付款或已付款，不能自动调整结算金额' }
  }

  const schedule = await tx.paymentSchedule.update({
    where: { receiptId: input.receiptId },
    data: { amount, status: input.scheduleStatus },
  })

  if (!item) return { schedule, reconciliation: null }

  await tx.reconciliationItem.update({ where: { id: item.id }, data: { amount } })
  const aggregate = await tx.reconciliationItem.aggregate({
    where: { reconciliationId: item.reconciliationId },
    _sum: { amount: true },
  })
  const reconciliationTotal = new Prisma.Decimal(aggregate._sum.amount || 0).toDecimalPlaces(2)
  const reconciliation = await tx.reconciliation.update({
    where: { id: item.reconciliationId },
    data: { totalAmount: reconciliationTotal },
  })
  await tx.payment.updateMany({
    where: { reconciliationId: item.reconciliationId, status: { in: ['UNPAID', 'FAILED'] } },
    data: { amount: reconciliationTotal },
  })
  return { schedule, reconciliation }
}
