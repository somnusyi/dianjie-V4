import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { notifyLossClaimResult } from '../services/notification'
import { isStoreScoped, isSupplierRole } from '../lib/auth-scope'

/**
 * 报损被批准 (含自动同意): 回补供应商库存
 * 我们 ship 时按订单量扣了, 短量没真正送达的应该补回
 */
export async function refundSupplierStockOnLossApproved(claim: any, operatorId: string, reason: string) {
  if (!claim.items || claim.items.length === 0) return
  for (const it of claim.items) {
    const productId = it.productId
    const lossQty = Number(it.lossQty)
    if (!productId || lossQty <= 0) continue
    try {
      const cur = await prisma.product.findUnique({ where: { id: productId }, select: { stock: true, supplierId: true } })
      if (!cur || !cur.supplierId) continue
      const newStock = Number(cur.stock) + lossQty
      await prisma.product.update({ where: { id: productId }, data: { stock: newStock } })
      await prisma.supplierStockMovement.create({
        data: {
          tenantId: claim.tenantId, supplierId: cur.supplierId, productId,
          delta: lossQty, balanceAfter: newStock,
          type: 'ADJUSTMENT' as any,
          reason: `${reason}, 回补未送达 ${lossQty}`,
          sourceType: 'LossClaim', sourceId: claim.id,
          createdById: operatorId,
        },
      })
    } catch (e) {
      console.error('回补库存失败', productId, e)
    }
  }
}

/**
 * 检查采购订单关联的所有报损是否全部结案，
 * 如果是，将订单状态从 RECEIVED → COMPLETED
 */
async function tryCompleteOrder(purchaseOrderId: string, tenantId: string) {
  const pendingClaims = await prisma.lossClaim.count({
    where: {
      purchaseOrderId,
      tenantId,
      status: { in: ['PENDING', 'NEGOTIATING'] },
    },
  })
  if (pendingClaims === 0) {
    await prisma.purchaseOrder.updateMany({
      where: { id: purchaseOrderId, tenantId, status: 'RECEIVED' },
      data: { status: 'COMPLETED' },
    })
  }
}

