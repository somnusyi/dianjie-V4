import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'
import { ensureReceiptDerivatives, repairReceiptDerivatives } from '../src/services/receiptDerivatives'

const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 入库派生恢复验证仅允许本地 PREVIEW_MODE 隔离库')
  }
}

async function main() {
  assertLocalOnly()
  const suffix = Date.now().toString(36)
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const store = await prisma.store.create({
    data: { tenantId: tenant.id, no: `RDR-${suffix}`, name: `派生恢复门店-${suffix}` },
  })
  const supplier = await prisma.supplier.create({
    data: { tenantId: tenant.id, no: `RDRS-${suffix}`, name: `派生恢复供应商-${suffix}`, creditDays: 15 },
  })
  const headqSupplier = await prisma.supplier.create({
    data: {
      tenantId: tenant.id, no: `RDRH-${suffix}`, name: `派生恢复总仓-${suffix}`,
      sourceType: 'HEADQ_WAREHOUSE', creditDays: 0,
    },
  })
  const actor = await prisma.user.create({
    data: {
      tenantId: tenant.id, storeId: store.id, storeIds: [store.id], name: '派生恢复店长',
      email: `receipt-derivative-${suffix}@local.test`, password: await bcrypt.hash('local-only', 10), role: 'MANAGER',
    },
  })
  const orderIds: string[] = []
  const receiptIds: string[] = []
  const reconIds: string[] = []
  const financeFunction = `receipt_derivative_finance_${suffix}`
  const financeTrigger = `${financeFunction}_trigger`
  const voucherFunction = `receipt_derivative_voucher_${suffix}`
  const voucherTrigger = `${voucherFunction}_trigger`

  const createSource = async (label: string, amount: number, sourceSupplierId = supplier.id) => {
    const order = await prisma.purchaseOrder.create({
      data: {
        tenantId: tenant.id, no: `PO-RDR-${suffix}-${label}`, storeId: store.id, supplierId: sourceSupplierId,
        expectedDate: new Date(), totalAmount: amount, status: 'COMPLETED', autoConfirmed: true,
        receivedAt: new Date(), createdById: actor.id,
      },
    })
    orderIds.push(order.id)
    const receipt = await prisma.receipt.create({
      data: {
        tenantId: tenant.id, no: `RK-RDR-${suffix}-${label}`, storeId: store.id, supplierId: sourceSupplierId,
        purchaseOrderId: order.id, deliveryDate: new Date(), totalAmount: amount, status: 'CONFIRMED',
        confirmedAt: new Date(), createdById: actor.id,
      },
    })
    receiptIds.push(receipt.id)
    await prisma.purchaseOrder.update({ where: { id: order.id }, data: { receiptId: receipt.id } })
    return receipt
  }

  try {
    const financeReceipt = await createSource('FINANCE', 123.45)
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${financeFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."targetId" = '${financeReceipt.id}' AND NEW."entityType" = 'Receipt' THEN
          RAISE EXCEPTION 'forced receipt derivative audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${financeTrigger}" BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${financeFunction}"()
    `)
    const failedFinance = await ensureReceiptDerivatives(financeReceipt.id)
    assert.equal(failedFinance.voucher.ok, true, '凭证分支不应被财务分支故障阻断')
    assert.equal(failedFinance.finance.ok, false)
    assert.match(failedFinance.finance.error || '', /forced receipt derivative audit failure/)
    assert.equal(await prisma.paymentSchedule.count({ where: { receiptId: financeReceipt.id } }), 0)
    assert.equal(await prisma.reconciliationItem.count({ where: { receiptId: financeReceipt.id } }), 0)
    assert.equal((await prisma.receipt.findUniqueOrThrow({ where: { id: financeReceipt.id } })).status, 'CONFIRMED')
    assert.equal(await prisma.voucher.count({ where: { sourceType: 'Receipt', sourceId: financeReceipt.id } }), 1)
    await prisma.$executeRawUnsafe(`DROP TRIGGER "${financeTrigger}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION "${financeFunction}"()`)

    const repairedFinance = await repairReceiptDerivatives({ days: 1, limit: 50 })
    assert.ok(repairedFinance.repaired >= 1)
    assert.equal(await prisma.paymentSchedule.count({ where: { receiptId: financeReceipt.id } }), 1)
    assert.equal(await prisma.reconciliationItem.count({ where: { receiptId: financeReceipt.id } }), 1)
    assert.equal((await prisma.receipt.findUniqueOrThrow({ where: { id: financeReceipt.id } })).status, 'ACCOUNTED')
    assert.equal(await prisma.opLog.count({ where: { entityType: 'Receipt', targetId: financeReceipt.id, action: { startsWith: '自动补全入库财务派生' } } }), 1)

    const headqReceipt = await createSource('HEADQ', 88.88, headqSupplier.id)
    const headqResult = await ensureReceiptDerivatives(headqReceipt.id)
    assert.equal(headqResult.voucher.ok, true)
    assert.equal(headqResult.voucher.id, null, '总仓内部调拨不得生成外部应付凭证')
    assert.equal(headqResult.finance.ok, true)
    assert.equal(await prisma.voucher.count({ where: { sourceType: 'Receipt', sourceId: headqReceipt.id } }), 0)
    assert.equal(await prisma.paymentSchedule.count({ where: { receiptId: headqReceipt.id } }), 0)
    assert.equal(await prisma.reconciliationItem.count({ where: { receiptId: headqReceipt.id } }), 0)

    const lossReceipt = await createSource('LOSS', 55.55)
    await prisma.lossClaim.create({
      data: {
        tenantId: tenant.id,
        no: `LC-RDR-${suffix}`,
        kind: 'ARRIVAL_SHORTAGE',
        payableBasis: 'NET_AT_RECEIPT',
        purchaseOrderId: lossReceipt.purchaseOrderId,
        receiptId: lossReceipt.id,
        storeId: store.id,
        supplierId: supplier.id,
        totalLossAmount: 5.55,
        description: '派生恢复冻结验证',
        status: 'PENDING',
        createdById: actor.id,
      },
    })
    const lossResult = await ensureReceiptDerivatives(lossReceipt.id)
    assert.equal(lossResult.finance.ok, true)
    assert.equal((await prisma.paymentSchedule.findUniqueOrThrow({
      where: { receiptId: lossReceipt.id },
    })).status, 'ON_HOLD', '新建争议入库账期必须在财务事务内直接冻结')
    await prisma.paymentSchedule.update({
      where: { receiptId: lossReceipt.id },
      data: { status: 'PENDING' },
    })
    await ensureReceiptDerivatives(lossReceipt.id)
    assert.equal((await prisma.paymentSchedule.findUniqueOrThrow({
      where: { receiptId: lossReceipt.id },
    })).status, 'ON_HOLD', '重复补偿必须恢复遗漏的争议账期冻结')

    const voucherReceipt = await createSource('VOUCHER', 67.89)
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${voucherFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."sourceType" = 'Receipt' AND NEW."sourceId" = '${voucherReceipt.id}' THEN
          RAISE EXCEPTION 'forced receipt voucher failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${voucherTrigger}" BEFORE INSERT ON "vouchers"
      FOR EACH ROW EXECUTE FUNCTION "${voucherFunction}"()
    `)
    const failedVoucher = await ensureReceiptDerivatives(voucherReceipt.id)
    assert.equal(failedVoucher.voucher.ok, false)
    assert.match(failedVoucher.voucher.error || '', /forced receipt voucher failure/)
    assert.equal(failedVoucher.finance.ok, true, '财务分支不应被凭证分支故障阻断')
    assert.equal(await prisma.paymentSchedule.count({ where: { receiptId: voucherReceipt.id } }), 1)
    assert.equal(await prisma.reconciliationItem.count({ where: { receiptId: voucherReceipt.id } }), 1)
    assert.equal(await prisma.voucher.count({ where: { sourceType: 'Receipt', sourceId: voucherReceipt.id } }), 0)
    assert.equal(await prisma.voucherGenerationFailure.count({
      where: { tenantId: tenant.id, sourceType: 'Receipt', sourceId: voucherReceipt.id, resolved: false },
    }), 1)
    await prisma.$executeRawUnsafe(`DROP TRIGGER "${voucherTrigger}" ON "vouchers"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION "${voucherFunction}"()`)

    const repairedVoucher = await repairReceiptDerivatives({ days: 1, limit: 50 })
    assert.ok(repairedVoucher.repaired >= 1)
    assert.equal(await prisma.voucher.count({ where: { sourceType: 'Receipt', sourceId: voucherReceipt.id } }), 1)
    assert.equal(await prisma.voucherGenerationFailure.count({
      where: { tenantId: tenant.id, sourceType: 'Receipt', sourceId: voucherReceipt.id, resolved: false },
    }), 0)

    await Promise.all([ensureReceiptDerivatives(financeReceipt.id), ensureReceiptDerivatives(financeReceipt.id)])
    assert.equal(await prisma.paymentSchedule.count({ where: { receiptId: financeReceipt.id } }), 1)
    assert.equal(await prisma.reconciliationItem.count({ where: { receiptId: financeReceipt.id } }), 1)
    assert.equal(await prisma.voucher.count({ where: { sourceType: 'Receipt', sourceId: financeReceipt.id } }), 1)
    assert.equal(await prisma.opLog.count({ where: { entityType: 'Receipt', targetId: financeReceipt.id, action: { startsWith: '自动补全入库财务派生' } } }), 1)

    console.log(JSON.stringify({
      ok: true,
      independentDerivativeBranches: true,
      financeAuditFailureRollsBack: true,
      dailyRepairRecoversFinance: true,
      dailyRepairRecoversVoucherAndResolvesFailure: true,
      concurrentRetryIdempotent: true,
      headqInternalTransferSkipped: true,
      lossScheduleHeldOnCreate: true,
      lossScheduleHoldRecovered: true,
    }))
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${financeTrigger}" ON "op_logs"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${financeFunction}"()`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${voucherTrigger}" ON "vouchers"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${voucherFunction}"()`).catch(() => {})
    const reconItems = await prisma.reconciliationItem.findMany({
      where: { receiptId: { in: receiptIds } }, select: { reconciliationId: true },
    })
    reconIds.push(...reconItems.map(item => item.reconciliationId))
    const voucherRows = await prisma.voucher.findMany({
      where: { sourceType: 'Receipt', sourceId: { in: receiptIds } }, select: { id: true },
    })
    await prisma.$transaction(async tx => {
      await tx.voucherEntry.deleteMany({ where: { voucherId: { in: voucherRows.map(item => item.id) } } })
      await tx.voucher.deleteMany({ where: { id: { in: voucherRows.map(item => item.id) } } })
      await tx.voucherGenerationFailure.deleteMany({ where: { tenantId: tenant.id, sourceType: 'Receipt', sourceId: { in: receiptIds } } })
      await tx.opLog.deleteMany({ where: { tenantId: tenant.id, OR: [{ targetId: { in: receiptIds } }, { userId: actor.id }] } })
      await tx.notification.deleteMany({ where: { tenantId: tenant.id, refId: { in: receiptIds } } })
      await tx.paymentSchedule.deleteMany({ where: { receiptId: { in: receiptIds } } })
      await tx.reconciliationItem.deleteMany({ where: { receiptId: { in: receiptIds } } })
      await tx.reconciliation.deleteMany({ where: { id: { in: reconIds } } })
      await tx.lossClaim.deleteMany({ where: { receiptId: { in: receiptIds } } })
      await tx.purchaseOrder.updateMany({ where: { id: { in: orderIds } }, data: { receiptId: null } })
      await tx.receipt.deleteMany({ where: { id: { in: receiptIds } } })
      await tx.purchaseOrder.deleteMany({ where: { id: { in: orderIds } } })
      await tx.user.delete({ where: { id: actor.id } })
      await tx.store.delete({ where: { id: store.id } })
      await tx.supplier.delete({ where: { id: headqSupplier.id } })
      await tx.supplier.delete({ where: { id: supplier.id } })
    })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
