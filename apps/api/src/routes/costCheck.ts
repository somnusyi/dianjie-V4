/**
 * 财务月度成本核对工作台 (P1-1)
 *
 * 真实业务: 财务每月按 3 类数据源 核对各家门店成本
 *   1. 总仓货物 (何姐) → Supplier.sourceType=HEADQ_WAREHOUSE
 *   2. 美菜/快驴 B2B → Supplier.sourceType=B2B_PLATFORM
 *   3. 散户供应商 (微信群) → Supplier.sourceType=SCATTERED
 *
 *   每条 receipt 需 4 方核对:
 *     - 门店店长 (createdBy, 入库即建立)
 *     - 厨师长 (confirmedAt, status=RECEIVED)
 *     - 供应商 (supplierVerifiedAt, 新加)
 *     - 财务 (financeVerifiedAt, 新加, 4 方齐了才可入账)
 *
 * GET /api/finance/cost-check?month=YYYY-MM&storeId=opt
 *   返按 sourceType 分 3 组的 receipts (含核对状态 + 进度统计)
 */
import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { monthRangeForDateCol } from '../lib/dateRange'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const FINANCE_ROLES = new Set(['FINANCE', 'ADMIN', 'SUPER_ADMIN', 'BOSS'])

export const costCheckRoutes: FastifyPluginAsync = async (app) => {
  app.get('/cost-check', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '无权访问月度成本核对' })

    const { month, storeId } = (req.query as any) || {}
    const ym = month || dayjs().format('YYYY-MM')
    const { start, end } = monthRangeForDateCol(ym)

    const where: any = {
      tenantId,
      deliveryDate: { gte: start, lte: end },
      status: { notIn: ['VOID', 'REJECTED'] as any },
    }
    if (storeId) where.storeId = storeId

    const receipts = await prisma.receipt.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true, contactName: true, sourceType: true, category: true } },
        store: { select: { id: true, name: true } },
        items: { select: { id: true, quantity: true, unitPrice: true, amount: true, product: { select: { name: true, unit: true } } } },
        paymentSchedule: { select: { status: true, paidAt: true } },
      },
      orderBy: { deliveryDate: 'desc' },
    })

    // 标 4 方核对状态
    const enriched = receipts.map(r => {
      const v = {
        store: { done: true, at: r.createdAt },                                              // 门店店长建单 = createdAt
        chef: { done: !!r.confirmedAt, at: r.confirmedAt },                                  // 厨师长 confirm
        supplier: { done: !!r.supplierVerifiedAt, at: r.supplierVerifiedAt },
        finance: { done: !!r.financeVerifiedAt, at: r.financeVerifiedAt },
      }
      const allDone = v.store.done && v.chef.done && v.supplier.done && v.finance.done
      const doneCount = [v.store, v.chef, v.supplier, v.finance].filter(x => x.done).length
      return { ...r, verifications: v, allVerified: allDone, doneCount }
    })

    // 按 sourceType 分组
    const groups = {
      HEADQ_WAREHOUSE: enriched.filter(r => r.supplier?.sourceType === 'HEADQ_WAREHOUSE'),
      B2B_PLATFORM:    enriched.filter(r => r.supplier?.sourceType === 'B2B_PLATFORM'),
      SCATTERED:       enriched.filter(r => r.supplier?.sourceType === 'SCATTERED'),
      UNCATEGORIZED:   enriched.filter(r => !r.supplier?.sourceType),
    }

    const summarize = (arr: typeof enriched) => ({
      count: arr.length,
      totalAmount: arr.reduce((s, r) => s + Number(r.totalAmount), 0),
      allVerifiedCount: arr.filter(r => r.allVerified).length,
      pendingChefCount: arr.filter(r => !r.verifications.chef.done).length,
      pendingSupplierCount: arr.filter(r => r.verifications.chef.done && !r.verifications.supplier.done).length,
      pendingFinanceCount: arr.filter(r => r.verifications.chef.done && r.verifications.supplier.done && !r.verifications.finance.done).length,
    })

    return {
      month: ym,
      groups: {
        HEADQ_WAREHOUSE: { label: '总仓 (何姐)', items: groups.HEADQ_WAREHOUSE, summary: summarize(groups.HEADQ_WAREHOUSE) },
        B2B_PLATFORM:    { label: 'B2B 平台 (美菜/快驴)', items: groups.B2B_PLATFORM, summary: summarize(groups.B2B_PLATFORM) },
        SCATTERED:       { label: '散户 (微信群)', items: groups.SCATTERED, summary: summarize(groups.SCATTERED) },
        UNCATEGORIZED:   { label: '未分类 (财务请给供应商打标)', items: groups.UNCATEGORIZED, summary: summarize(groups.UNCATEGORIZED) },
      },
      total: summarize(enriched),
    }
  })

  // PATCH /api/finance/cost-check/suppliers/:id/source-type body: { sourceType }
  // 财务给供应商打标
  app.patch('/cost-check/suppliers/:id/source-type', auth(app), async (req: any, reply: any) => {
    const { tenantId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '无权' })
    const { sourceType } = (req.body || {}) as { sourceType: string | null }
    if (sourceType != null && !['HEADQ_WAREHOUSE', 'B2B_PLATFORM', 'SCATTERED'].includes(sourceType)) {
      return reply.status(400).send({ error: 'sourceType 必须是 HEADQ_WAREHOUSE/B2B_PLATFORM/SCATTERED 或 null' })
    }
    const s = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId } })
    if (!s) return reply.status(404).send({ error: '供应商不存在' })
    const updated = await prisma.supplier.update({
      where: { id: s.id },
      data: { sourceType: sourceType as any },
      select: { id: true, name: true, sourceType: true },
    })
    return updated
  })
}
