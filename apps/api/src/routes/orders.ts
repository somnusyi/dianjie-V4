import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { invalidatePattern } from '../lib/cache'
import { notifyOrderSubmitted, notifyOrderShipped, notifyOrderConfirmed, notifyOrderRejected } from '../services/notification'
import { isStoreScoped, isSupplierRole } from '../lib/auth-scope'

// CLAUDE.md 约定：所有写入用 zod 校验
const orderItemSchema = z.object({
  productId: z.string().min(1, 'productId 必填'),
  quantity:  z.number().positive('quantity 必须 > 0'),
  unitPrice: z.number().nonnegative('unitPrice 不能为负'),
})
const orderCreateSchema = z.object({
  storeId:      z.string().optional(),
  supplierId:   z.string().min(1, 'supplierId 必填'),
  expectedDate: z.string().min(1, 'expectedDate 必填'),
  note:         z.string().optional().default(''),
  items:        z.array(orderItemSchema).min(1, '至少一条采购明细'),
})

export const purchaseOrderRoutes: FastifyPluginAsync = async (app) => {

  // ── 列表 ──────────────────────────────────────────
  app.get('/', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, storeId, role, supplierId: userSupplierId } = req.user
    const { status, storeId: qStore, supplierId: qSupplier, page = '1', pageSize = '20' } = req.query as any
    const where: any = { tenantId }

    // 门店级角色（店长/总厨/采购）只看自己门店
    if (isStoreScoped(role) && storeId) where.storeId = storeId
    // 供应商只看发给自己的
    if (isSupplierRole(role) && userSupplierId) where.supplierId = userSupplierId

    if (status) where.status = status
    if (qStore && !isStoreScoped(role)) where.storeId = qStore
    if (qSupplier && !isSupplierRole(role)) where.supplierId = qSupplier

    const p = Math.max(1, parseInt(page))
    const ps = Math.min(100, Math.max(1, parseInt(pageSize)))
    const skip = (p - 1) * ps

    const [items, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where, orderBy: { createdAt: 'desc' },
        skip, take: ps,
        include: {
          store: { select: { id: true, name: true } },
          supplier: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
          items: { include: { product: { select: { name: true, unit: true } } } },
          lossClaims: { select: { id: true, status: true, totalLossAmount: true } },
        },
      }),
      prisma.purchaseOrder.count({ where }),
    ])
    return { items, total, page: p, pageSize: ps }
  })

  // ── 详情 ──────────────────────────────────────────
  app.get('/:id', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, storeId, role, supplierId: userSupplierId } = req.user
    const { id } = req.params as any
    // 按角色 scope 过滤，避免店长/供应商越权读到别家单据
    const where: any = { id, tenantId }
    if (isStoreScoped(role) && storeId) where.storeId = storeId
    if (isSupplierRole(role) && userSupplierId) where.supplierId = userSupplierId
    const order = await prisma.purchaseOrder.findFirst({
      where,
      include: {
        store: true, supplier: true,
        createdBy: { select: { id: true, name: true } },
        shippedBy: { select: { id: true, name: true } },
        items: { include: { product: true } },
        lossClaims: { include: { items: { include: { product: true } } } },
        receipt: true,
      },
    })
    if (!order) throw { statusCode: 404, message: '采购订单不存在' }
    return order
  })

  // ── 创建（店长）──────────────────────────────────
  app.post('/', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const parsed = orderCreateSchema.safeParse(req.body)
    if (!parsed.success) {
      const first = parsed.error.errors[0]
      return reply.status(400).send({ error: `${first.path.join('.')}: ${first.message}` })
    }
    const { tenantId, userId, storeId: userStoreId, role } = req.user
    const { storeId, supplierId, expectedDate, note, items } = parsed.data

    // 单店级角色 (店长/厨师长/...) 强制用 token 里的 storeId, 防止跨店越权
    // 集团级 (BOSS/FINANCE) 才允许传 storeId 指定门店
    const finalStoreId = isStoreScoped(role) ? userStoreId : storeId
    if (!finalStoreId) return reply.status(400).send({ error: '请指定门店 (storeId)' })

    // 起订量 / 步长 校验 — 防止厨师长漏看 picker 提示直接 POST
    const productIds = items.map((i: any) => i.productId)
    const productsMoq = await prisma.product.findMany({
      where: { id: { in: productIds }, tenantId },
      select: { id: true, name: true, unit: true, minOrderQty: true, stepQty: true },
    })
    const moqMap = new Map(productsMoq.map(p => [p.id, p]))
    for (const i of items) {
      const p = moqMap.get(i.productId)
      if (!p) continue
      const moq = Number(p.minOrderQty || 1)
      const step = Number(p.stepQty || 1)
      const q = Number(i.quantity)
      if (q < moq - 0.0001) {
        return reply.status(400).send({ error: `${p.name} 起订量为 ${moq} ${p.unit}, 当前 ${q}` })
      }
      // 浮点容差 1e-4
      if (step > 0 && Math.abs(((q - moq) / step) - Math.round((q - moq) / step)) > 0.0001) {
        return reply.status(400).send({ error: `${p.name} 需以 ${step} ${p.unit} 为步长 (起 ${moq})` })
      }
    }

    const ym = dayjs().format('YYYYMM')
    const count = await prisma.purchaseOrder.count({ where: { tenantId, no: { startsWith: `PO${ym}` } } })
    const no = `PO${ym}${String(count + 1).padStart(6, '0')}`

    let totalAmount = 0
    const itemsData = items.map((i: any) => {
      const amount = Number(i.quantity) * Number(i.unitPrice)
      totalAmount += amount
      return { productId: i.productId, quantity: i.quantity, unitPrice: i.unitPrice, amount }
    })

    const order = await prisma.purchaseOrder.create({
      data: {
        tenantId, no, storeId: finalStoreId, supplierId,
        expectedDate: new Date(expectedDate),
        totalAmount, note, createdById: userId,
        status: 'SUBMITTED',  // 创建即提交给供应商
        items: { create: itemsData },
      },
      include: { store: true, supplier: true, items: { include: { product: true } } },
    })

    await prisma.opLog.create({ data: { tenantId, userId, action: `创建采购订单 ${no}`, target: no, entityType: 'PurchaseOrder', targetId: order.id } })
    void invalidatePattern(`dashboard:stats:${tenantId}:*`)
    void invalidatePattern(`stores:list:${tenantId}:*`)
    void notifyOrderSubmitted(tenantId, no, order.store.name, supplierId)
    return order
  })

  // ── 供应商接单 ────────────────────────────────
  app.patch('/:id/confirm', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, userId, role } = req.user
    const { id } = req.params as any
    if (!isSupplierRole(role) && !['ADMIN', 'SUPER_ADMIN'].includes(role)) throw { statusCode: 403, message: '无权限' }
    const where: any = { id, tenantId, status: 'SUBMITTED' }
    if (isSupplierRole(role) && req.user.supplierId) where.supplierId = req.user.supplierId
    const order = await prisma.purchaseOrder.findFirst({ where })
    if (!order) throw { statusCode: 400, message: '订单不存在或当前状态不可接单' }
    await prisma.purchaseOrder.update({ where: { id }, data: { status: 'CONFIRMED' } })
    await prisma.opLog.create({
      data: { tenantId, userId, action: '供应商接单', target: order.no, entityType: 'PurchaseOrder', targetId: id },
    })
    const sup = await prisma.supplier.findUnique({ where: { id: order.supplierId }, select: { name: true } })
    void notifyOrderConfirmed(tenantId, order.no, sup?.name || '', order.storeId)
    return { success: true }
  })

  // ── 供应商拒单 ────────────────────────────────
  app.patch('/:id/reject', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, userId, role } = req.user
    const { id } = req.params as any
    const { reason } = (req.body || {}) as any
    if (!isSupplierRole(role) && !['ADMIN', 'SUPER_ADMIN'].includes(role)) throw { statusCode: 403, message: '无权限' }
    if (!reason || !String(reason).trim()) throw { statusCode: 400, message: '请说明拒单原因' }
    const where: any = { id, tenantId, status: { in: ['SUBMITTED', 'CONFIRMED'] } }
    if (isSupplierRole(role) && req.user.supplierId) where.supplierId = req.user.supplierId
    const order = await prisma.purchaseOrder.findFirst({ where })
    if (!order) throw { statusCode: 400, message: '订单不存在或当前状态不可拒单' }
    await prisma.purchaseOrder.update({
      where: { id },
      data: { status: 'CANCELLED', note: (order.note ? order.note + ' | ' : '') + `[拒单] ${String(reason).trim().slice(0, 100)}` },
    })
    await prisma.opLog.create({
      data: { tenantId, userId, action: `供应商拒单: ${String(reason).slice(0, 100)}`, target: order.no, entityType: 'PurchaseOrder', targetId: id },
    })
    const sup = await prisma.supplier.findUnique({ where: { id: order.supplierId }, select: { name: true } })
    void notifyOrderRejected(tenantId, order.no, sup?.name || '', String(reason).trim().slice(0, 100), order.storeId)
    return { success: true }
  })

  // ── 供应商确认发货 ────────────────────────────────
  app.patch('/:id/ship', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, userId, role } = req.user
    const { id } = req.params as any
    const { note } = req.body as any

    if (!isSupplierRole(role) && !['ADMIN', 'SUPER_ADMIN'].includes(role)) throw { statusCode: 403, message: '无权限' }

    const order = await prisma.purchaseOrder.findFirst({
      where: { id, tenantId, status: { in: ['SUBMITTED', 'CONFIRMED'] } },
      include: { items: true },
    })
    if (!order) throw { statusCode: 400, message: '订单不存在或状态不可发货' }

    // 发货后24小时自动确认，计算deadline
    const autoConfirmAt = dayjs().add(24, 'hour').toDate()

    // 事务: 更新 PO 状态 + 自动扣减供应商库存 (每条 item 一笔 OUTBOUND_PO 流水)
    await prisma.$transaction(async (tx) => {
      await tx.purchaseOrder.update({
        where: { id },
        data: { status: 'PENDING_CONFIRM', shippedAt: new Date(), shippedNote: note, shippedById: userId },
      })
      // 仅供应商角色发货时, 同步扣减自家库存. ADMIN 代发货时跳过 (避免误扣)
      if (isSupplierRole(role)) {
        for (const it of order.items) {
          const cur = await tx.product.findUnique({ where: { id: it.productId }, select: { stock: true, supplierId: true } })
          if (!cur || cur.supplierId !== order.supplierId) continue   // 商品不属于本供应商, 跳过 (异常但不阻塞发货)
          const qty = Number(it.quantity)
          const newStock = Number(cur.stock) - qty   // 允许负库存 (供应商承诺先发后补)
          await tx.product.update({ where: { id: it.productId }, data: { stock: newStock } })
          await tx.supplierStockMovement.create({
            data: {
              tenantId, supplierId: order.supplierId, productId: it.productId,
              delta: -qty, balanceAfter: newStock,
              type: 'OUTBOUND_PO' as any,
              reason: `发货 ${order.no}`,
              sourceType: 'PurchaseOrder', sourceId: order.id,
              createdById: userId,
            },
          })
        }
      }
    })

    // 记录24小时自动确认任务（scheduler处理）
    await prisma.opLog.create({
      data: {
        tenantId, userId, isAi: false,
        action: `供应商确认发货，24小时内未确认将自动收货`,
        target: order.no, entityType: 'PurchaseOrder', targetId: id,
        metadata: { autoConfirmAt },
      },
    })

    // 查供应商名
    const supplier = await prisma.supplier.findUnique({ where: { id: order.supplierId }, select: { name: true } })
    void notifyOrderShipped(tenantId, order.no, supplier?.name || '', order.storeId)
    return { success: true, autoConfirmAt }
  })

  // ── 门店确认收货（完全一致）──────────────────────
  app.patch('/:id/receive', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, userId, role, storeId } = req.user
    const { id } = req.params as any
    const { items: receivedItems } = req.body as any  // [{ productId, receivedQty }]

    // P1-1: 仅店长 / 厨师长 / 老板 / 超管 能确认收货 (供应商不该能调)
    if (!['MANAGER', 'KITCHEN_LEAD', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      throw { statusCode: 403, message: '仅门店人员可确认收货' }
    }

    // 加 store scope: 店长/厨师长 只能确认本店的单
    const orderWhere: any = { id, tenantId, status: 'PENDING_CONFIRM' }
    if (isStoreScoped(role)) orderWhere.storeId = storeId
    const order = await prisma.purchaseOrder.findFirst({
      where: orderWhere,
      include: { items: true, supplier: true },
    })
    if (!order) throw { statusCode: 400, message: '订单不存在 / 非待确认 / 非本店' }

    // 更新每项实际收货数量 (没传的 item 视为 全收)
    if (receivedItems?.length) {
      for (const ri of receivedItems) {
        await prisma.purchaseOrderItem.updateMany({
          where: { purchaseOrderId: id, productId: ri.productId },
          data: { receivedQty: ri.receivedQty },
        })
      }
    }
    // 重新读 items 拿到最新 receivedQty
    const updatedItems = await prisma.purchaseOrderItem.findMany({ where: { purchaseOrderId: id } })

    // P0-1: Receipt.totalAmount = sum(receivedQty * unitPrice), 不再用 order.totalAmount
    const actualReceivedTotal = updatedItems.reduce((s, i) => {
      const q = i.receivedQty != null ? Number(i.receivedQty) : Number(i.quantity)
      return s + q * Number(i.unitPrice)
    }, 0)

    // 生成入库单
    const ym = dayjs().format('YYYYMM')
    const count = await prisma.receipt.count({ where: { tenantId, no: { startsWith: `RK${ym}` } } })
    const no = `RK${ym}${String(count + 1).padStart(6, '0')}`

    const receipt = await prisma.receipt.create({
      data: {
        tenantId, no,
        storeId: order.storeId,
        supplierId: order.supplierId,
        deliveryDate: new Date(),
        totalAmount: actualReceivedTotal,   // 实收金额, 不含损耗
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        createdById: userId,
        items: {
          create: updatedItems.map(i => ({
            productId: i.productId,
            quantity: i.receivedQty ?? i.quantity,
            unitPrice: i.unitPrice,
            amount: Number(i.unitPrice) * Number(i.receivedQty ?? i.quantity),
          })),
        },
      },
    })

    // 判断是否存在报损：实收数量 < 下单数量
    const lossLines = (receivedItems || [])
      .map((ri: any) => {
        const original = order.items.find(i => i.productId === ri.productId)
        if (!original) return null
        const lossQty = Number(original.quantity) - Number(ri.receivedQty)
        if (lossQty <= 0) return null
        return {
          productId: ri.productId,
          orderedQty: original.quantity,
          receivedQty: ri.receivedQty,
          lossQty,
          unitPrice: original.unitPrice,
          lossAmount: lossQty * Number(original.unitPrice),
        }
      })
      .filter(Boolean) as Array<{
        productId: string; orderedQty: any; receivedQty: number;
        lossQty: number; unitPrice: any; lossAmount: number;
      }>

    const hasLoss = lossLines.length > 0

    // 自动建报损单（v2 流程：收货时短量自动发起索赔，24h 内供应商未响应自动同意）
    if (hasLoss) {
      const ym = dayjs().format('YYYYMM')
      const lcCount = await prisma.lossClaim.count({ where: { tenantId, no: { startsWith: `LC${ym}` } } })
      const lcNo = `LC${ym}${String(lcCount + 1).padStart(6, '0')}`
      const totalLoss = lossLines.reduce((s, l) => s + l.lossAmount, 0)
      await prisma.lossClaim.create({
        data: {
          tenantId, no: lcNo,
          purchaseOrderId: id,
          storeId: order.storeId,
          supplierId: order.supplierId,
          totalLossAmount: totalLoss,
          description: `验收短量自动报损 (${order.no})`,
          evidenceImages: [],
          status: 'PENDING',
          createdById: userId,
          items: { create: lossLines },
        },
      })
      await prisma.opLog.create({
        data: {
          tenantId, userId,
          action: `验收短量自动建报损 ${lcNo}，损失 ¥${totalLoss.toFixed(2)}`,
          target: lcNo, entityType: 'LossClaim',
        },
      })
    }

    await prisma.purchaseOrder.update({
      where: { id },
      data: { status: hasLoss ? 'RECEIVED' : 'COMPLETED', receivedAt: new Date(), receiptId: receipt.id },
    })

    // 触发自动对账+账期
    const { autoProcessAfterConfirm } = await import('../services/paymentSchedule')
    const receiptFull = await prisma.receipt.findUnique({ where: { id: receipt.id } }) as any
    receiptFull.confirmedAt = new Date()
    await autoProcessAfterConfirm({ tenantId, receipt: receiptFull, supplier: order.supplier })

    await prisma.opLog.create({ data: { tenantId, userId, action: `确认收货 ${order.no}，生成入库单 ${no}`, target: order.no, entityType: 'PurchaseOrder', targetId: id } })
    void invalidatePattern(`dashboard:stats:${tenantId}:*`)
    void invalidatePattern(`stores:list:${tenantId}:*`)
    return { success: true, receipt }
  })

  // ── 取消订单（店长）──────────────────────────────
  app.patch('/:id/cancel', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, userId } = req.user
    const { id } = req.params as any
    const order = await prisma.purchaseOrder.findFirst({ where: { id, tenantId, status: { notIn: ['RECEIVED', 'COMPLETED', 'CANCELLED'] } } })
    if (!order) throw { statusCode: 400, message: '当前状态不可取消' }
    await prisma.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED' } })
    await prisma.opLog.create({ data: { tenantId, userId, action: `取消采购订单 ${order.no}`, target: order.no, entityType: 'PurchaseOrder', targetId: id } })
    return { success: true }
  })
}
