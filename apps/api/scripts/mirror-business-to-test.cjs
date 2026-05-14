// 自动同步 dianjie 业务流水 → test tenant (cron 03:00 跑)
// CommonJS 版 (服务器没 tsx, node 直接跑)
// 触发: /app/dianjie-v4/scripts/cron-mirror-to-test.sh
// 依赖: cwd 下有 .env 文件 (DATABASE_URL 含 & 字符 bash source 会截断, 必须用 dotenv)

const path = require('path')
require('dotenv').config({
  path: process.env.DOTENV_PATH || path.resolve(process.cwd(), '.env'),
})
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL 没读到, 检查 cwd .env 或 DOTENV_PATH')
  process.exit(1)
}

const { prisma } = require('@dianjie/db')

const ROLE_TO_TEST_PHONE = {
  ADMIN:          '13900000003',
  MANAGER:        '13900000004',
  KITCHEN_LEAD:   '13900000005',
  CHEF_DIRECTOR:  '13900000002',
  FINANCE:        '13900000006',
  ENGINEERING:    '13900000007',
  SUPPLIER_OWNER: '13900000001',
  SUPPLIER_STAFF: '13900000008',
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  cron mirror dianjie → test`)
  console.log(`  started at ${new Date().toISOString()}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  await prisma.$transaction(async (tx) => {
    const dianjie = await tx.tenant.findUnique({ where: { slug: 'dianjie' } })
    const test    = await tx.tenant.findUnique({ where: { slug: 'test' } })
    if (!dianjie || !test) throw new Error('dianjie 或 test tenant 不存在')

    // ─ 0. 清 test tenant 旧业务流水 ────────────────────
    const oldPOs      = await tx.purchaseOrder.findMany({ where: { tenantId: test.id }, select: { id: true } })
    const oldReceipts = await tx.receipt.findMany({ where: { tenantId: test.id }, select: { id: true } })
    await tx.paymentSchedule.deleteMany({ where: { tenantId: test.id } })
    if (oldReceipts.length) {
      await tx.receiptItem.deleteMany({ where: { receiptId: { in: oldReceipts.map(r => r.id) } } })
      await tx.receipt.deleteMany({ where: { tenantId: test.id } })
    }
    if (oldPOs.length) {
      await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: { in: oldPOs.map(p => p.id) } } })
      await tx.purchaseOrder.deleteMany({ where: { tenantId: test.id } })
    }
    console.log(`✓ wipe test: ${oldPOs.length} PO + ${oldReceipts.length} Receipt`)

    // ─ 1. 映射表 (store / supplier / product / user) ──
    const dStores = await tx.store.findMany({ where: { tenantId: dianjie.id } })
    const tStores = await tx.store.findMany({ where: { tenantId: test.id } })
    const storeMap = {}
    for (const s of dStores) { const t = tStores.find(x => x.no === s.no); if (t) storeMap[s.id] = t.id }

    const dSups = await tx.supplier.findMany({ where: { tenantId: dianjie.id } })
    const tSups = await tx.supplier.findMany({ where: { tenantId: test.id } })
    const supMap = {}
    for (const s of dSups) { const t = tSups.find(x => x.no === s.no); if (t) supMap[s.id] = t.id }

    const tProducts = await tx.product.findMany({ where: { tenantId: test.id }, select: { id: true, code: true } })
    const tProductByCode = Object.fromEntries(tProducts.map(p => [p.code, p.id]))
    const dProducts = await tx.product.findMany({ where: { tenantId: dianjie.id }, select: { id: true, code: true } })
    const productMap = {}
    for (const p of dProducts) if (tProductByCode[p.code]) productMap[p.id] = tProductByCode[p.code]

    const tTestUsers = await tx.user.findMany({
      where: { tenantId: test.id, phone: { in: Object.values(ROLE_TO_TEST_PHONE) } },
    })
    const testUserByPhone = {}
    for (const u of tTestUsers) if (u.phone) testUserByPhone[u.phone] = u.id
    const dUsers = await tx.user.findMany({ where: { tenantId: dianjie.id } })
    const userMap = {}
    for (const u of dUsers) {
      const targetPhone = ROLE_TO_TEST_PHONE[u.role]
      if (targetPhone && testUserByPhone[targetPhone]) userMap[u.id] = testUserByPhone[targetPhone]
    }
    const defaultUser = testUserByPhone['13900000003']
    const mapUser = (id) => id ? (userMap[id] || defaultUser) : undefined

    // ─ 2. 复制 PO + Items ────────────────────────────
    const dPOs = await tx.purchaseOrder.findMany({ where: { tenantId: dianjie.id }, include: { items: true } })
    const poIdMap = {}
    for (const po of dPOs) {
      const newStoreId = storeMap[po.storeId]; const newSupId = supMap[po.supplierId]
      if (!newStoreId || !newSupId) continue
      const newPO = await tx.purchaseOrder.create({
        data: {
          tenantId: test.id, no: po.no, storeId: newStoreId, supplierId: newSupId,
          expectedDate: po.expectedDate, totalAmount: po.totalAmount, status: po.status, note: po.note,
          shippedAt: po.shippedAt, shippedNote: po.shippedNote, shippedById: mapUser(po.shippedById),
          deliveredAt: po.deliveredAt, deliveredNote: po.deliveredNote, deliveredById: mapUser(po.deliveredById),
          receivedAt: po.receivedAt, autoConfirmed: po.autoConfirmed, createdById: mapUser(po.createdById),
        },
      })
      poIdMap[po.id] = newPO.id
      for (const item of po.items) {
        const newPid = productMap[item.productId]; if (!newPid) continue
        await tx.purchaseOrderItem.create({
          data: {
            purchaseOrderId: newPO.id, productId: newPid,
            quantity: item.quantity, shippedQty: item.shippedQty,
            unitPrice: item.unitPrice, amount: item.amount, receivedQty: item.receivedQty,
          },
        })
      }
    }
    console.log(`✓ PO: ${Object.keys(poIdMap).length}`)

    // ─ 3. 复制 Receipt + Items ────────────────────────
    const dReceipts = await tx.receipt.findMany({ where: { tenantId: dianjie.id }, include: { items: true } })
    const receiptIdMap = {}
    for (const r of dReceipts) {
      const newStoreId = storeMap[r.storeId]; const newSupId = supMap[r.supplierId]
      if (!newStoreId || !newSupId) continue
      const newPOId = r.purchaseOrderId ? poIdMap[r.purchaseOrderId] : null
      const newR = await tx.receipt.create({
        data: {
          tenantId: test.id, no: r.no, storeId: newStoreId, supplierId: newSupId,
          deliveryDate: r.deliveryDate, totalAmount: r.totalAmount, status: r.status, note: r.note,
          createdById: mapUser(r.createdById), confirmedAt: r.confirmedAt, isManual: r.isManual,
          tempSupplierName: r.tempSupplierName, tempBankAccount: r.tempBankAccount, tempBankName: r.tempBankName,
          rejectReason: r.rejectReason, rejectedAt: r.rejectedAt,
          purchaseOrderId: newPOId, invoiceId: null,
        },
      })
      receiptIdMap[r.id] = newR.id
      if (newPOId) await tx.purchaseOrder.update({ where: { id: newPOId }, data: { receiptId: newR.id } })
      for (const item of r.items) {
        const newPid = productMap[item.productId]; if (!newPid) continue
        await tx.receiptItem.create({
          data: {
            receiptId: newR.id, productId: newPid,
            quantity: item.quantity, unitPrice: item.unitPrice, amount: item.amount,
            productionDate: item.productionDate, expiryDate: item.expiryDate,
          },
        })
      }
    }
    console.log(`✓ Receipt: ${Object.keys(receiptIdMap).length}`)

    // ─ 4. 复制 PaymentSchedule ────────────────────────
    const dSchedules = await tx.paymentSchedule.findMany({ where: { tenantId: dianjie.id } })
    let n = 0
    for (const s of dSchedules) {
      const newReceiptId = receiptIdMap[s.receiptId]; const newSupId = supMap[s.supplierId]
      if (!newReceiptId || !newSupId) continue
      await tx.paymentSchedule.create({
        data: {
          tenantId: test.id, receiptId: newReceiptId, supplierId: newSupId,
          storeId: s.storeId ? storeMap[s.storeId] || null : null,
          amount: s.amount, creditDays: s.creditDays,
          confirmedAt: s.confirmedAt, dueAt: s.dueAt, status: s.status,
          notified3Days: s.notified3Days, notified1Day: s.notified1Day,
          paidAt: s.paidAt, needApproval: s.needApproval,
          approvedById: mapUser(s.approvedById), approvedAt: s.approvedAt,
          approvalNote: s.approvalNote, rejectedAt: s.rejectedAt, rejectionNote: s.rejectionNote,
          bankTxNo: s.bankTxNo,
          bankRawResponse: s.bankRawResponse === null ? undefined : s.bankRawResponse,
          retryCount: s.retryCount, failReason: s.failReason,
        },
      })
      n++
    }
    console.log(`✓ PaymentSchedule: ${n}`)
  }, { timeout: 120000, maxWait: 30000 })

  console.log(`✅ 完成 at ${new Date().toISOString()}`)
}

main()
  .catch(e => { console.error('❌', e.message || e); process.exit(1) })
  .finally(() => prisma.$disconnect())