export const lossClaimRoutes: FastifyPluginAsync = async (app) => {

  // ── 列表 ──────────────────────────────────────────
  app.get('/', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, storeId, role, supplierId: userSupplierId } = req.user
    const { status } = req.query as any
    const where: any = { tenantId }

    if (isStoreScoped(role) && storeId) where.storeId = storeId
    if (isSupplierRole(role) && userSupplierId) where.supplierId = userSupplierId
    if (status) where.status = status

    return prisma.lossClaim.findMany({
      where, orderBy: { createdAt: 'desc' },
      include: {
        store: { select: { name: true } },
        supplier: { select: { name: true } },
        purchaseOrder: { select: { no: true } },
        createdBy: { select: { name: true } },
        handledBy: { select: { name: true, role: true } },
        items: { include: { product: { select: { name: true, unit: true } } } },
      },
    })
  })

  // ── 创建报损申请（门店）──────────────────────────
  app.post('/', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, userId, storeId: userStoreId } = req.user
    const { purchaseOrderId, description, evidenceImages, items } = req.body as any

    if (!items?.length) throw { statusCode: 400, message: '请填写报损明细' }
    if (!description) throw { statusCode: 400, message: '请填写报损说明' }
    if (!evidenceImages?.length) throw { statusCode: 400, message: '请上传证据图片' }

    const order = await prisma.purchaseOrder.findFirst({
      where: { id: purchaseOrderId, tenantId },
    })
    if (!order) throw { statusCode: 404, message: '采购订单不存在' }

    let totalLossAmount = 0
    const itemsData = items.map((i: any) => {
      const lossQty = Number(i.orderedQty) - Number(i.receivedQty)
      const lossAmount = lossQty * Number(i.unitPrice)
      totalLossAmount += lossAmount
      return {
        productId: i.productId,
        orderedQty: i.orderedQty,
        receivedQty: i.receivedQty,
        lossQty,
        unitPrice: i.unitPrice,
        lossAmount,
      }
    })

    const ym = dayjs().format('YYYYMM')
    const count = await prisma.lossClaim.count({ where: { tenantId, no: { startsWith: `LC${ym}` } } })
    const no = `LC${ym}${String(count + 1).padStart(6, '0')}`

    // 计算24小时自动批准时间
    const autoApproveAt = dayjs().add(24, 'hour').toDate()

    const claim = await prisma.lossClaim.create({
      data: {
        tenantId, no,
        purchaseOrderId,
        storeId: order.storeId,
        supplierId: order.supplierId,
        totalLossAmount,
        description,
        evidenceImages: evidenceImages || [],
        status: 'PENDING',
        createdById: userId,
        items: { create: itemsData },
      },
      include: { items: { include: { product: true } } },
    })

    await prisma.opLog.create({
      data: {
        tenantId, userId,
        action: `提交报损申请 ${no}，损失 ¥${totalLossAmount}`,
        target: no, entityType: 'LossClaim', targetId: claim.id,
        metadata: { autoApproveAt },
      },
    })

    return { ...claim, autoApproveAt }
  })

  // ── 店内自有报损（盘点路径）─────────────────────────
  // 不与供应商挂钩、不扣账期, 只影响 P&L
  app.post('/manual', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, storeId: userStoreId, role } = req.user
    if (!['MANAGER', 'KITCHEN_LEAD', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '无权创建报损' })
    }
    const { items, reason, description } = req.body as any
    if (!items?.length) return reply.status(400).send({ error: '请填写报损明细' })
    if (!reason) return reply.status(400).send({ error: '请选择报损原因' })

    const storeId = userStoreId
    if (!storeId) return reply.status(400).send({ error: '当前账号未绑定门店' })

    // items: [{ productId, quantity, unitPrice }]
    let totalLossAmount = 0
    const itemsData = items.map((i: any) => {
      const lossQty = Number(i.quantity)
      const lossAmount = lossQty * Number(i.unitPrice)
      totalLossAmount += lossAmount
      return {
        productId: i.productId,
        orderedQty: lossQty,    // 盘点报损：下单 = 报损（占位）
        receivedQty: 0,
        lossQty,
        unitPrice: i.unitPrice,
        lossAmount,
      }
    })

    const ym = dayjs().format('YYYYMM')
    const count = await prisma.lossClaim.count({ where: { tenantId, no: { startsWith: `LC${ym}` } } })
    const no = `LC${ym}${String(count + 1).padStart(6, '0')}`

    // 阈值审批: ≥¥500 进 PENDING 等总厨审, ≥¥3000 通知老板. 防止店员私自录大额损耗
    const NEED_REVIEW_THRESHOLD = 500
    const needsReview = totalLossAmount >= NEED_REVIEW_THRESHOLD
    const initialStatus = needsReview ? 'PENDING' : 'AUTO_APPROVED'

    const claim = await prisma.lossClaim.create({
      data: {
        tenantId, no,
        storeId,
        purchaseOrderId: null,
        supplierId: null,
        reason,
        isManual: true,
        totalLossAmount,
        description: description || `${reason} · 店内盘点`,
        evidenceImages: [],
        status: initialStatus as any,
        autoApproved: !needsReview,
        createdById: userId,
        items: { create: itemsData },
      },
      include: { items: { include: { product: true } } },
    })

    await prisma.opLog.create({
      data: {
        tenantId, userId,
        action: `店内报损 ${no} ¥${totalLossAmount.toFixed(2)} ${needsReview ? '(待总厨审)' : '(阈值内自动通过)'}`,
        target: no, entityType: 'LossClaim', targetId: claim.id,
      },
    })

    // 超阈值时通知总厨 (阈值 ¥500) + 老板 (阈值 ¥3000)
    if (needsReview) {
      try {
        const { sendNotification } = await import('../services/notification')
        const isHigh = totalLossAmount >= 3000
        const recipients = isHigh ? ['CHEF_DIRECTOR', 'ADMIN'] : ['CHEF_DIRECTOR']
        for (const r of recipients) {
          void sendNotification({
            tenantId, recipientRole: r as any,
            type: 'LOSS_CLAIM_PENDING' as any,
            title: `店内报损待审 ¥${totalLossAmount.toFixed(0)}`,
            body: `${no} 原因:${reason}, ${items.length} 项 · 待你审`,
            refType: 'LossClaim', refId: claim.id,
          })
        }
      } catch {}
    }

    return reply.status(201).send(claim)
  })

  // ── 供应商处理报损 ────────────────────────────────
  app.patch('/:id/handle', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, userId, role } = req.user
    const { id } = req.params as any
    const { action, note } = req.body as any  // approve | reject

    if (!['SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'SUPPLIER_SUB', 'ADMIN', 'SUPER_ADMIN'].includes(role)) throw { statusCode: 403, message: '无权限' }
    if (!['approve', 'reject'].includes(action)) throw { statusCode: 400, message: 'action 必须是 approve 或 reject' }
    if (action === 'reject' && (!note || !note.trim())) throw { statusCode: 400, message: '拒绝时必须填写原因' }

    const claim = await prisma.lossClaim.findFirst({
      where: { id, tenantId, status: { in: ['PENDING', 'AUTO_APPROVED'] } },
      include: { purchaseOrder: { include: { receipt: true } }, items: true },
    })
    if (!claim) throw { statusCode: 400, message: '报损申请不存在或已处理' }

    if (action === 'approve') {
      // P0 修复设计: receipt.totalAmount 已经是实收金额, schedule.amount 已经按实收, 不再扣
      // 改为回补供应商库存 (我们 ship 时按订单量扣了, 短量没送的应该补回来)
      await refundSupplierStockOnLossApproved(claim, userId, '供应商同意报损 ' + claim.no)

      await prisma.lossClaim.update({
        where: { id },
        data: { status: 'APPROVED', handledAt: new Date(), handledById: userId, handlerNote: note },
      })

      await prisma.opLog.create({
        data: {
          tenantId, userId,
          action: `供应商同意报损 ${claim.no}，回补供应商库存 (账期金额已是实收, 不再扣)`,
          target: claim.no, entityType: 'LossClaim', targetId: id,
        },
      })
    } else {
      // 供应商拒绝: 主张全部送达, 门店应按全额付 → schedule 加回报损金额 + 暂停付款待协商
      const schedule = await prisma.paymentSchedule.findUnique({
        where: { receiptId: claim.purchaseOrder.receiptId! },
      })
      if (schedule && (schedule.status === 'PENDING' || schedule.status === 'PENDING_APPROVAL' || schedule.status === 'APPROVED')) {
        const newAmount = Number(schedule.amount) + Number(claim.totalLossAmount)
        await prisma.paymentSchedule.update({
          where: { id: schedule.id },
          data: { amount: newAmount, status: 'ON_HOLD' as any },
        })
      }
      await prisma.lossClaim.update({
        where: { id },
        data: { status: 'REJECTED', handledAt: new Date(), handledById: userId, handlerNote: note },
      })

      await prisma.opLog.create({
        data: {
          tenantId, userId,
          action: `供应商拒绝报损 ${claim.no}, 账期金额加回 ¥${claim.totalLossAmount} + 冻结付款待协商`,
          target: claim.no, entityType: 'LossClaim', targetId: id,
        },
      })
    }

    // 检查该订单所有报损是否全部结案
    void tryCompleteOrder(claim.purchaseOrderId, tenantId)

    void notifyLossClaimResult(tenantId, claim.no, action, Number(claim.totalLossAmount))
    return { success: true, action }
  })

  // ── 总厨审核店内报损 (isManual=true, ≥¥500 阈值进 PENDING) ──
  app.patch('/:id/manual-review', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    const { id } = req.params as any
    const { action, note } = (req.body || {}) as any
    if (!['CHEF_DIRECTOR', 'CHEF', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '仅总厨/老板可审核店内报损' })
    }
    if (!['approve', 'reject'].includes(action)) {
      return reply.status(400).send({ error: 'action 必须 approve/reject' })
    }
    if (action === 'reject' && (!note || !String(note).trim())) {
      return reply.status(400).send({ error: '拒绝时必须填写原因' })
    }
    const claim = await prisma.lossClaim.findFirst({
      where: { id, tenantId, isManual: true, status: 'PENDING' },
    })
    if (!claim) return reply.status(400).send({ error: '不存在 / 非待审 / 非店内报损' })

    const newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED'
    await prisma.lossClaim.update({
      where: { id },
      data: { status: newStatus as any, handledAt: new Date(), handledById: userId, handlerNote: note || null },
    })
    await prisma.opLog.create({
      data: {
        tenantId, userId,
        action: `[总厨审] 店内报损 ${claim.no} ¥${claim.totalLossAmount} → ${action === 'approve' ? '通过' : '驳回'}${note ? ' (' + String(note).slice(0,80) + ')' : ''}`,
        target: claim.no, entityType: 'LossClaim', targetId: id,
      },
    })
    // 通知发起人
    try {
      const { sendNotification } = await import('../services/notification')
      void sendNotification({
        tenantId, recipientRole: 'KITCHEN_LEAD' as any,
        type: 'LOSS_CLAIM_RESULT' as any,
        title: action === 'approve' ? '店内报损通过' : '店内报损被驳回',
        body: `${claim.no} ${action === 'approve' ? '已计入损耗' : '驳回, 请核对实物'}${note ? ' · ' + String(note).slice(0,40) : ''}`,
        refType: 'LossClaim', refId: id,
      })
    } catch {}
    return { success: true }
  })

  // ── 门店协商解决（被拒绝后）──────────────────────
  app.patch('/:id/resolve', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, userId, role } = req.user
    const { id } = req.params as any
    const { note } = req.body as any

    // 仅总厨 / 老板 / 超管 可仲裁 — 防止店长私自闭环
    if (!['CHEF_DIRECTOR', 'CHEF', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      throw { statusCode: 403, message: '仅总厨可仲裁争议报损' }
    }

    const { finalDeductAmount } = (req.body || {}) as any  // 协商最终扣减金额, 可选
    const claim = await prisma.lossClaim.findFirst({
      where: { id, tenantId, status: 'REJECTED' },
      include: { purchaseOrder: { include: { receipt: true } }, items: true },
    })
    if (!claim) throw { statusCode: 400, message: '报损申请不存在或非争议状态' }

    await prisma.lossClaim.update({
      where: { id },
      data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedNote: note },
    })

    // 解冻 schedule + 应用协商最终扣减
    if (claim.purchaseOrder?.receiptId) {
      const sch = await prisma.paymentSchedule.findUnique({ where: { receiptId: claim.purchaseOrder.receiptId } })
      if (sch && sch.status === 'ON_HOLD') {
        // 当前 amount 是 reject 时回补到全额, 减去协商扣减额
        const deduct = Number(finalDeductAmount || 0)
        await prisma.paymentSchedule.update({
          where: { id: sch.id },
          data: { amount: Math.max(0, Number(sch.amount) - deduct), status: 'PENDING' as any },
        })
      }
      // 如果协商扣减 > 0, 视为部分认可短量, 也回补部分库存
      if (Number(finalDeductAmount || 0) > 0) {
        await refundSupplierStockOnLossApproved(claim, userId, `协商扣减 ¥${finalDeductAmount} 部分回补`)
      }
    }

    // opLog + 通知双方
    await prisma.opLog.create({
      data: { tenantId, userId, action: `[仲裁] ${claim.no} 总厨判: 扣 ¥${Number(finalDeductAmount || 0).toFixed(2)} ${note ? '(' + String(note).slice(0,80) + ')' : ''}`,
              target: claim.no, entityType: 'LossClaim', targetId: id }
    })
    try {
      const { sendNotification } = await import('../services/notification')
      const body = `总厨仲裁: ${claim.no} 最终扣 ¥${Number(finalDeductAmount || 0).toFixed(2)}${note ? ' · ' + String(note).slice(0,40) : ''}`
      for (const r of ['MANAGER', 'KITCHEN_LEAD', 'SUPPLIER_OWNER', 'SUPPLIER_STAFF']) {
        void sendNotification({
          tenantId, recipientRole: r as any, type: 'LOSS_CLAIM_RESULT' as any,
          title: '报损争议已仲裁', body, refType: 'LossClaim', refId: id,
        })
      }
    } catch {}

    void tryCompleteOrder(claim.purchaseOrderId, tenantId)
    return { success: true, finalDeductAmount: Number(finalDeductAmount || 0) }
  })
}
