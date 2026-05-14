/**
 * 把 dianjie tenant 的业务流水补搬到 test tenant
 * (PurchaseOrder + PurchaseOrderItem + Receipt + ReceiptItem + PaymentSchedule)
 *
 * 前提:
 *   - test tenant 已经存在 (slug=test) ← migrate-test-tenant.ts 跑过
 *   - test tenant 已经有 Store / Supplier / Product 副本
 *
 * 行为:
 *   1. 删 test tenant 已有的业务流水 (避免重复)
 *   2. 从 dianjie tenant 复制 PO / PO Items / Receipt / Receipt Items / PaymentSchedule
 *   3. ID 重新生成 (新 cuid), 外键映射:
 *      - storeId/supplierId → test tenant 副本的 ID
 *      - productId          → test tenant 同 code 的 product
 *      - createdById/shippedById 等 user 引用 → test tenant 同 role 的测试 user
 *      - purchaseOrderId, receiptId → 新映射的 ID
 *
 * 怎么跑:
 *   PROD_DATABASE_URL='postgresql://...@127.0.0.1:5433/dianjie_v4?connection_limit=3' \
 *     pnpm --filter @dianjie/api exec tsx scripts/mirror-business-to-test.ts
 */
import { PrismaClient } from '@dianjie/db'

// 角色映射: dianjie user 创建的 → test tenant 同 role 的测试 user
const ROLE_TO_TEST_PHONE: Record<string, string> = {
  ADMIN:          '13900000003',  // boss
  MANAGER:        '13900000004',  // mgr
  KITCHEN_LEAD:   '13900000005',  // chef
  CHEF_DIRECTOR:  '13900000002',  // cd
  FINANCE:        '13900000006',  // fin
  ENGINEERING:    '13900000007',  // eng
  SUPPLIER_OWNER: '13900000001',  // sup1
  SUPPLIER_STAFF: '13900000008',  // sup2
}

