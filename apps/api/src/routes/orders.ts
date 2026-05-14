import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { invalidatePattern } from '../lib/cache'
import { notifyOrderSubmitted, notifyOrderShipped, notifyOrderConfirmed, notifyOrderRejected, sendNotification } from '../services/notification'
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
  // 防重复提交: 客户端 uuid, 后端缓存 60s 拦截重复 POST
  idempotencyKey: z.string().max(80).optional(),
})

// 内存级幂等缓存 (60s TTL) — 防止厨师长双击 / 网络重试创双单
const idempotencyCache = new Map<string, { orderId: string; orderNo: string; expiresAt: number }>()
function getIdempotent(key: string) {
  const v = idempotencyCache.get(key)
  if (!v) return null
  if (v.expiresAt < Date.now()) { idempotencyCache.delete(key); return null }
  return v
}
function setIdempotent(key: string, orderId: string, orderNo: string) {
  idempotencyCache.set(key, { orderId, orderNo, expiresAt: Date.now() + 60_000 })
}

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
    const { storeId, supplierId, expectedDate, note, items, idempotencyKey } = parsed.data

    // 防重复提交: 客户端给 idempotencyKey 时, 60s 内同 key 的二次请求直接返回首单
    if (idempotencyKey) {
      const cacheKey = `${tenantId}:${userId}:${idempotencyKey}`
      const cached = getIdempotent(cacheKey)
      if (cached) {
        const dup = await prisma.purchaseOrder.findUnique({
          where: { id: cached.orderId },
          include: { store: true, supplier: true, items: { include: { product: true } } },
        })
        if (dup) return dup    // 静默返回首单, 不报错
      }
    }

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
    if (idempotencyKey) setIdempotent(`${tenantId}:${userId}:${idempotencyKey}`, order.id, no)
    return order
  })

  // ── 取消订单 (下单方主动撤回, 仅 SUBMITTED 状态可取消, 供应商接单后只能让供应商拒) ────
  app.patch('/:id/cancel', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, role, storeId } = req.user
    const { id } = req.params as any
    const { reason } = (req.body || {}) as any
    // 仅下单方角色可取消 (店长/厨师长/老板/超管/采购)
    if (!['MANAGER', 'KITCHEN_LEAD', 'PURCHASER', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '无权撤回订单' })
    }
    const where: any = { id, tenantId, status: 'SUBMITTED' }   // 接单后由供应商拒, 不再走撤回
    if (isStoreScoped(role) && storeId) where.storeId = storeId
    const order = await prisma.purchaseOrder.findFirst({ where })
    if (!order) return reply.status(400).send({ error: '订单不存在 / 已被供应商接单 / 状态不可撤回' })

    await prisma.purchaseOrder.update({
      where: { id },
      data: { status: 'CANCELLED', note: (order.note ? order.note + ' | ' : '') + `[撤回] ${String(reason || '').trim().slice(0, 100)}` },
    })
    await prisma.opLog.create({
      data: { tenantId, userId, action: `下单方撤回订单${reason ? ': ' + String(reason).slice(0,80) : ''}`, target: order.no, entityType: 'PurchaseOrder', targetId: id },
    })
    // 通知供应商 (避免他正在准备发货)
    const sup = await prisma.supplier.findUnique({ where: { id: order.supplierId }, select: { name: true } })
    void sendNotification({
      tenantId, recipientRole: 'SUPPLIER_STAFF',
      type: 'ORDER_CANCELLED' as any,
      title: `订单撤回 ${order.no}`,
      body: `${sup?.name || ''} 的订单 ${order.no} 已被下单方撤回${reason ? ': ' + String(reason).slice(0,40) : ''}`,
      refType: 'PurchaseOrder', refId: id,
    })
    return { success: true }
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

  // ── 供应商代加物品 (CONFIRMED 状态, 群里追单场景) ────────────────────────────────
  // body: { items: [{productId, quantity}] }  — 单价用 catalog 当前价, 不允许临时改价
  app.post('/:id/add-items', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    const { id } = req.params as any
    const { items: addItems } = (req.body || {}) as any
    if (!isSupplierRole(role) && !['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '仅供应商 / 管理员可代加' })
    }
    if (!Array.isArray(addItems) || addItems.length === 0) {
      return reply.status(400).send({ error: '至少加一项' })
    }
    const where: any = { id, tenantId, status: 'CONFIRMED' }
    if (isSupplierRole(role) && req.user.supplierId) where.supplierId = req.user.supplierId
    const order = await prisma.purchaseOrder.findFirst({ where })
    if (!order) return reply.status(400).send({ error: '订单不存在 / 已发货 / 状态不允许追加' })

    // 查 SKU + 校验都属于本订单的 supplierId
    const productIds = addItems.map((i: any) => i.productId)
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, tenantId, supplierId: order.supplierId },
      select: { id: true, name: true, price: true, unit: true, status: true },
    })
    const pMap = new Map(products.map(p => [p.id, p]))
    for (const i of addItems) {
      const p = pMap.get(i.productId)
      if (!p) return reply.status(400).send({ error: `商品 ${i.productId} 不属于本供应商` })
      if (p.status !== 'ENABLED') return reply.status(400).send({ error: `${p.name} 已停售, 不能追加` })
      if (!Number.isFinite(Number(i.quantity)) || Number(i.quantity) <= 0) {
        return reply.status(400).send({ error: `${p.name} 数量非法` })
      }
    }
    // 不允许重复追加 (防止同一 SKU 多行)
    const existingProdIds = new Set((await prisma.purchaseOrderItem.findMany({
      where: { purchaseOrderId: id }, select: { productId: true }
    })).map(x => x.productId))
    const dup = addItems.find((i: any) => existingProdIds.has(i.productId))
    if (dup) {
      const p = pMap.get(dup.productId)!
      return reply.status(400).send({ error: `${p.name} 已在订单里, 请改原行数量, 不要重复追加` })
    }

    // 事务: 插入新行 + 更新 totalAmount
    const addedDelta = addItems.reduce((s: number, i: any) => {
      const p = pMap.get(i.productId)!
      return s + Number(i.quantity) * Number(p.price)
    }, 0)
    const newTotal = Number(order.totalAmount) + addedDelta

    await prisma.$transaction(async (tx) => {
      for (const i of addItems) {
        const p = pMap.get(i.productId)!
        await tx.purchaseOrderItem.create({
          data: {
            purchaseOrderId: id,
            productId: i.productId,
            quantity: Number(i.quantity),
            unitPrice: Number(p.price),
            amount: Number(i.quantity) * Number(p.price),
          },
        })
      }
      await tx.purchaseOrder.update({ where: { id }, data: { totalAmount: newTotal } })
    })

    // opLog
    const namesQty = addItems.map((i: any) => {
      const p = pMap.get(i.productId)!
      return `${p.name} ×${i.quantity}${p.unit}`
    }).join(', ')
    await prisma.opLog.create({
      data: {
        tenantId, userId,
        action: `[代加] 追加 ${addItems.length} 项: ${namesQty}, 总额 +¥${addedDelta.toFixed(2)} (现 ¥${newTotal.toFixed(2)})`,
        target: order.no, entityType: 'PurchaseOrder', targetId: id,
      },
    })

    // 通知厨师长 + 店长
    const supplier = await prisma.supplier.findUnique({ where: { id: order.supplierId }, select: { name: true } })
    const body = `${supplier?.name || ''} 代加 ${addItems.length} 项: ${namesQty.slice(0, 50)}${namesQty.length > 50 ? '…' : ''} · 总额 +¥${addedDelta.toFixed(2)} (现 ¥${newTotal.toFixed(2)})`
    for (const r of ['MANAGER', 'KITCHEN_LEAD']) {
      void sendNotification({
        tenantId, recipientRole: r as any,
        type: 'ORDER_ITEMS_ADDED' as any,
        title: `订单 ${order.no} 追加物品`,
        body,
        refType: 'PurchaseOrder', refId: id,
      })
    }
    return { success: true, addedCount: addItems.length, addedDelta, newTotal }
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
    // body 可选传 items: [{ itemId, shippedQty }] — 称重 / 缺货时供应商按实际发货量调整
    const { note, items: shippedItems } = req.body as any

    if (!isSupplierRole(role) && !['ADMIN', 'SUPER_ADMIN'].includes(role)) throw { statusCode: 403, message: '无权限' }

    const order = await prisma.purchaseOrder.findFirst({
      where: { id, tenantId, status: { in: ['SUBMITTED', 'CONFIRMED'] } },
      include: { items: { include: { product: { select: { name: true, unit: true } } } } },
    })
    if (!order) throw { statusCode: 400, message: '订单不存在或状态不可发货' }

    // 校验 + 构建 itemId → shippedQty 映射 (没传的按 quantity 全发)
    const shippedMap = new Map<string, number>()
    if (Array.isArray(shippedItems)) {
      for (const s of shippedItems) {
        const orig = order.items.find(o => o.id === s.itemId)
        if (!orig) throw { statusCode: 400, message: `行 ${s.itemId} 不属于本订单` }
        const sq = Number(s.shippedQty)
        if (!Number.isFinite(sq) || sq < 0) throw { statusCode: 400, message: `${orig.product?.name || s.itemId} 数量非法` }
        // 允许实发超过下单 ≤ 10% (称重浮动 + 库存余量场景), 超 10% 拒绝避免强卖
        const ordered = Number(orig.quantity)
        if (sq > ordered * 1.1 + 0.0001) {
          throw { statusCode: 400, message: `${orig.product?.name || s.itemId} 实发 ${sq} 超过下单 ${ordered} 的 110%, 上限 ${(ordered*1.1).toFixed(2)}, 请联系下单人补单` }
        }
        shippedMap.set(s.itemId, sq)
      }
    }
    // 计算每行实发 (默认 = quantity)
    const lineShipped = order.items.map(it => ({
      it, shipped: shippedMap.has(it.id) ? shippedMap.get(it.id)! : Number(it.quantity)
    }))
    const newTotal = lineShipped.reduce((s, l) => s + l.shipped * Number(l.it.unitPrice), 0)
    const oldTotal = Number(order.totalAmount)
    const changedLines = lineShipped.filter(l => Math.abs(l.shipped - Number(l.it.quantity)) > 0.0001)

    // 注:发货后只是 DELIVERING (在途), 不启动倒计时. 待供应商点「送达」改 PENDING_CONFIRM 才计时

    // 事务: 更新 PO 状态 + 行 shippedQty + 总金额 + 自动扣减供应商库存
    await prisma.$transaction(async (tx) => {
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          // 发货 → DELIVERING (在途, 不启动收货倒计时). 倒计时从 deliveredAt 开始
          status: 'DELIVERING' as any, shippedAt: new Date(), shippedNote: note, shippedById: userId,
          totalAmount: newTotal,
        },
      })
      // 写入每行 shippedQty + 重算行 amount (不动 unitPrice)
      for (const l of lineShipped) {
        await tx.purchaseOrderItem.update({
          where: { id: l.it.id },
          data: { shippedQty: l.shipped, amount: l.shipped * Number(l.it.unitPrice) },
        })
      }
      // 仅供应商角色发货时, 同步扣减自家库存. 按 shippedQty 扣 (称重/缺货后真实出库量).
      if (isSupplierRole(role)) {
        for (const l of lineShipped) {
          const it = l.it
          if (l.shipped <= 0) continue   // 该行没发, 不扣库存
          const cur = await tx.product.findUnique({ where: { id: it.productId }, select: { stock: true, supplierId: true } })
          if (!cur || cur.supplierId !== order.supplierId) continue   // 商品不属于本供应商, 跳过
          const qty = l.shipped
          const newStock = Number(cur.stock) - qty   // 允许负库存
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

    // opLog — 调整数量时详细记录
    const adjustNote = changedLines.length > 0
      ? '调整: ' + changedLines.map(l => `${l.it.product?.name || l.it.id} ${l.it.quantity}→${l.shipped}`).join(', ')
      : ''
    await prisma.opLog.create({
      data: {
        tenantId, userId, isAi: false,
        action: `供应商确认发货${adjustNote ? ' (' + adjustNote + ')' : ''}, 金额 ¥${newTotal.toFixed(2)}${Math.abs(newTotal - oldTotal) > 0.01 ? ` (原 ¥${oldTotal.toFixed(2)})` : ''}`,
        target: order.no, entityType: 'PurchaseOrder', targetId: id,
        metadata: { oldTotal, newTotal, changedLines: changedLines.map(l => ({ name: l.it.product?.name, ordered: Number(l.it.quantity), shipped: l.shipped })) },
      },
    })

    // 通知 — 调整时高亮告知店长 / 厨师长
    const supplier = await prisma.supplier.findUnique({ where: { id: order.supplierId }, select: { name: true } })
    const adjustSummary = changedLines.length > 0
      ? `, 因 ${changedLines.slice(0, 2).map(l => `${l.it.product?.name || ''}${Number(l.it.quantity)}→${l.shipped}`).join(' / ')}${changedLines.length > 2 ? ` 等 ${changedLines.length} 项` : ''} 调整, 现 ¥${newTotal.toFixed(2)} (原 ¥${oldTotal.toFixed(2)})`
      : ''
    void notifyOrderShipped(tenantId, order.no, (supplier?.name || '') + adjustSummary, order.storeId)
    return { success: true, newTotal, oldTotal, changedLines: changedLines.length }
  })

  // ── 供应商/司机点「已送达」 ─ DELIVERING → PENDING_CONFIRM, 启动 24h 自动收货 ──
  app.patch('/:id/deliver', { preHandler: [(app as any).authenticate] }, async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    const { id } = req.params as any
    const { note } = (req.body || {}) as any
    if (!isSupplierRole(role) && !['ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return reply.status(403).send({ error: '仅供应商 / 管理员可标记送达' })
    }
    const where: any = { id, tenantId, status: 'DELIVERING' }
    if (isSupplierRole(role) && req.user.supplierId) where.supplierId = req.user.supplierId
    const order = await prisma.purchaseOrder.findFirst({ where })
    if (!order) return reply.status(400).send({ error: '订单不存在 / 状态不可送达' })
    const upd = await prisma.purchaseOrder.updateMany({
      where: { id, status: 'DELIVERING' },
      data: { status: 'PENDING_CONFIRM', deliveredAt: new Date(), deliveredNote: note, deliveredById: userId },
    })
    if (upd.count === 0) return reply.status(400).send({ error: '订单状态已变 (并发)' })
    const autoConfirmAt = dayjs().add(24, 'hour').toDate()
    await prisma.opLog.create({
      data: {
        tenantId, userId,
        action: `供应商标记送达${note ? ': ' + String(note).slice(0,80) : ''}, 24h 内门店未确认将自动收货`,
        target: order.no, entityType: 'PurchaseOrder', targetId: id,
        metadata: { autoConfirmAt },
      },
    })
    const supplier = await prisma.supplier.findUnique({ where: { id: order.supplierId }, select: { name: true } })
    void sendNotification({
      tenantId, recipientRole: 'MANAGER' as any,
      type: 'ORDER_DELIVERED' as any,
      title: `订单已送达, 请尽快验收 ${order.no}`,
      body: `${supplier?.name || ''} 已送达, 请 24h 内确认收货, 否则系统将自动确认`,
      refType: 'PurchaseOrder', refId: id,
    })
    return { success: true, autoConfirmAt }
  })

  // ── 门店确认收货（完全一致）──────────────────────
  app.patch('/:id/receive', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const { tenantId, userId, role, storeId } = req.user
    const { id } = req.params as any
    const { items: receivedItems, evidenceImages } = req.body as any  // [{ productId, receivedQty }] + 可选证据图

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
    // receivedQty 缺省时按 shippedQty (供应商实际发货) → 没 shippedQty 才回退 quantity
    const actualReceivedTotal = updatedItems.reduce((s, i) => {
      const q = i.receivedQty != null ? Number(i.receivedQty)
              : i.shippedQty != null ? Number(i.shippedQty)
              : Number(i.quantity)
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
          create: updatedItems.map(i => {
            // receivedQty 优先, 否则按 shippedQty, 否则下单 quantity
            const q = i.receivedQty ?? i.shippedQty ?? i.quantity
            return {
              productId: i.productId,
              quantity: q,
              unitPrice: i.unitPrice,
              amount: Number(i.unitPrice) * Number(q),
            }
          }),
        },
      },
    })

    // 判断是否存在报损 — 应到 = shippedQty (ship 时议定的量), 实收 < 应到 才算报损
    // 供应商在 ship 时调减不算报损 (金额已按实发算清, 没有未付的钱)
    const lossLines = (receivedItems || [])
      .map((ri: any) => {
        const original = order.items.find(i => i.productId === ri.productId)
        if (!original) return null
        const expected = original.shippedQty != null ? Number(original.shippedQty) : Number(original.quantity)
        const lossQty = expected - Number(ri.receivedQty)
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

    // 强制: 有报损时必须上传至少 1 张证据图 (双保险, UI 也禁了按钮)
    if (hasLoss && (!Array.isArray(evidenceImages) || evidenceImages.length === 0)) {
      throw { statusCode: 400, message: '存在报损时必须上传至少 1 张现场照片作为证据' }
    }

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
          evidenceImages: Array.isArray(evidenceImages) ? evidenceImages.slice(0, 9) : [],
          status: 'PENDING' as any,
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

  // (旧的宽松 /cancel 已删除, 取代为顶部带角色校验 + SUBMITTED 限制的版本)
}
