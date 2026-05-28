// 自动镜像 dianjie tenant → test tenant (cron 03:00 跑)
// v2 (2026-05-28): 从"只同步业务流水"扩成"完全镜像"
//   - 主数据 (Store/Supplier/Product) UPSERT, 8 个测试用户字段 UPDATE
//   - 业务流水全量 wipe + copy (含 Document/LossClaim/Invoice/Capital/Cash/Stock 等)
//
// 触发: /app/dianjie-v4/scripts/cron-mirror-to-test.sh
// 依赖: cwd 下有 .env (DATABASE_URL 含 & 字符 bash source 会截断, 用 dotenv)

const path = require('path')
require('dotenv').config({
  path: process.env.DOTENV_PATH || path.resolve(process.cwd(), '.env'),
})
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL 没读到, 检查 cwd .env 或 DOTENV_PATH')
  process.exit(1)
}

const { prisma } = require('@dianjie/db')

// 8 个固定测试账号 — role → test phone 映射
// 这些是手动 seed 的, mirror 不创建/删除, 只 UPDATE 字段对齐到 dianjie 对应角色账号
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
  console.log(`  cron mirror dianjie → test (v2 full)`)
  console.log(`  started at ${new Date().toISOString()}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  await prisma.$transaction(async (tx) => {
    const dianjie = await tx.tenant.findUnique({ where: { slug: 'dianjie' } })
    const test    = await tx.tenant.findUnique({ where: { slug: 'test' } })
    if (!dianjie || !test) throw new Error('dianjie 或 test tenant 不存在')
    const D = dianjie.id, T = test.id

    // ════════════════════════════════════════════════════════
    // Phase 0: WIPE 业务流水 (FK 反向拓扑, 子表先删)
    //
    // Cascade 自动处理 (schema 配的 onDelete: Cascade):
    //   - Document → DocumentStep + DocumentDecision
    //   - LossClaim → LossClaimItem
    // ════════════════════════════════════════════════════════

    // 0.1 审批文档族 (cascade 自动清 step/decision)
    const w0a = await tx.document.deleteMany({ where: { tenantId: T } })

    // 0.2 报损族 (cascade 自动清 item)
    const w0b = await tx.lossClaim.deleteMany({ where: { tenantId: T } })

    // 0.3 对账族 (ReconciliationItem 没配 cascade, 手动)
    const w0c1 = await tx.reconciliationItem.deleteMany({ where: { reconciliation: { tenantId: T } } })
    const w0c2 = await tx.payment.deleteMany({ where: { tenantId: T } })
    const w0c3 = await tx.reconciliation.deleteMany({ where: { tenantId: T } })

    // 0.4 付款计划 (refs Receipt, 先 wipe 才能 wipe Receipt)
    const w0d = await tx.paymentSchedule.deleteMany({ where: { tenantId: T } })

    // 0.5 Receipt + Items
    const oldReceipts = await tx.receipt.findMany({ where: { tenantId: T }, select: { id: true } })
    let w0e = { count: 0 }
    if (oldReceipts.length) {
      await tx.receiptItem.deleteMany({ where: { receiptId: { in: oldReceipts.map(r => r.id) } } })
      w0e = await tx.receipt.deleteMany({ where: { tenantId: T } })
    }

    // 0.6 PurchaseOrder + Items
    const oldPOs = await tx.purchaseOrder.findMany({ where: { tenantId: T }, select: { id: true } })
    let w0f = { count: 0 }
    if (oldPOs.length) {
      await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: { in: oldPOs.map(p => p.id) } } })
      w0f = await tx.purchaseOrder.deleteMany({ where: { tenantId: T } })
    }

    // 0.7 Invoice + InvoicePayment (InvoicePayment refs Invoice, 先 wipe)
    const w0g1 = await tx.invoicePayment.deleteMany({ where: { tenantId: T } })
    const w0g2 = await tx.invoice.deleteMany({ where: { tenantId: T } })

    // 0.8 Capital 项目族 (Expense+Repayment refs Contract, Contract refs Project)
    const w0h1 = await tx.capitalExpense.deleteMany({ where: { tenantId: T } })
    const w0h2 = await tx.storeRepayment.deleteMany({ where: { tenantId: T } })
    const w0h3 = await tx.capitalContract.deleteMany({ where: { tenantId: T } })
    const w0h4 = await tx.capitalProject.deleteMany({ where: { tenantId: T } })

    // 0.9 Cash 账户族 (CashTransaction refs CashAccount)
    const w0i1 = await tx.cashTransaction.deleteMany({ where: { tenantId: T } })
    const w0i2 = await tx.cashAccount.deleteMany({ where: { tenantId: T } })

    // 0.10 库存 / 出库 / 店面开支
    const w0j1 = await tx.stockConsumption.deleteMany({ where: { tenantId: T } })
    const w0j2 = await tx.supplierStockMovement.deleteMany({ where: { tenantId: T } })
    const w0j3 = await tx.storeExpense.deleteMany({ where: { tenantId: T } })

    // 0.11 通知
    const w0k = await tx.notification.deleteMany({ where: { tenantId: T } })

    console.log(`✓ Phase 0 wipe: doc=${w0a.count} lc=${w0b.count} recon=${w0c3.count}/pay=${w0c2.count}/reconItem=${w0c1.count} sched=${w0d.count} receipt=${w0e.count} po=${w0f.count} invPay=${w0g1.count}/inv=${w0g2.count} capExp=${w0h1.count}/repay=${w0h2.count}/contract=${w0h3.count}/proj=${w0h4.count} cashTx=${w0i1.count}/acct=${w0i2.count} stockCon=${w0j1.count} stockMov=${w0j2.count} storeExp=${w0j3.count} notif=${w0k.count}`)

    // ════════════════════════════════════════════════════════
    // Phase 1: UPSERT 主数据
    //
    // Store / Supplier / Product 按 natural key (no/code) upsert
    // 8 个 test User 按 role → phone 映射, 字段从 dianjie 对应角色账号拷过来
    // ════════════════════════════════════════════════════════

    // 1.1 Store — upsert by (tenantId, no)
    const dStores = await tx.store.findMany({ where: { tenantId: D } })
    for (const s of dStores) {
      const { id, tenantId, createdAt, updatedAt, ...fields } = s
      await tx.store.upsert({
        where: { tenantId_no: { tenantId: T, no: s.no } },
        create: { tenantId: T, ...fields },
        update: fields,
      })
    }
    // 重新加载 test store 建 map
    const tStores = await tx.store.findMany({ where: { tenantId: T } })
    const storeMap = {}
    for (const s of dStores) { const t = tStores.find(x => x.no === s.no); if (t) storeMap[s.id] = t.id }
    console.log(`✓ Store upsert: dianjie=${dStores.length} → test 同步, map=${Object.keys(storeMap).length}`)

    // 1.2 Supplier — upsert by (tenantId, no)
    const dSups = await tx.supplier.findMany({ where: { tenantId: D } })
    for (const s of dSups) {
      const { id, tenantId, createdAt, updatedAt, ...fields } = s
      await tx.supplier.upsert({
        where: { tenantId_no: { tenantId: T, no: s.no } },
        create: { tenantId: T, ...fields },
        update: fields,
      })
    }
    const tSups = await tx.supplier.findMany({ where: { tenantId: T } })
    const supMap = {}
    for (const s of dSups) { const t = tSups.find(x => x.no === s.no); if (t) supMap[s.id] = t.id }
    console.log(`✓ Supplier upsert: dianjie=${dSups.length} → test 同步, map=${Object.keys(supMap).length}`)

    // 1.3 Product — upsert by (tenantId, code), supplierId 用 supMap 重映射
    // batchId 跳过 (ProductBatch 不同步, 避免悬空 FK), 已有 test product 的 batchId 保留
    const dProducts = await tx.product.findMany({ where: { tenantId: D } })
    for (const p of dProducts) {
      const { id, tenantId, createdAt, updatedAt, batchId, supplierId, ...fields } = p
      const newSupId = supplierId ? (supMap[supplierId] || null) : null
      await tx.product.upsert({
        where: { tenantId_code: { tenantId: T, code: p.code } },
        create: { tenantId: T, supplierId: newSupId, ...fields, batchId: null },
        update: { supplierId: newSupId, ...fields },  // batchId 不动 (留 test 现有值)
      })
    }
    const tProducts = await tx.product.findMany({ where: { tenantId: T }, select: { id: true, code: true } })
    const productMap = {}
    for (const p of dProducts) { const t = tProducts.find(x => x.code === p.code); if (t) productMap[p.id] = t.id }
    console.log(`✓ Product upsert: dianjie=${dProducts.length} → test 同步, map=${Object.keys(productMap).length}`)

    // 1.4 User — 8 个 fixed test 账号, 按 role 映射, 拷 dianjie counterpart 字段
    // 保留 test 端: id / email / phone / password / lastLoginAt / tenantId
    // 拷 dianjie 端: name / role / status / storeId / storeIds[] / supplierId / wecomUserId / wecomDeptIds[]
    const dUsers = await tx.user.findMany({ where: { tenantId: D } })
    // 每个 role 取 dianjie 第一个匹配用户作为 "代表" (dianjie 可能多人同 role)
    const dRoleRepresentative = {}
    for (const u of dUsers) {
      if (!dRoleRepresentative[u.role]) dRoleRepresentative[u.role] = u
    }
    let userUpdateCount = 0
    for (const [role, testPhone] of Object.entries(ROLE_TO_TEST_PHONE)) {
      const tUser = await tx.user.findUnique({ where: { tenantId_phone: { tenantId: T, phone: testPhone } } })
      if (!tUser) { console.warn(`  ⚠ test 缺 ${role} 账号 (phone=${testPhone}), 跳过`); continue }
      const dRep = dRoleRepresentative[role]
      if (!dRep) { console.warn(`  ⚠ dianjie 无 ${role} 角色账号, test ${testPhone} 保留原状`); continue }
      const newStoreId = dRep.storeId ? (storeMap[dRep.storeId] || null) : null
      const newStoreIds = (dRep.storeIds || []).map(id => storeMap[id]).filter(Boolean)
      const newSupplierId = dRep.supplierId ? (supMap[dRep.supplierId] || null) : null
      await tx.user.update({
        where: { id: tUser.id },
        data: {
          name: dRep.name,
          role: dRep.role,
          status: dRep.status,
          storeId: newStoreId,
          storeIds: newStoreIds,
          supplierId: newSupplierId,
          wecomUserId: null,  // test 不走企微 SSO, 避免唯一约束撞 dianjie 的
          wecomDeptIds: [],
        },
      })
      userUpdateCount++
    }
    console.log(`✓ User update: ${userUpdateCount}/8 个测试账号字段同步`)

    // ════════════════════════════════════════════════════════
    // Phase 2: 建 ID mapping 完成
    // ════════════════════════════════════════════════════════

    // userMap: dianjie userId → test userId (按 role)
    const tTestUsers = await tx.user.findMany({
      where: { tenantId: T, phone: { in: Object.values(ROLE_TO_TEST_PHONE) } },
    })
    const testUserByPhone = {}
    for (const u of tTestUsers) if (u.phone) testUserByPhone[u.phone] = u.id
    const userMap = {}
    for (const u of dUsers) {
      const targetPhone = ROLE_TO_TEST_PHONE[u.role]
      if (targetPhone && testUserByPhone[targetPhone]) userMap[u.id] = testUserByPhone[targetPhone]
    }
    const defaultUser = testUserByPhone['13900000003']  // ADMIN 兜底
    const mapUser = (id) => id ? (userMap[id] || defaultUser) : undefined
    const mapUserOptional = (id) => id ? (userMap[id] || null) : null
    console.log(`✓ userMap: ${Object.keys(userMap).length} 个 dianjie 用户 → test 用户`)

    // ════════════════════════════════════════════════════════
    // Phase 3: COPY 业务流水 (从 dianjie 重灌到 test)
    // ════════════════════════════════════════════════════════

    // 3.1 PurchaseOrder + Items (既有)
    const dPOs = await tx.purchaseOrder.findMany({ where: { tenantId: D }, include: { items: true } })
    const poIdMap = {}
    for (const po of dPOs) {
      const newStoreId = storeMap[po.storeId]; const newSupId = supMap[po.supplierId]
      if (!newStoreId || !newSupId) continue
      const newPO = await tx.purchaseOrder.create({
        data: {
          tenantId: T, no: po.no, storeId: newStoreId, supplierId: newSupId,
          expectedDate: po.expectedDate, totalAmount: po.totalAmount, status: po.status, note: po.note,
          shippedAt: po.shippedAt, shippedNote: po.shippedNote, shippedById: mapUserOptional(po.shippedById),
          deliveredAt: po.deliveredAt, deliveredNote: po.deliveredNote, deliveredById: mapUserOptional(po.deliveredById),
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
    console.log(`✓ PurchaseOrder: ${Object.keys(poIdMap).length}/${dPOs.length}`)

    // 3.2 Receipt + Items + InvoicePayment 等下面统一处理 (Invoice 先 copy 才能 receipt 引用)
    //     但 Receipt.invoiceId 是 optional, 这里先 copy Receipt 不带 invoiceId, 后面统一 backfill
    const dReceipts = await tx.receipt.findMany({ where: { tenantId: D }, include: { items: true } })
    const receiptIdMap = {}
    for (const r of dReceipts) {
      const newStoreId = storeMap[r.storeId]; const newSupId = supMap[r.supplierId]
      if (!newStoreId || !newSupId) continue
      const newPOId = r.purchaseOrderId ? poIdMap[r.purchaseOrderId] : null
      const newR = await tx.receipt.create({
        data: {
          tenantId: T, no: r.no, storeId: newStoreId, supplierId: newSupId,
          deliveryDate: r.deliveryDate, totalAmount: r.totalAmount, status: r.status, note: r.note,
          createdById: mapUser(r.createdById), confirmedAt: r.confirmedAt, isManual: r.isManual,
          tempSupplierName: r.tempSupplierName, tempBankAccount: r.tempBankAccount, tempBankName: r.tempBankName,
          rejectReason: r.rejectReason, rejectedAt: r.rejectedAt,
          purchaseOrderId: newPOId, invoiceId: null,  // 先 null, 后面 backfill
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
    console.log(`✓ Receipt: ${Object.keys(receiptIdMap).length}/${dReceipts.length}`)

    // 3.3 PaymentSchedule (既有)
    const dSchedules = await tx.paymentSchedule.findMany({ where: { tenantId: D } })
    let sched_n = 0
    for (const s of dSchedules) {
      const newReceiptId = receiptIdMap[s.receiptId]; const newSupId = supMap[s.supplierId]
      if (!newReceiptId || !newSupId) continue
      await tx.paymentSchedule.create({
        data: {
          tenantId: T, receiptId: newReceiptId, supplierId: newSupId,
          storeId: s.storeId ? storeMap[s.storeId] || null : null,
          amount: s.amount, creditDays: s.creditDays,
          confirmedAt: s.confirmedAt, dueAt: s.dueAt, status: s.status,
          notified3Days: s.notified3Days, notified1Day: s.notified1Day,
          paidAt: s.paidAt, needApproval: s.needApproval,
          approvedById: mapUserOptional(s.approvedById), approvedAt: s.approvedAt,
          approvalNote: s.approvalNote, rejectedAt: s.rejectedAt, rejectionNote: s.rejectionNote,
          bankTxNo: s.bankTxNo,
          bankRawResponse: s.bankRawResponse === null ? undefined : s.bankRawResponse,
          retryCount: s.retryCount, failReason: s.failReason,
        },
      })
      sched_n++
    }
    console.log(`✓ PaymentSchedule: ${sched_n}/${dSchedules.length}`)

    // 3.4 Document + DocumentStep + DocumentDecision (新增)
    // payload 是 Json (可能内嵌 productId / supplierId 等, 不强行 remap 因 schema 自由),
    // 测试场景下展示用足够; 后续真要追溯可以专门加 payload remap.
    const dDocs = await tx.document.findMany({
      where: { tenantId: D },
      include: { steps: true, decisions: true },
    })
    let doc_n = 0
    for (const d of dDocs) {
      const newStoreId = d.storeId ? (storeMap[d.storeId] || null) : null
      const newInitiatorId = mapUser(d.initiatorId)
      if (!newInitiatorId) continue
      const newDoc = await tx.document.create({
        data: {
          tenantId: T, no: d.no, type: d.type, title: d.title,
          amount: d.amount, isOverThreshold: d.isOverThreshold, thresholdRule: d.thresholdRule,
          payload: d.payload === null ? undefined : d.payload,
          storeId: newStoreId, initiatorId: newInitiatorId,
          status: d.status, finalizedAt: d.finalizedAt,
        },
      })
      for (const step of d.steps) {
        await tx.documentStep.create({
          data: {
            documentId: newDoc.id, seq: step.seq,
            approverRole: step.approverRole,
            approverId: mapUserOptional(step.approverId),
            status: step.status, decidedAt: step.decidedAt, comment: step.comment,
          },
        })
      }
      for (const dec of d.decisions) {
        const newUserId = mapUser(dec.userId); if (!newUserId) continue
        await tx.documentDecision.create({
          data: {
            documentId: newDoc.id,
            stepId: null,  // 跨表 step id mapping 太麻烦, 决策保留主要字段就行
            userId: newUserId,
            decision: dec.decision, comment: dec.comment,
          },
        })
      }
      doc_n++
    }
    console.log(`✓ Document: ${doc_n}/${dDocs.length}`)

    // 3.5 LossClaim + Items (新增)
    const dLCs = await tx.lossClaim.findMany({ where: { tenantId: D }, include: { items: true } })
    let lc_n = 0
    for (const lc of dLCs) {
      const newStoreId = storeMap[lc.storeId]; if (!newStoreId) continue
      const newSupId = lc.supplierId ? (supMap[lc.supplierId] || null) : null
      const newPOId = lc.purchaseOrderId ? (poIdMap[lc.purchaseOrderId] || null) : null
      const newLC = await tx.lossClaim.create({
        data: {
          tenantId: T, no: lc.no, purchaseOrderId: newPOId, storeId: newStoreId, supplierId: newSupId,
          reason: lc.reason, isManual: lc.isManual,
          totalLossAmount: lc.totalLossAmount, description: lc.description,
          evidenceImages: lc.evidenceImages,
          status: lc.status,
          handledAt: lc.handledAt, handledById: mapUserOptional(lc.handledById),
          handlerNote: lc.handlerNote, autoApproved: lc.autoApproved,
          negotiationNote: lc.negotiationNote,
          resolvedAt: lc.resolvedAt, resolvedNote: lc.resolvedNote,
          createdById: mapUser(lc.createdById),
        },
      })
      for (const item of lc.items) {
        const newPid = productMap[item.productId]; if (!newPid) continue
        await tx.lossClaimItem.create({
          data: {
            lossClaimId: newLC.id, productId: newPid,
            orderedQty: item.orderedQty, receivedQty: item.receivedQty,
            lossQty: item.lossQty, unitPrice: item.unitPrice, lossAmount: item.lossAmount,
          },
        })
      }
      lc_n++
    }
    console.log(`✓ LossClaim: ${lc_n}/${dLCs.length}`)

    // 3.6 StockConsumption (新增)
    const dStockCons = await tx.stockConsumption.findMany({ where: { tenantId: D } })
    let sc_n = 0
    for (const sc of dStockCons) {
      const newStoreId = storeMap[sc.storeId]; if (!newStoreId) continue
      const newPid = productMap[sc.productId]; if (!newPid) continue
      await tx.stockConsumption.create({
        data: {
          tenantId: T, storeId: newStoreId, productId: newPid,
          date: sc.date, quantity: sc.quantity, note: sc.note,
          sourceType: sc.sourceType, sourceId: sc.sourceId,
          createdById: mapUser(sc.createdById),
        },
      })
      sc_n++
    }
    console.log(`✓ StockConsumption: ${sc_n}/${dStockCons.length}`)

    // 3.7 SupplierStockMovement (新增)
    const dStockMovs = await tx.supplierStockMovement.findMany({ where: { tenantId: D } })
    let smv_n = 0
    for (const m of dStockMovs) {
      const newSupId = supMap[m.supplierId]; if (!newSupId) continue
      const newPid = productMap[m.productId]; if (!newPid) continue
      await tx.supplierStockMovement.create({
        data: {
          tenantId: T, supplierId: newSupId, productId: newPid,
          delta: m.delta, balanceAfter: m.balanceAfter, type: m.type,
          reason: m.reason, sourceType: m.sourceType, sourceId: m.sourceId,
          manufactureDate: m.manufactureDate, expiryDate: m.expiryDate,
          createdById: mapUser(m.createdById),
        },
      })
      smv_n++
    }
    console.log(`✓ SupplierStockMovement: ${smv_n}/${dStockMovs.length}`)

    // 3.8 StoreExpense (新增) — 注意 @@unique([storeId, month, item]) 在 wipe 后无冲突
    const dStoreExps = await tx.storeExpense.findMany({ where: { tenantId: D } })
    let se_n = 0
    for (const e of dStoreExps) {
      const newStoreId = storeMap[e.storeId]; if (!newStoreId) continue
      await tx.storeExpense.create({
        data: {
          tenantId: T, storeId: newStoreId,
          month: e.month, category: e.category, item: e.item,
          amount: e.amount, note: e.note,
        },
      })
      se_n++
    }
    console.log(`✓ StoreExpense: ${se_n}/${dStoreExps.length}`)

    // 3.9 Invoice + InvoicePayment (新增) + Receipt.invoiceId backfill
    const dInvoices = await tx.invoice.findMany({ where: { tenantId: D }, include: { payments: true, receipts: { select: { id: true } } } })
    const invIdMap = {}
    let inv_n = 0
    for (const inv of dInvoices) {
      const newSupId = supMap[inv.supplierId]; if (!newSupId) continue
      const newInv = await tx.invoice.create({
        data: {
          tenantId: T, supplierId: newSupId,
          invoiceNo: inv.invoiceNo, invoiceCode: inv.invoiceCode,
          amount: inv.amount, amountWithoutTax: inv.amountWithoutTax,
          taxRate: inv.taxRate, taxAmount: inv.taxAmount,
          issueDate: inv.issueDate, fileUrl: inv.fileUrl, fileType: inv.fileType,
          note: inv.note, uploadedById: mapUser(inv.uploadedById),
          uploadedAt: inv.uploadedAt, status: inv.status,
          reviewedById: mapUserOptional(inv.reviewedById),
          reviewedAt: inv.reviewedAt, reviewNote: inv.reviewNote,
          paidAmount: inv.paidAmount, fullyPaidAt: inv.fullyPaidAt,
        },
      })
      invIdMap[inv.id] = newInv.id
      // backfill receipts.invoiceId
      for (const r of inv.receipts) {
        const newRId = receiptIdMap[r.id]
        if (newRId) await tx.receipt.update({ where: { id: newRId }, data: { invoiceId: newInv.id } })
      }
      // invoice payments
      for (const p of inv.payments) {
        await tx.invoicePayment.create({
          data: {
            tenantId: T, invoiceId: newInv.id,
            amount: p.amount, paymentMethod: p.paymentMethod,
            bankTxNo: p.bankTxNo, bankRawResponse: p.bankRawResponse === null ? undefined : p.bankRawResponse,
            status: p.status, paidAt: p.paidAt, failReason: p.failReason,
            initiatedById: mapUser(p.initiatedById),
            approvedById: mapUserOptional(p.approvedById),
            approvedAt: p.approvedAt, note: p.note,
          },
        })
      }
      inv_n++
    }
    console.log(`✓ Invoice: ${inv_n}/${dInvoices.length}`)

    // 3.10 CapitalProject + Contract + Expense + StoreRepayment (新增)
    const dProjects = await tx.capitalProject.findMany({
      where: { tenantId: D },
      include: { contracts: true, expenses: true, repayments: true },
    })
    const projIdMap = {}
    const contractIdMap = {}
    let proj_n = 0
    for (const proj of dProjects) {
      const newStoreId = proj.storeId ? (storeMap[proj.storeId] || null) : null
      const newProj = await tx.capitalProject.create({
        data: {
          tenantId: T, storeId: newStoreId,
          name: proj.name, type: proj.type, status: proj.status,
          budget: proj.budget, spent: proj.spent,
          repaymentTerms: proj.repaymentTerms, repaidAmount: proj.repaidAmount,
          startedAt: proj.startedAt, openedAt: proj.openedAt, closedAt: proj.closedAt,
          note: proj.note,
        },
      })
      projIdMap[proj.id] = newProj.id
      for (const c of proj.contracts) {
        const newC = await tx.capitalContract.create({
          data: {
            tenantId: T, projectId: newProj.id,
            category: c.category, vendor: c.vendor, contractNo: c.contractNo,
            totalAmount: c.totalAmount, paidAmount: c.paidAmount,
            startDate: c.startDate, endDate: c.endDate, fileUrl: c.fileUrl,
            note: c.note, status: c.status,
          },
        })
        contractIdMap[c.id] = newC.id
      }
      for (const e of proj.expenses) {
        await tx.capitalExpense.create({
          data: {
            tenantId: T, projectId: newProj.id,
            contractId: e.contractId ? (contractIdMap[e.contractId] || null) : null,
            category: e.category, vendor: e.vendor, amount: e.amount,
            requestedAt: e.requestedAt, requestedById: mapUser(e.requestedById),
            fileUrl: e.fileUrl, note: e.note, status: e.status,
            approvedById: mapUserOptional(e.approvedById),
            approvedAt: e.approvedAt, approvalNote: e.approvalNote,
            rejectReason: e.rejectReason,
            paidAt: e.paidAt, paidById: mapUserOptional(e.paidById),
            paymentMethod: e.paymentMethod, bankTxNo: e.bankTxNo, failReason: e.failReason,
          },
        })
      }
      for (const rp of proj.repayments) {
        const newSId = storeMap[rp.storeId]; if (!newSId) continue
        await tx.storeRepayment.create({
          data: {
            tenantId: T, projectId: newProj.id, storeId: newSId,
            amount: rp.amount, paidAt: rp.paidAt, source: rp.source,
            bankTxNo: rp.bankTxNo, note: rp.note,
            initiatedById: mapUser(rp.initiatedById),
          },
        })
      }
      proj_n++
    }
    console.log(`✓ CapitalProject: ${proj_n}/${dProjects.length}`)

    // 3.11 CashAccount + CashTransaction (新增)
    const dCashAccts = await tx.cashAccount.findMany({ where: { tenantId: D }, include: { transactions: true } })
    const acctIdMap = {}
    let acct_n = 0, ctx_n = 0
    for (const a of dCashAccts) {
      const newA = await tx.cashAccount.create({
        data: {
          tenantId: T, name: a.name, type: a.type,
          bankName: a.bankName, accountNo: a.accountNo, balance: a.balance,
          note: a.note, cmbBindAccount: a.cmbBindAccount, status: a.status,
        },
      })
      acctIdMap[a.id] = newA.id
      for (const ctx of a.transactions) {
        await tx.cashTransaction.create({
          data: {
            tenantId: T, accountId: newA.id,
            direction: ctx.direction, category: ctx.category,
            amount: ctx.amount, balanceAfter: ctx.balanceAfter,
            note: ctx.note, txDate: ctx.txDate,
            refType: ctx.refType, refId: ctx.refId,
            createdById: mapUser(ctx.createdById),
          },
        })
        ctx_n++
      }
      acct_n++
    }
    console.log(`✓ CashAccount: ${acct_n}/${dCashAccts.length}, CashTransaction: ${ctx_n}`)

    // 3.12 Notification (新增) — recipientId 走 userMap (可为 null = 角色广播)
    const dNotifs = await tx.notification.findMany({ where: { tenantId: D } })
    let notif_n = 0
    for (const n of dNotifs) {
      await tx.notification.create({
        data: {
          tenantId: T, recipientRole: n.recipientRole,
          recipientId: mapUserOptional(n.recipientId),
          type: n.type, title: n.title, body: n.body,
          refType: n.refType, refId: n.refId, read: n.read,
        },
      })
      notif_n++
    }
    console.log(`✓ Notification: ${notif_n}/${dNotifs.length}`)

  }, { timeout: 300000, maxWait: 60000 })  // 5min, master+业务全镜像总耗时给富余

  console.log(`✅ 完成 at ${new Date().toISOString()}`)
}

main()
  .catch(e => { console.error('❌', e.message || e, e.stack); process.exit(1) })
  .finally(() => prisma.$disconnect())
