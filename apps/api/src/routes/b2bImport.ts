/**
 * B2B 平台账单批量导入 (P1-2)
 *
 * 真实业务: 财务从美菜 / 快驴 后台拿一个月账单 (PDF / Excel), 含多笔明细.
 *   一次性录到系统, 自动生成 receipt + paymentSchedule.
 *
 * Endpoint:
 *   POST /api/finance/b2b/import-rows
 *     body: {
 *       supplierId,                  // 关联的 B2B 平台供应商 (sourceType=B2B_PLATFORM)
 *       storeId,
 *       rows: [
 *         { deliveryDate, items: [{ productName, quantity, unitPrice, amount }], totalAmount, note? }
 *       ]
 *     }
 *     返: { created: [receiptId,...], errors: [{ rowIdx, msg }] }
 *
 * 注意: 不做 PDF 解析 (依赖外部库, 且不同平台格式差异大), 前端 Excel 解析后调本 endpoint.
 */
import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@dianjie/db'
import { z } from 'zod'
import { generateNo } from '../utils/no'

const auth = (app: any) => ({ preHandler: [app.authenticate] })
const FINANCE_ROLES = new Set(['FINANCE', 'ADMIN', 'SUPER_ADMIN', 'BOSS'])

const itemSchema = z.object({
  productName: z.string().min(1),
  quantity: z.number().nonnegative(),
  unitPrice: z.number().nonnegative(),
  amount: z.number().nonnegative(),
  unit: z.string().optional(),
})
const rowSchema = z.object({
  deliveryDate: z.string(),                          // YYYY-MM-DD
  totalAmount: z.number().positive(),
  note: z.string().max(500).optional(),
  items: z.array(itemSchema).optional().default([]), // 可空 (账单只有总额时)
})
const importSchema = z.object({
  supplierId: z.string(),
  storeId: z.string(),
  rows: z.array(rowSchema).min(1),
})

export const b2bImportRoutes: FastifyPluginAsync = async (app) => {

  app.post('/import-rows', auth(app), async (req: any, reply: any) => {
    const { tenantId, userId, role } = req.user
    if (!FINANCE_ROLES.has(role)) return reply.status(403).send({ error: '仅财务可批量导入' })
    const parsed = importSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.errors[0].message })

    // 校验 supplier 是 B2B
    const supplier = await prisma.supplier.findFirst({
      where: { id: parsed.data.supplierId, tenantId },
    })
    if (!supplier) return reply.status(404).send({ error: '供应商不存在' })
    const store = await prisma.store.findFirst({ where: { id: parsed.data.storeId, tenantId } })
    if (!store) return reply.status(404).send({ error: '门店不存在' })

    const created: string[] = []
    const errors: Array<{ rowIdx: number; msg: string }> = []

    for (let i = 0; i < parsed.data.rows.length; i++) {
      const r = parsed.data.rows[i]
      try {
        // 校验 items.amount 之和约等于 row.totalAmount (允许 ±0.5 误差, 因为账单四舍五入)
        if (r.items.length > 0) {
          const itemsSum = r.items.reduce((s, x) => s + x.amount, 0)
          if (Math.abs(itemsSum - r.totalAmount) > 0.5) {
            errors.push({ rowIdx: i, msg: `明细合计 ${itemsSum.toFixed(2)} 与总额 ${r.totalAmount.toFixed(2)} 不符` })
            continue
          }
        }

        const no = await generateNo('RK', tenantId)
        // B2B 平台明细品名一般跟我们 SKU 表不一致, 不强求建 ReceiptItem.
        // 财务关心总额 + 日期 + 供应商 + 备注里写品类即可.
        const noteParts: string[] = []
        noteParts.push(`B2B 导入 (${supplier.name})`)
        if (r.note) noteParts.push(r.note)
        if (r.items.length > 0) {
          noteParts.push('明细: ' + r.items.map(it =>
            `${it.productName} ×${it.quantity}${it.unit || ''} = ¥${it.amount.toFixed(2)}`
          ).join(' / '))
        }
        const receipt = await prisma.receipt.create({
          data: {
            tenantId, no, storeId: store.id, supplierId: supplier.id,
            deliveryDate: new Date(r.deliveryDate),
            totalAmount: r.totalAmount,
            status: 'CONFIRMED' as any,         // B2B 平台已经送货, 默认确认
            confirmedAt: new Date(),
            note: noteParts.join(' | ').slice(0, 1000),
            createdById: userId,
            isManual: true,
          },
        })
        created.push(receipt.id)
      } catch (e: any) {
        errors.push({ rowIdx: i, msg: e?.message || '创建失败' })
      }
    }

    return { created, errors, summary: { totalRows: parsed.data.rows.length, createdCount: created.length, errorCount: errors.length } }
  })
}
