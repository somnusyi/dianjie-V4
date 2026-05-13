import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'
import { generateNo } from '../utils/no'
import { autoProcessAfterConfirm } from '../services/paymentSchedule'
import { invalidatePattern } from '../lib/cache'
import { notifyReceiptConfirmed } from '../services/notification'
import { isStoreScoped, isSupplierRole } from '../lib/auth-scope'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

export const receiptRoutes: FastifyPluginAsync = async (app) => {

  // ── 列表 ──────────────────────────────────────────
  app.get('/', auth(app), async (req: any) => {
    const { tenantId, role, storeId } = req.user
    const { status, supplierId, storeId: qStore, page = '1', pageSize = '20' } = req.query as any
    const where: any = { tenantId }
    if (status) where.status = status
    // 供应商: 强制按自家 supplierId 过滤
    if (isSupplierRole(role)) where.supplierId = req.user.supplierId || '__NONE__'
    else if (supplierId) where.supplierId = supplierId
    if (isStoreScoped(role)) where.storeId = storeId
    else if (qStore) where.storeId = qStore

    const p = Math.max(1, parseInt(page))
    const ps = Math.min(100, Math.max(1, parseInt(pageSize)))
    const skip = (p - 1) * ps

    const [items, total] = await Promise.all([
      prisma.receipt.findMany({
        where, orderBy: { createdAt: 'desc' },
        skip, take: ps,
        include: {
          store: { select: { id: true, name: true } },
          supplier: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
          items: { include: { product: { select: { id: true, name: true, unit: true } } } },
          paymentSchedule: { select: { id: true, status: true, dueAt: true, amount: true } },
        },
      }),
      prisma.receipt.count({ where }),
    ])
    return { items, total, page: p, pageSize: ps }
  })

  // ── 详情 ──────────────────────────────────────────
  app.get('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, storeId } = req.user
    const detailWhere: any = { id: req.params.id, tenantId }
    if (isSupplierRole(role)) detailWhere.supplierId = req.user.supplierId || '__NONE__'
    if (isStoreScoped(role)) detailWhere.storeId = storeId
    const receipt = await prisma.receipt.findFirst({
      where: detailWhere,
      include: {
        store: true, supplier: true,
        createdBy: { select: { id: true, name: true } },
        items: { include: { product: true } },
        paymentSchedule: true,
      },
    })
    if (!receipt) return reply.status(404).send({ error: '入库单不存在' })
    return receipt
  })

  // ── 补录入库单（非采购单流程，手动录入）────────────
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role, storeId: userStoreId } = req.user
    const body = z.object({
      storeId: z.string(),
      supplierId: z.string(),
      deliveryDate: z.string(),
      note: z.string().optional(),
      // 临时供应商收款信息（非系统供应商时填写）
      tempSupplierName: z.string().optional(),
      tempBankAccount: z.string().optional(),
      tempBankName: z.string().optional(),
      items: z.array(z.object({
        productId: z.string(),
        quantity: z.number().positive(),
        unitPrice: z.number().min(0),
      })).min(1),
    }).safeParse(req.body)

    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })
    const { storeId, supplierId, deliveryDate, note, items, tempSupplierName, tempBankAccount, tempBankName } = body.data

    if (role === 'MANAGER' && storeId !== userStoreId) return reply.status(403).send({ error: '只能为自己门店创建' })

    const totalAmount = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0)
    const no = await generateNo('RK', tenantId)

    const receipt = await prisma.receipt.create({
      data: {
        tenant: { connect: { id: tenantId } },
        no, deliveryDate: new Date(deliveryDate),
        totalAmount, note,
        status: 'DRAFT',
        isManual: true,
        tempSupplierName, tempBankAccount, tempBankName,
        store: { connect: { id: storeId } },
        supplier: { connect: { id: supplierId } },
        createdBy: { connect: { id: userId } },
        items: {
          create: items.map(i => ({
            product: { connect: { id: i.productId } },
            quantity: i.quantity, unitPrice: i.unitPrice,
            amount: i.quantity * i.unitPrice,
          })),
        },
      },
      include: { items: true },
    })

    await prisma.opLog.create({ data: { tenantId, userId, action: `补录入库单 ${no}`, target: no, entityType: 'Receipt', targetId: receipt.id } })
    void invalidatePattern(`dashboard:stats:${tenantId}:*`)
    void invalidatePattern(`stores:list:${tenantId}:*`)
    return reply.status(201).send(receipt)
  })

  // ── 供应商标记送达（自动生成入库单）────────────────
  // 由 orders 路由的 /ship 调用，这里提供给直接操作的场景
  app.patch('/:id/mark-delivered', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId } = req.user
    const receipt = await prisma.receipt.findFirst({ where: { id: req.params.id, tenantId, status: 'DRAFT' } })
    if (!receipt) return reply.status(400).send({ error: '入库单不存在或状态不对' })
    await prisma.receipt.update({ where: { id: receipt.id }, data: { status: 'PENDING_CONFIRM' } })
    return { success: true }
  })

  // ── 店长确认入库（完全正常）─────────────────────────
  app.patch('/:id/confirm', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId } = req.user
    const receipt = await prisma.receipt.findFirst({
      where: { id: req.params.id, tenantId, status: { in: ['DRAFT', 'PENDING', 'PENDING_CONFIRM'] } },
      include: { supplier: true },
    })
    if (!receipt) return reply.status(404).send({ error: '入库单不存在或状态不可确认' })

    const confirmedAt = new Date()
    await prisma.receipt.update({ where: { id: receipt.id }, data: { status: 'CONFIRMED', confirmedAt } })

    // 按全额生成账期
    await autoProcessAfterConfirm({ tenantId, receipt: { ...receipt, confirmedAt }, supplier: receipt.supplier })

    await prisma.opLog.create({ data: { tenantId, userId, action: `确认入库 ${receipt.no}，账期已创建`, target: receipt.no, entityType: 'Receipt', targetId: receipt.id } })
    void invalidatePattern(`dashboard:stats:${tenantId}:*`)
    void invalidatePattern(`stores:list:${tenantId}:*`)
    const store = await prisma.store.findUnique({ where: { id: receipt.storeId }, select: { name: true } })
    void notifyReceiptConfirmed(tenantId, receipt.no, store?.name || '', false, 0)
    return { message: '入库确认成功，账期已自动创建' }
  })

  // ── 店长报损入库（部分收货，按实收金额生成账期）──────
  app.patch('/:id/confirm-with-loss', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId } = req.user
    const body = z.object({
      description: z.string().min(1, '请填写报损说明'),
      evidenceImages: z.array(z.string()).min(1, '请上传证据图片'),
      items: z.array(z.object({
        productId: z.string(),
        receivedQty: z.number().min(0),  // 实际收到数量
      })),
    }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })

    const receipt = await prisma.receipt.findFirst({
      where: { id: req.params.id, tenantId, status: { in: ['PENDING', 'PENDING_CONFIRM'] } },
      include: { supplier: true, items: { include: { product: true } } },
    })
    if (!receipt) return reply.status(404).send({ error: '入库单不存在' })

    const { description, evidenceImages, items: receivedItems } = body.data

    // 计算实收金额
    let actualAmount = 0
    let totalLossAmount = 0
    const lossItemsData = []

    for (const ri of receivedItems) {
      const original = receipt.items.find(i => i.productId === ri.productId)
      if (!original) continue
      const actualQty = ri.receivedQty
      const lossQty = Number(original.quantity) - actualQty
      const itemAmount = actualQty * Number(original.unitPrice)
      actualAmount += itemAmount

      if (lossQty > 0) {
        lossItemsData.push({
          productId: ri.productId,
          orderedQty: Number(original.quantity),
          receivedQty: actualQty,
          lossQty,
          unitPrice: Number(original.unitPrice),
          lossAmount: lossQty * Number(original.unitPrice),
        })
        totalLossAmount += lossQty * Number(original.unitPrice)
      }

      // 更新入库明细实收数量
      await prisma.receiptItem.updateMany({
        where: { receiptId: receipt.id, productId: ri.productId },
        data: { quantity: actualQty, amount: itemAmount },
      })
    }

    const confirmedAt = new Date()

    // 更新入库单为实收金额
    await prisma.receipt.update({
      where: { id: receipt.id },
      data: { status: 'CONFIRMED', confirmedAt, totalAmount: actualAmount },
    })

    // 按实收金额生成账期（损耗部分不付）
    await autoProcessAfterConfirm({
      tenantId,
      receipt: { ...receipt, confirmedAt, totalAmount: actualAmount as any },
      supplier: receipt.supplier,
    })

    // 生成报损记录
    if (lossItemsData.length > 0) {
      const lcNo = await generateNo('LC', tenantId)
      await prisma.lossClaim.create({
        data: {
          tenantId,
          no: lcNo,
          purchaseOrderId: receipt.purchaseOrderId || '',
          storeId: receipt.storeId,
          supplierId: receipt.supplierId,
          totalLossAmount,
          description,
          evidenceImages,
          status: 'APPROVED',
          createdById: userId,
          items: { create: lossItemsData },
        },
      })
    }

    await prisma.opLog.create({
      data: {
        tenantId, userId,
        action: `报损入库 ${receipt.no}，实收 ¥${actualAmount}，损耗 ¥${totalLossAmount}`,
        target: receipt.no, entityType: 'Receipt', targetId: receipt.id,
      },
    })

    // 报损入库时报损直接APPROVED，检查采购订单是否可完结
    if (receipt.purchaseOrderId) {
      const pendingClaims = await prisma.lossClaim.count({
        where: { purchaseOrderId: receipt.purchaseOrderId, tenantId, status: { in: ['PENDING', 'NEGOTIATING'] } },
      })
      if (pendingClaims === 0) {
        await prisma.purchaseOrder.updateMany({
          where: { id: receipt.purchaseOrderId, tenantId, status: 'RECEIVED' },
          data: { status: 'COMPLETED' },
        })
      }
    }

    const store = await prisma.store.findUnique({ where: { id: receipt.storeId }, select: { name: true } })
    void notifyReceiptConfirmed(tenantId, receipt.no, store?.name || '', totalLossAmount > 0, totalLossAmount)
    return { message: `报损入库成功，账期按实收金额 ¥${actualAmount} 生成`, actualAmount, totalLossAmount }
  })

  // ── 拒收 ──────────────────────────────────────────
  app.patch('/:id/reject', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId } = req.user
    const { reason } = req.body as any
    if (!reason) return reply.status(400).send({ error: '请填写拒收原因' })

    const receipt = await prisma.receipt.findFirst({
      where: { id: req.params.id, tenantId, status: { in: ['PENDING', 'PENDING_CONFIRM'] } },
    })
    if (!receipt) return reply.status(404).send({ error: '入库单不存在或不可拒收' })

    await prisma.receipt.update({
      where: { id: receipt.id },
      data: { status: 'REJECTED', rejectReason: reason, rejectedAt: new Date() },
    })

    await prisma.opLog.create({
      data: { tenantId, userId, action: `拒收入库单 ${receipt.no}：${reason}`, target: receipt.no, entityType: 'Receipt', targetId: receipt.id },
    })

    return { message: '已拒收，请联系供应商协商处理' }
  })

  // ── 作废（草稿/补录单）───────────────────────────
  app.patch('/:id/void', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId } = req.user
    const receipt = await prisma.receipt.findFirst({ where: { id: req.params.id, tenantId } })
    if (!receipt) return reply.status(404).send({ error: '入库单不存在' })
    if (['ACCOUNTED', 'VOID', 'CONFIRMED'].includes(receipt.status)) {
      return reply.status(400).send({ error: '当前状态不可作废' })
    }

    await prisma.receipt.update({ where: { id: receipt.id }, data: { status: 'VOID' } })
    await prisma.paymentSchedule.updateMany({
      where: { receiptId: receipt.id, status: { in: ['PENDING', 'NOTIFIED'] } },
      data: { status: 'CANCELLED' },
    })

    await prisma.opLog.create({ data: { tenantId, userId, action: `作废入库单 ${receipt.no}`, target: receipt.no, entityType: 'Receipt', targetId: receipt.id } })
    return { message: '已作废' }
  })
}