async function main() {
  const url = process.env.PROD_DATABASE_URL
  if (!url) { console.error('❌ PROD_DATABASE_URL 未设置'); process.exit(1) }
  const prisma = new PrismaClient({ datasources: { db: { url } } } as any)

  try {
    await prisma.$transaction(async (tx) => {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log('  补搬 dianjie 业务流水 → test tenant')
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

      const dianjie = await tx.tenant.findUnique({ where: { slug: 'dianjie' } })
      const test    = await tx.tenant.findUnique({ where: { slug: 'test' } })
      if (!dianjie || !test) throw new Error('dianjie 或 test tenant 不存在')
      console.log(`✓ dianjie: ${dianjie.id}`)
      console.log(`✓ test:    ${test.id}\n`)

      // ─ 0. 删 test tenant 已有的业务流水 ────────────────
      const delSchedules = await tx.paymentSchedule.deleteMany({ where: { tenantId: test.id } })
      // ReceiptItem cascade by Receipt
      const delReceiptsCount = await tx.receipt.count({ where: { tenantId: test.id } })
      if (delReceiptsCount > 0) {
        const oldReceipts = await tx.receipt.findMany({ where: { tenantId: test.id }, select: { id: true } })
        await tx.receiptItem.deleteMany({ where: { receiptId: { in: oldReceipts.map(r => r.id) } } })
        await tx.receipt.deleteMany({ where: { tenantId: test.id } })
      }
      // PurchaseOrderItem cascade by PO
      const oldPOs = await tx.purchaseOrder.findMany({ where: { tenantId: test.id }, select: { id: true } })
      if (oldPOs.length > 0) {
        await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: { in: oldPOs.map(p => p.id) } } })
        await tx.purchaseOrder.deleteMany({ where: { tenantId: test.id } })
      }
      console.log(`✓ 清 test tenant 旧业务流水: ${oldPOs.length} PO + ${delReceiptsCount} Receipt + ${delSchedules.count} Schedule\n`)

      // ─ 1. 建映射表 (store / supplier / product / user) ──
      console.log('--- 建映射表 ---')

      // store: dianjie 1 个 → test 1 个 (按 no 匹配)
      const dStores = await tx.store.findMany({ where: { tenantId: dianjie.id } })
      const tStores = await tx.store.findMany({ where: { tenantId: test.id } })
      const storeMap: Record<string, string> = {}
      for (const s of dStores) {
        const t = tStores.find(x => x.no === s.no)
        if (t) storeMap[s.id] = t.id
      }
      console.log(`  Store: ${Object.keys(storeMap).length} 个映射`)

      // supplier: 同样按 no 匹配
      const dSuppliers = await tx.supplier.findMany({ where: { tenantId: dianjie.id } })
      const tSuppliers = await tx.supplier.findMany({ where: { tenantId: test.id } })
      const supMap: Record<string, string> = {}
      for (const s of dSuppliers) {
        const t = tSuppliers.find(x => x.no === s.no)
        if (t) supMap[s.id] = t.id
      }
      console.log(`  Supplier: ${Object.keys(supMap).length} 个映射`)

      // product: 按 code 匹配
      const dProducts = await tx.product.findMany({ where: { tenantId: dianjie.id }, select: { id: true, code: true } })
      const tProducts = await tx.product.findMany({ where: { tenantId: test.id },    select: { id: true, code: true } })
      const tProductByCode = Object.fromEntries(tProducts.map(p => [p.code, p.id]))
      const productMap: Record<string, string> = {}
      for (const p of dProducts) {
        if (tProductByCode[p.code]) productMap[p.id] = tProductByCode[p.code]
      }
      console.log(`  Product: ${Object.keys(productMap).length} / ${dProducts.length} 个映射`)

      // user: dianjie user → test tenant 同 role 测试 user (用 phone 找)
      // ROLE_TO_TEST_PHONE 写死
      const tTestUsers = await tx.user.findMany({
        where: { tenantId: test.id, phone: { in: Object.values(ROLE_TO_TEST_PHONE) } },
      })
      const testUserByPhone: Record<string, string> = {}
      for (const u of tTestUsers) if (u.phone) testUserByPhone[u.phone] = u.id

      const dUsers = await tx.user.findMany({ where: { tenantId: dianjie.id } })
      const userMap: Record<string, string> = {}
      for (const u of dUsers) {
        const targetPhone = ROLE_TO_TEST_PHONE[u.role as string]
        if (targetPhone && testUserByPhone[targetPhone]) {
          userMap[u.id] = testUserByPhone[targetPhone]
        }
      }
      console.log(`  User: ${Object.keys(userMap).length} / ${dUsers.length} 个映射 (按 role)\n`)

      function mapUser(id: string | null | undefined): string | undefined {
        if (!id) return undefined
        return userMap[id] || testUserByPhone['13900000003'] // 找不到默认归 boss
      }

      // ─ 2. 复制 PurchaseOrder + Items ──────────────────
      console.log('--- 复制 PurchaseOrder ---')
      const dPOs = await tx.purchaseOrder.findMany({
        where: { tenantId: dianjie.id },
        include: { items: true },
      })
      const poIdMap: Record<string, string> = {}
      for (const po of dPOs) {
        const newStoreId = storeMap[po.storeId]
        const newSupId   = supMap[po.supplierId]
        if (!newStoreId || !newSupId) {
          console.warn(`  ⚠ PO ${po.no}: store/supplier 映射失败, 跳过`)
          continue
        }
        const newPO = await tx.purchaseOrder.create({
          data: {
            tenantId:      test.id,
            no:            po.no,
            storeId:       newStoreId,
            supplierId:    newSupId,
            expectedDate:  po.expectedDate,
            totalAmount:   po.totalAmount,
            status:        po.status,
            note:          po.note,
            shippedAt:     po.shippedAt,
            shippedNote:   po.shippedNote,
            shippedById:   mapUser(po.shippedById),
            deliveredAt:   po.deliveredAt,
            deliveredNote: po.deliveredNote,
            deliveredById: mapUser(po.deliveredById),
            receivedAt:    po.receivedAt,
            autoConfirmed: po.autoConfirmed,
            createdById:   mapUser(po.createdById)!,
            // receiptId 后面更新
          },
        })
        poIdMap[po.id] = newPO.id
        // Items
        for (const item of po.items) {
          const newProductId = productMap[item.productId]
          if (!newProductId) {
            console.warn(`  ⚠ PO ${po.no} Item: product ${item.productId} 映射失败, 跳过`)
            continue
          }
          await tx.purchaseOrderItem.create({
            data: {
              purchaseOrderId: newPO.id,
              productId:       newProductId,
              quantity:        item.quantity,
              shippedQty:      item.shippedQty,
              unitPrice:       item.unitPrice,
              amount:          item.amount,
              receivedQty:     item.receivedQty,
            },
          })
        }
        console.log(`  ✓ PO ${po.no} → ${newPO.id.slice(0, 8)}… (${po.items.length} items)`)
      }
      console.log(`✓ 复制 ${Object.keys(poIdMap).length} 个 PO\n`)

      // ─ 3. 复制 Receipt + Items ────────────────────────
      console.log('--- 复制 Receipt ---')
      const dReceipts = await tx.receipt.findMany({
        where: { tenantId: dianjie.id },
        include: { items: true },
      })
      const receiptIdMap: Record<string, string> = {}
      for (const r of dReceipts) {
        const newStoreId = storeMap[r.storeId]
        const newSupId   = supMap[r.supplierId]
        if (!newStoreId || !newSupId) {
          console.warn(`  ⚠ Receipt ${r.no}: store/supplier 映射失败, 跳过`)
          continue
        }
        const newPOId = r.purchaseOrderId ? poIdMap[r.purchaseOrderId] : null
        const newR = await tx.receipt.create({
          data: {
            tenantId:        test.id,
            no:              r.no,
            storeId:         newStoreId,
            supplierId:      newSupId,
            deliveryDate:    r.deliveryDate,
            totalAmount:     r.totalAmount,
            status:          r.status,
            note:            r.note,
            createdById:     mapUser(r.createdById)!,
            confirmedAt:     r.confirmedAt,
            isManual:        r.isManual,
            tempSupplierName: r.tempSupplierName,
            tempBankAccount: r.tempBankAccount,
            tempBankName:    r.tempBankName,
            rejectReason:    r.rejectReason,
            rejectedAt:      r.rejectedAt,
            purchaseOrderId: newPOId,
            invoiceId:       null,  // dianjie 0 张发票, 不处理
          },
        })
        receiptIdMap[r.id] = newR.id
        // 反向回填 PO.receiptId
        if (newPOId) {
          await tx.purchaseOrder.update({
            where: { id: newPOId },
            data: { receiptId: newR.id },
          })
        }
        // Items
        for (const item of r.items) {
          const newProductId = productMap[item.productId]
          if (!newProductId) {
            console.warn(`  ⚠ Receipt ${r.no} Item: product ${item.productId} 映射失败, 跳过`)
            continue
          }
          await tx.receiptItem.create({
            data: {
              receiptId:      newR.id,
              productId:      newProductId,
              quantity:       item.quantity,
              unitPrice:      item.unitPrice,
              amount:         item.amount,
              productionDate: item.productionDate,
              expiryDate:     item.expiryDate,
            },
          })
        }
        console.log(`  ✓ Receipt ${r.no} → ${newR.id.slice(0, 8)}… (${r.items.length} items)`)
      }
      console.log(`✓ 复制 ${Object.keys(receiptIdMap).length} 个 Receipt\n`)

      // ─ 4. 复制 PaymentSchedule ────────────────────────
      console.log('--- 复制 PaymentSchedule ---')
      const dSchedules = await tx.paymentSchedule.findMany({ where: { tenantId: dianjie.id } })
      let schN = 0
      for (const s of dSchedules) {
        const newReceiptId = receiptIdMap[s.receiptId]
        const newSupId     = supMap[s.supplierId]
        if (!newReceiptId || !newSupId) {
          console.warn(`  ⚠ Schedule receipt ${s.receiptId}: 映射失败, 跳过`)
          continue
        }
        await tx.paymentSchedule.create({
          data: {
            tenantId:      test.id,
            receiptId:     newReceiptId,
            supplierId:    newSupId,
            storeId:       s.storeId ? storeMap[s.storeId] || null : null,
            amount:        s.amount,
            creditDays:    s.creditDays,
            confirmedAt:   s.confirmedAt,
            dueAt:         s.dueAt,
            status:        s.status,
            notified3Days: s.notified3Days,
            notified1Day:  s.notified1Day,
            paidAt:        s.paidAt,
            // paymentId 不复制 (Payment 表是 0 行)
            needApproval:  s.needApproval,
            approvedById:  mapUser(s.approvedById),
            approvedAt:    s.approvedAt,
            approvalNote:  s.approvalNote,
            rejectedAt:    s.rejectedAt,
            rejectionNote: s.rejectionNote,
            bankTxNo:      s.bankTxNo,
            bankRawResponse: s.bankRawResponse === null ? undefined : (s.bankRawResponse as any),
            retryCount:    s.retryCount,
            failReason:    s.failReason,
          },
        })
        schN++
      }
      console.log(`✓ 复制 ${schN} 个 PaymentSchedule\n`)

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log('✅ 补搬完成 (事务即将 COMMIT)')
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    }, { timeout: 120000, maxWait: 30000 })
  } catch (e: any) {
    console.error('\n❌ 失败, 事务已回滚:', e.message)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

main()
