import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { notifyLossClaimResult } from '../services/notification'
import { isStoreScoped, isSupplierRole } from '../lib/auth-scope'
import { resignOssUrls } from './upload'
import { fireAndForget as notify } from '../services/notify'

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
      // P0: 原子加, 避免并发报损同意时丢更新
      const updated = await prisma.product.update({
        where: { id: productId },
        data: { stock: { increment: lossQty } },
        select: { stock: true, supplierId: true },
      })
      if (!updated.supplierId) continue
      await prisma.supplierStockMovement.create({
        data: {
          tenantId: claim.tenantId, supplierId: updated.supplierId, productId,
          delta: lossQty, balanceAfter: updated.stock,
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

    const claims = await prisma.lossClaim.findMany({
      where, orderBy: { createdAt: 'desc' },
      include: {
        store: { select: { name: true } },
        supplier: { select: { name: true } },
        purchaseOrder: { select: { id: true, no: true } },
        createdBy: { select: { name: true } },
        handledBy: { select: { name: true, role: true } },
        items: { include: { product: { select: { name: true, unit: true } } } },
      },
    })
    // OSS 签名 1h 过期 → 读取时统一重签,前端不会再看到裂图
    return claims.map((c) => ({ ...c, evidenceImages: resignOssUrls(c.evidenceImages) }))
  })

  // ── 创建报损申请（门店）──────────────────────────
  app.post('/', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, userId, storeId: userStoreId, role } = req.user
    const { purchaseOrderId, description, evidenceImages, items } = req.body as any

    // P0: 仅门店人员/管理员可创建针对采购订单的报损 (供应商不能给自己创建)
    if (!['MANAGER', 'KITCHEN_LEAD', 'PURCHASER', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      throw { statusCode: 403, message: '无权创建报损申请' }
    }
    if (!items?.length) throw { statusCode: 400, message: '请填写报损明细' }
    if (!description) throw { statusCode: 400, message: '请填写报损说明' }
    if (!evidenceImages?.length) throw { statusCode: 400, message: '请上传证据图片' }

    // 加 store scope: 店长/厨师长 只能给自己门店建报损
    const orderWhere: any = { id: purchaseOrderId, tenantId }
    if (isStoreScoped(role) && userStoreId) orderWhere.storeId = userStoreId
    const order = await prisma.purchaseOrder.findFirst({
      where: orderWhere,
      include: { items: true },
    })
    if (!order) throw { statusCode: 404, message: '采购订单不存在' }

    // P0: 服务端用订单 item 的 shippedQty + unitPrice 作为权威值, 完全忽略客户端 orderedQty/unitPrice
    // 之前漏洞: 客户端可任意构造 lossQty=99999 / unitPrice=10000 → 凭空扣对方账期
    const poItemMap = new Map(order.items.map((it: any) => [it.productId, it]))
    let totalLossAmount = 0
    const itemsData: any[] = []
    for (const i of items) {
      const poi: any = poItemMap.get(i.productId)
      if (!poi) throw { statusCode: 400, message: `订单中无此 SKU: ${i.productId}` }
      const orderedQty = Number(poi.shippedQty ?? poi.quantity)  // 应到 = 实发 (供应商在 ship 时填)
      const receivedQty = Math.max(0, Math.min(orderedQty, Number(i.receivedQty || 0)))  // clamp [0, orderedQty]
      const lossQty = +(orderedQty - receivedQty).toFixed(4)
      if (lossQty <= 0) continue   // 没短量, 跳过
      const unitPrice = Number(poi.unitPrice)  // 用订单 snapshot 价, 防客户端调价
      const lossAmount = +(lossQty * unitPrice).toFixed(2)
      totalLossAmount = +(totalLossAmount + lossAmount).toFixed(2)
      itemsData.push({
        productId: i.productId,
        orderedQty, receivedQty, lossQty, unitPrice, lossAmount,
      })
    }
    if (itemsData.length === 0) {
      throw { statusCode: 400, message: '没有需要报损的明细 (实收 ≥ 应到)' }
    }

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

    // 通知供应商 (M2 触达层)
    if (order.supplierId) {
      const store = await prisma.store.findUnique({ where: { id: order.storeId }, select: { name: true } })
      const itemPreview = claim.items.slice(0, 2).map((it) => `${it.product?.name || ''} 损 ${it.lossQty}`).join('/')
      notify({
        tenantId, event: 'LOSS_PENDING',
        eventKey: `LC:${claim.id}:PENDING`,
        payload: {
          lossId: claim.id, lossNo: no, orderId: purchaseOrderId,
          storeName: store?.name || '', amount: totalLossAmount,
          itemPreview,
        },
        toSupplierIds: [order.supplierId],
      })
    }

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

    // P0: 加 supplier scope, 避免 supplier A 处理 supplier B 的报损; 排除店内自有盘点报损 (isManual)
    const claimWhere: any = { id, tenantId, status: { in: ['PENDING', 'AUTO_APPROVED'] }, isManual: false }
    if (isSupplierRole(role) && req.user.supplierId) claimWhere.supplierId = req.user.supplierId
    const claim = await prisma.lossClaim.findFirst({
      where: claimWhere,
      include: { purchaseOrder: { include: { receipt: true } }, items: true },
    })
    if (!claim) throw { statusCode: 400, message: '报损申请不存在或已处理' }

    if (action === 'approve') {
      // P0 修复设计: receipt.totalAmount 已经是实收金额, schedule.amount 已经按实收, 不再扣
      // 改为回补供应商库存 (我们 ship 时按订单量扣了, 短量没送的应该补回来)
      await refundSupplierStockOnLossApproved(claim, userId, '供应商同意报损 ' + claim.no)

      // 财务凭证: 报损 → 借:销售费用-报损 / 贷:库存商品
      try {
        const [store, supplier] = await Promise.all([
          prisma.store.findUnique({ where: { id: claim.storeId }, select: { name: true } }),
          claim.supplierId ? prisma.supplier.findUnique({ where: { id: claim.supplierId }, select: { name: true } }) : Promise.resolve(null),
        ])
        const { voucherForLossApproved } = await import('../services/voucher')
        voucherForLossApproved({
          tenantId, lossClaimId: claim.id, lossClaimNo: claim.no,
          storeName: store?.name || '门店',
          supplierName: supplier?.name || '供应商',
          amount: Number(claim.totalLossAmount),
          date: new Date(),
        })
      } catch (e: any) {
        console.error('[voucher] 报损凭证生成失败', e)
      }

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
      // claim.purchaseOrder 理论可空 (manual 报损), 上面 isManual=false 已过滤
      if (!claim.purchaseOrder?.receiptId) {
        throw { statusCode: 500, message: '订单收据未生成, 无法回退账期' }
      }
      const schedule = await prisma.paymentSchedule.findUnique({
        where: { receiptId: claim.purchaseOrder.receiptId },
      })
      if (schedule && (schedule.status === 'PENDING' || schedule.status === 'PENDING_APPROVAL' || schedule.status === 'APPROVED')) {
        // P0: 原子加, 避免并发拒绝时丢更新
        await prisma.paymentSchedule.update({
          where: { id: schedule.id },
          data: {
            amount: { increment: Number(claim.totalLossAmount) },
            status: 'ON_HOLD' as any,
          },
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

      // 通知总厨仲裁 (M2 触达层)
      const [store, supplier] = await Promise.all([
        prisma.store.findUnique({ where: { id: claim.storeId }, select: { name: true } }),
        claim.supplierId ? prisma.supplier.findUnique({ where: { id: claim.supplierId }, select: { name: true } }) : Promise.resolve(null),
      ])
      notify({
        tenantId, event: 'LOSS_REJECTED',
        eventKey: `LC:${claim.id}:REJECTED`,
        payload: {
          lossId: claim.id, lossNo: claim.no,
          storeName: store?.name || '', supplierName: supplier?.name || '',
          amount: Number(claim.totalLossAmount),
        },
      })
    }

    // 检查该订单所有报损是否全部结案
    if (claim.purchaseOrderId) void tryCompleteOrder(claim.purchaseOrderId, tenantId)

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
        const deduct = Number(finalDeductAmount || 0)
        // P0: 原子减, 避免并发争议时丢更新; 用 decrement + 在数据层保证非负无法直接做, 改用事务读改写并 clamp
        await prisma.$transaction(async (tx) => {
          const fresh = await tx.paymentSchedule.findUnique({ where: { id: sch.id }, select: { amount: true } })
          if (!fresh) return
          const next = Math.max(0, Number(fresh.amount) - deduct)
          await tx.paymentSchedule.update({
            where: { id: sch.id },
            data: { amount: next, status: 'PENDING' as any },
          })
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

    if (claim.purchaseOrderId) void tryCompleteOrder(claim.purchaseOrderId, tenantId)
    return { success: true, finalDeductAmount: Number(finalDeductAmount || 0) }
  })
}
