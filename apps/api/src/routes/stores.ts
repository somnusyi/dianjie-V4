import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { z } from 'zod'
import { cached, invalidatePattern } from '../lib/cache'
import { isStoreScoped } from '../lib/auth-scope'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

export const storeRoutes: FastifyPluginAsync = async (app) => {

  // ── 门店列表（含运营概览数据）────────────────────
  app.get('/', auth(app), async (req: any) => {
    const { tenantId, role, storeId, userId } = req.user
    const cacheKey = `stores:list:${tenantId}:${role}:${storeId || 'all'}:${role === 'ENGINEERING' ? userId : 'x'}`
    return cached(cacheKey, 300, async () => {
    const monthStart = dayjs().startOf('month').toDate()

    // 店长只能看自己门店
    const where: any = { tenantId }
    if (isStoreScoped(role)) where.id = storeId
    // 工程部只看自己负责的筹建店
    if (role === 'ENGINEERING') where.engineerId = userId

    const stores = await prisma.store.findMany({
      where,
      include: { users: { select: { id: true, name: true, role: true } } },
      orderBy: { no: 'asc' },
    })

    // 批量获取每个门店的运营数据
    const storeIds = stores.map(s => s.id)

    const [monthPurchases, overdueSchedules, pendingReceipts, lossStats] = await Promise.all([
      // 本月采购金额
      prisma.receipt.groupBy({
        by: ['storeId'],
        where: { tenantId, storeId: { in: storeIds }, status: { notIn: ['VOID','REJECTED'] }, createdAt: { gte: monthStart } },
        _sum: { totalAmount: true },
        _count: { id: true },
      }),
      // 逾期账期（按门店聚合）
      prisma.paymentSchedule.findMany({
        where: { tenantId, status: 'OVERDUE', receipt: { storeId: { in: storeIds } } },
        select: { receipt: { select: { storeId: true } } },
      }),
      // 待收货
      prisma.receipt.groupBy({
        by: ['storeId'],
        where: { tenantId, storeId: { in: storeIds }, status: 'PENDING_CONFIRM' },
        _count: { id: true },
      }),
      // 本月报损
      prisma.lossClaim.groupBy({
        by: ['storeId'],
        where: { tenantId, storeId: { in: storeIds }, createdAt: { gte: monthStart } },
        _sum: { totalLossAmount: true },
        _count: { id: true },
      }),
    ])

    // 整理逾期数据按门店
    const overdueByStore: Record<string, number> = {}
    if (Array.isArray(overdueSchedules)) {
      overdueSchedules.forEach((s: any) => {
        const sid = s.receipt?.storeId
        if (sid) overdueByStore[sid] = (overdueByStore[sid] || 0) + 1
      })
    }

    return stores.map(store => {
      const purchase = monthPurchases.find(p => p.storeId === store.id)
      const pending = pendingReceipts.find(p => p.storeId === store.id)
      const loss = lossStats.find(l => l.storeId === store.id)
      const overdueCount = overdueByStore[store.id] || 0

      // 报损率 = 报损金额 / 采购金额
      const purchaseAmt = Number(purchase?._sum?.totalAmount || 0)
      const lossAmt = Number(loss?._sum?.totalLossAmount || 0)
      const lossRate = purchaseAmt > 0 ? (lossAmt / purchaseAmt * 100).toFixed(1) : '0'

      // 健康状态
      let health: 'good' | 'warning' | 'danger' = 'good'
      if (overdueCount > 0) health = 'danger'
      else if (Number(lossRate) > 10 || (pending?._count?.id || 0) > 2) health = 'warning'

      return {
        ...store,
        stats: {
          monthPurchase: purchaseAmt,
          purchaseCount: purchase?._count?.id || 0,
          pendingReceiptCount: pending?._count?.id || 0,
          overdueCount,
          lossAmount: lossAmt,
          lossCount: loss?._count?.id || 0,
          lossRate,
          health,
        },
      }
    })
    }) // end cached
  })

  // ── 单门店详情（运营档案）────────────────────────
  app.get('/:id', auth(app), async (req: any) => {
    const { tenantId, role, storeId: userStoreId } = req.user
    const { id } = req.params as any

    // 店长只能看自己
    if (isStoreScoped(role) && id !== userStoreId) throw { statusCode: 403, message: '无权限' }

    const monthStart = dayjs().startOf('month').toDate()
    const last3Months = dayjs().subtract(3, 'month').startOf('month').toDate()

    const [store, receipts, schedules, lossClaims, purchaseTrend] = await Promise.all([
      prisma.store.findFirst({
        where: { id, tenantId },
        include: { users: { select: { id: true, name: true, role: true, email: true } } },
      }),
      // 最近入库记录
      prisma.receipt.findMany({
        where: { tenantId, storeId: id },
        include: { supplier: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      // 账期
      prisma.paymentSchedule.findMany({
        where: { tenantId, receipt: { storeId: id }, status: { notIn: ['PAID','CANCELLED'] } },
        include: { supplier: { select: { name: true } }, receipt: { select: { no: true } } },
        orderBy: { dueAt: 'asc' },
        take: 10,
      }),
      // 报损记录
      prisma.lossClaim.findMany({
        where: { tenantId, storeId: id },
        include: { supplier: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 8,
      }),
      // 近3月每月采购趋势
      prisma.receipt.groupBy({
        by: ['createdAt'],
        where: { tenantId, storeId: id, status: { notIn: ['VOID','REJECTED'] }, createdAt: { gte: last3Months } },
        _sum: { totalAmount: true },
      }),
    ])

    if (!store) throw { statusCode: 404, message: '门店不存在' }

    // 本月统计
    const monthReceipts = receipts.filter(r => new Date(r.createdAt) >= monthStart)
    const monthPurchase = monthReceipts.reduce((s, r) => s + Number(r.totalAmount), 0)
    const overdueCount = schedules.filter(s => s.status === 'OVERDUE').length
    const pendingCount = receipts.filter(r => r.status === 'PENDING_CONFIRM').length
    const monthLoss = lossClaims.filter(l => new Date(l.createdAt) >= monthStart).reduce((s, l) => s + Number(l.totalLossAmount), 0)

    // 按月聚合采购趋势
    const trendByMonth: Record<string, number> = {}
    purchaseTrend.forEach((r: any) => {
      const m = dayjs(r.createdAt).format('MM月')
      trendByMonth[m] = (trendByMonth[m] || 0) + Number(r._sum?.totalAmount || 0)
    })

    return {
      store,
      stats: { monthPurchase, overdueCount, pendingCount, monthLoss },
      receipts,
      schedules,
      lossClaims,
      purchaseTrend: Object.entries(trendByMonth).map(([month, amount]) => ({ month, amount })),
    }
  })

  // ── 创建/更新门店（管理员）───────────────────────
  app.post('/', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    // ADMIN / SUPER_ADMIN 可以建任意状态; ENGINEERING 只能建筹建店 (默认 PLANNING)
    if (!['ADMIN','SUPER_ADMIN','ENGINEERING'].includes(role)) throw { statusCode: 403, message: '无权限' }
    const body = z.object({
      no: z.string().min(1, '门店编号不能为空'),
      name: z.string().min(1, '门店名称不能为空'),
      address: z.string().optional(),
      phone: z.string().optional(),
      managerName: z.string().optional(),
      // 开票信息
      bankAccountName: z.string().trim().max(80).optional(),
      invoiceTaxId:    z.string().trim().max(40).optional(),
      bankName:        z.string().trim().max(60).optional(),
      bankAccountNo:   z.string().trim().regex(/^[\d\s-]*$/, '银行账号只能是数字').max(40).optional(),
      // 工程部筹建
      lifecyclePhase: z.enum(['PLANNING','NEGOTIATING','CONSTRUCTION','EQUIPMENT','LICENSING','TRIAL','OPERATING','CLOSED']).optional(),
      engineerId:     z.string().optional(),
      expectedOpenAt: z.string().datetime({ offset: true }).optional(),
    }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0].message })
    const { no, name, address, phone, managerName, bankName, bankAccountName, bankAccountNo, invoiceTaxId, engineerId, expectedOpenAt } = body.data

    // 工程部只能建筹建店, 默认 PLANNING; 老板可以建任意状态默认 OPERATING
    let lifecyclePhase = body.data.lifecyclePhase
    if (role === 'ENGINEERING') {
      if (lifecyclePhase === 'OPERATING' || lifecyclePhase === 'CLOSED') {
        return reply.status(403).send({ error: '工程部不能直接建运营中或已关店, 切换需老板审批' })
      }
      lifecyclePhase = lifecyclePhase || 'PLANNING'
    } else {
      lifecyclePhase = lifecyclePhase || 'OPERATING'
    }

    let store
    try {
      store = await prisma.store.create({
        data: {
          tenantId, no, name, address, phone, managerName, status: 'ENABLED',
          bankAccountName: bankAccountName || null,
          invoiceTaxId: invoiceTaxId || null,
          bankName: bankName || null,
          bankAccountNo: bankAccountNo ? bankAccountNo.replace(/[\s-]/g, '') : null,
          lifecyclePhase: lifecyclePhase as any,
          engineerId: engineerId || (role === 'ENGINEERING' ? userId : null),
          expectedOpenAt: expectedOpenAt ? new Date(expectedOpenAt) : null,
        } as any,
      })
    } catch (e: any) {
      if (e.code === 'P2002') return reply.status(409).send({ error: `门店编号 ${no} 已被占用, 换一个 (例如 DJ${String(Date.now()).slice(-3)})` })
      throw e
    }
    await prisma.opLog.create({ data: { tenantId, userId, action: `创建门店 ${name}`, entityType: 'Store', targetId: store.id } })
    void invalidatePattern(`stores:list:${tenantId}:*`)
    return store
  })

  // 给前端用: 建议下一个可用 no (扫所有店, 不暴露 store 详情)
  app.get('/next-no', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!['ADMIN','SUPER_ADMIN','ENGINEERING'].includes(role)) return reply.status(403).send({ error: '无权限' })
    const list = await prisma.store.findMany({
      where: { tenantId },
      select: { no: true },
    })
    const nums = list
      .map(s => /^DJ(\d+)$/.exec(s.no || ''))
      .filter(Boolean)
      .map((m: any) => parseInt(m[1], 10))
    const next = (nums.length ? Math.max(...nums) : 0) + 1
    return { suggested: `DJ${String(next).padStart(3, '0')}` }
  })

  app.patch('/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    const isAdmin = ['ADMIN','SUPER_ADMIN'].includes(role)
    const isEngineer = role === 'ENGINEERING'
    if (!isAdmin && !isEngineer) throw { statusCode: 403, message: '无权限' }

    const existing: any = await prisma.store.findFirst({ where: { id: req.params.id, tenantId } })
    if (!existing) return reply.status(404).send({ error: '门店不存在' })
    // 工程部只能改自己负责的店, 且不能动 OPERATING/CLOSED
    if (isEngineer) {
      if (existing.engineerId !== userId) return reply.status(403).send({ error: '只能改自己负责的店' })
      if (existing.lifecyclePhase === 'OPERATING' || existing.lifecyclePhase === 'CLOSED') {
        return reply.status(403).send({ error: '已运营/已关店不能改, 联系老板' })
      }
    }
    const body = req.body as any
    const data: any = {}
    for (const k of ['name','address','phone','managerName']) if (body[k] !== undefined) data[k] = body[k]
    if (body.expectedOpenAt !== undefined) data.expectedOpenAt = body.expectedOpenAt ? new Date(body.expectedOpenAt) : null

    // status / lifecyclePhase / engineerId 改动权限
    if (body.status !== undefined && !isAdmin) {
      return reply.status(403).send({ error: '只有老板能改启用/禁用' })
    }
    if (body.status !== undefined) data.status = body.status

    if (body.lifecyclePhase !== undefined) {
      // 切到 OPERATING 或 CLOSED 必须老板批
      if ((body.lifecyclePhase === 'OPERATING' || body.lifecyclePhase === 'CLOSED') && !isAdmin) {
        return reply.status(403).send({ error: '上线 / 关店需老板审批' })
      }
      data.lifecyclePhase = body.lifecyclePhase
    }
    if (body.engineerId !== undefined && !isAdmin) {
      return reply.status(403).send({ error: '只有老板能换工程负责人' })
    }
    if (body.engineerId !== undefined) data.engineerId = body.engineerId || null

    const store = await prisma.store.update({ where: { id: req.params.id }, data })
    await prisma.opLog.create({ data: { tenantId, userId, action: `更新门店 ${store.name}`, entityType: 'Store', targetId: store.id } })
    void invalidatePattern(`stores:list:${tenantId}:*`)
    return store
  })

  // ── Sprint A · 门店收款配置 ────────────────────────────
  // GET   /api/stores/:id/payment-config
  // PATCH /api/stores/:id/payment-config
  // 字段含 mchid / 银行卡 / 平台店ID;敏感密钥仅写入不返回, 列表展示掩码末4位
  app.get('/:id/payment-config', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!['ADMIN','SUPER_ADMIN','FINANCE','MANAGER'].includes(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    const s = await prisma.store.findFirst({
      where: { id: req.params.id, tenantId },
      select: {
        id: true, name: true, no: true,
        meituanShopId: true, douyinShopId: true,
        paymentChannelType: true,
        aggregatorVendor: true, aggregatorMerchantId: true,
        aggregatorApiKeyEnc: true, aggregatorSecretEnc: true,
        wechatMerchantId: true, wechatApiV3KeyEnc: true,
        alipayAppId: true, alipayPrivateKeyEnc: true,
        bankAccountName: true, bankName: true, bankAccountNo: true,
        autoSyncRevenue: true,
      },
    })
    if (!s) return reply.status(404).send({ error: '门店不存在' })
    const masked = s.bankAccountNo ? `**** ${s.bankAccountNo.slice(-4)}` : null
    return {
      id: s.id, name: s.name, no: s.no,
      meituanShopId: s.meituanShopId, douyinShopId: s.douyinShopId,
      paymentChannelType: s.paymentChannelType || 'AGGREGATOR',
      aggregatorVendor: s.aggregatorVendor,
      aggregatorMerchantId: s.aggregatorMerchantId,
      aggregatorApiKeyConfigured: !!s.aggregatorApiKeyEnc,
      aggregatorSecretConfigured: !!s.aggregatorSecretEnc,
      wechatMerchantId: s.wechatMerchantId,
      wechatApiV3Configured: !!s.wechatApiV3KeyEnc,
      alipayAppId: s.alipayAppId,
      alipayPrivateConfigured: !!s.alipayPrivateKeyEnc,
      bankAccountName: s.bankAccountName,
      bankName: s.bankName,
      bankAccountNoMasked: masked,
      autoSyncRevenue: s.autoSyncRevenue,
    }
  })

  app.patch('/:id/payment-config', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    if (!['ADMIN','SUPER_ADMIN','FINANCE'].includes(role)) {
      return reply.status(403).send({ error: '无权限' })
    }
    const existing = await prisma.store.findFirst({ where: { id: req.params.id, tenantId } })
    if (!existing) return reply.status(404).send({ error: '门店不存在' })

    const {
      paymentChannelType,
      aggregatorVendor, aggregatorMerchantId, aggregatorApiKey, aggregatorSecret,
      wechatMerchantId, wechatApiV3Key,
      alipayAppId, alipayPrivateKey,
      meituanShopId, douyinShopId,
      bankAccountNo, bankAccountName, bankName,
      autoSyncRevenue,
    } = req.body as any

    // TODO Sprint B: 用 KMS / aes-256-gcm 加密后再写
    const data: any = {}
    if (paymentChannelType    !== undefined) data.paymentChannelType    = paymentChannelType || null
    if (aggregatorVendor      !== undefined) data.aggregatorVendor      = aggregatorVendor || null
    if (aggregatorMerchantId  !== undefined) data.aggregatorMerchantId  = aggregatorMerchantId || null
    if (wechatMerchantId      !== undefined) data.wechatMerchantId      = wechatMerchantId || null
    if (alipayAppId           !== undefined) data.alipayAppId           = alipayAppId || null
    if (meituanShopId         !== undefined) data.meituanShopId         = meituanShopId || null
    if (douyinShopId          !== undefined) data.douyinShopId          = douyinShopId || null
    if (bankAccountNo         !== undefined) data.bankAccountNo         = bankAccountNo || null
    if (bankAccountName       !== undefined) data.bankAccountName       = bankAccountName || null
    if (bankName              !== undefined) data.bankName              = bankName || null
    if (autoSyncRevenue       !== undefined) data.autoSyncRevenue       = !!autoSyncRevenue
    // 敏感字段:有值才更新, 空字符串视为不修改(避免误清)
    if (aggregatorApiKey)  data.aggregatorApiKeyEnc = aggregatorApiKey
    if (aggregatorSecret)  data.aggregatorSecretEnc = aggregatorSecret
    if (wechatApiV3Key)    data.wechatApiV3KeyEnc   = wechatApiV3Key
    if (alipayPrivateKey)  data.alipayPrivateKeyEnc = alipayPrivateKey

    await prisma.store.update({ where: { id: req.params.id }, data })
    await prisma.opLog.create({ data: { tenantId, userId, action: `更新门店收款配置 ${existing.name}`, entityType: 'Store', targetId: existing.id } })
    void invalidatePattern(`stores:list:${tenantId}:*`)
    return { success: true }
  })
}
