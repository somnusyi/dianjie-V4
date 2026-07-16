import { prisma } from '@dianjie/db'
import { autoProcessAfterConfirm } from './paymentSchedule'
import { createVoucher } from './voucher'

export interface ReceiptDerivativeResult {
  receiptId: string
  voucher: { ok: boolean; id: string | null; error?: string }
  finance: { ok: boolean; error?: string }
}

/**
 * Ensure that a confirmed receipt has all recoverable accounting side effects.
 * Receipt confirmation remains the source of truth, so the two independent,
 * idempotent derivative branches report errors instead of undoing receipt state.
 */
export async function ensureReceiptDerivatives(receiptId: string): Promise<ReceiptDerivativeResult> {
  const receipt = await prisma.receipt.findUnique({
    where: { id: receiptId },
    include: { supplier: true, store: true },
  })
  if (!receipt) throw new Error(`入库单不存在: ${receiptId}`)
  if (!receipt.confirmedAt) throw new Error(`入库单尚未确认: ${receipt.no}`)
  if (!['CONFIRMED', 'ACCOUNTED'].includes(receipt.status)) {
    throw new Error(`入库单状态不可生成财务派生: ${receipt.no}/${receipt.status}`)
  }

  let voucher: ReceiptDerivativeResult['voucher']
  try {
    const amount = Number(receipt.totalAmount)
    // 总仓属于内部调拨；沿用 paymentSchedule 的四方核对规则，不自动生成外部应付凭证。
    const id = amount > 0 && receipt.supplier.sourceType !== 'HEADQ_WAREHOUSE'
      ? await createVoucher({
          tenantId: receipt.tenantId,
          date: receipt.confirmedAt,
          summary: `${receipt.store.name} 收货 ${receipt.no} ${receipt.supplier.name}`,
          sourceType: 'Receipt',
          sourceId: receipt.id,
          createdById: receipt.createdById,
          entries: [
            { accountCode: '1405', accountName: '库存商品', debit: amount },
            { accountCode: '2202', accountName: '应付账款', credit: amount, summary: `应付 ${receipt.supplier.name}` },
          ],
          autoPost: true,
        })
      : null
    voucher = { ok: true, id }
  } catch (error: any) {
    voucher = { ok: false, id: null, error: error?.message || String(error) }
  }

  let finance: ReceiptDerivativeResult['finance']
  try {
    await autoProcessAfterConfirm({
      tenantId: receipt.tenantId,
      receipt: { ...receipt, confirmedAt: receipt.confirmedAt },
      supplier: receipt.supplier,
    })
    finance = { ok: true }
  } catch (error: any) {
    finance = { ok: false, error: error?.message || String(error) }
  }

  return { receiptId, voucher, finance }
}

/**
 * Bounded daily repair for confirmed receipts that left an incomplete derivative set.
 * Finance holes are selected relationally in SQL by Prisma; voucher holes use a
 * parameterized anti-join so a prefix of already-complete rows cannot starve later gaps.
 */
export async function repairReceiptDerivatives(options: { days?: number; limit?: number } = {}) {
  const days = Math.max(1, Math.min(options.days ?? 30, 365))
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const financeCandidates = await prisma.receipt.findMany({
    where: {
      confirmedAt: { gte: since },
      status: { in: ['CONFIRMED', 'ACCOUNTED'] },
      AND: [
        {
          OR: [
            { supplier: { sourceType: null } },
            { supplier: { sourceType: { not: 'HEADQ_WAREHOUSE' } } },
          ],
        },
        {
          OR: [
            { paymentSchedule: null },
            { reconciliationItems: { none: {} } },
            { status: { not: 'ACCOUNTED' } },
          ],
        },
      ],
    },
    select: { id: true },
    orderBy: { confirmedAt: 'asc' },
    take: limit,
  })
  const voucherCandidates = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT r.id
    FROM receipts r
    JOIN suppliers s ON s.id = r."supplierId"
    LEFT JOIN vouchers v
      ON v."tenantId" = r."tenantId"
      AND v."sourceType" = 'Receipt'
      AND v."sourceId" = r.id
    WHERE r."confirmedAt" >= ${since}
      AND r.status IN ('CONFIRMED', 'ACCOUNTED')
      AND r."totalAmount" > 0
      AND (s."sourceType" IS NULL OR s."sourceType" <> 'HEADQ_WAREHOUSE')
      AND v.id IS NULL
    ORDER BY r."confirmedAt" ASC
    LIMIT ${limit}
  `
  const incompleteIds = [...new Set([...financeCandidates, ...voucherCandidates].map(item => item.id))]

  let repaired = 0
  let failed = 0
  const failures: Array<{ receiptId: string; errors: string[] }> = []
  for (const receiptId of incompleteIds) {
    try {
      const result = await ensureReceiptDerivatives(receiptId)
      const errors = [result.voucher.error, result.finance.error].filter((item): item is string => Boolean(item))
      if (errors.length) {
        failed++
        failures.push({ receiptId, errors })
      } else {
        repaired++
      }
    } catch (error: any) {
      failed++
      failures.push({ receiptId, errors: [error?.message || String(error)] })
    }
  }

  return { scanned: financeCandidates.length + voucherCandidates.length, incomplete: incompleteIds.length, repaired, failed, failures }
}
