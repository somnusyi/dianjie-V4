/**
 * 周期性凭证模板运行
 *
 * 每天 04:00 由 scheduler 触发 runDueTemplates(tenantId)
 * 找当月该执行的模板(到达 dayOfMonth 且本月未跑过),自动建草稿凭证
 *
 * 模板分录 entriesJson 示例:
 * [
 *   { "accountCode": "560117", "accountName": "门店租金", "debit": 8000 },
 *   { "accountCode": "2241",   "accountName": "其他应付款", "credit": 8000 }
 * ]
 */
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { createVoucher } from './index'

export async function runDueTemplates(tenantId: string, now: Date = new Date()): Promise<{ run: number; skipped: number }> {
  const ym = dayjs(now).format('YYYY-MM')
  const day = dayjs(now).date()
  const monthStart = dayjs(now).startOf('month').toDate()

  const templates = await prisma.voucherTemplate.findMany({
    where: { tenantId, enabled: true },
  })
  let run = 0, skipped = 0
  for (const t of templates) {
    // 还没到执行日
    if (day < t.dayOfMonth) { skipped++; continue }
    // 本月已经跑过
    if (t.lastRunAt && dayjs(t.lastRunAt).isAfter(monthStart)) { skipped++; continue }
    const entries = Array.isArray(t.entriesJson) ? (t.entriesJson as any[]) : []
    if (entries.length === 0) { skipped++; continue }
    // 渲染摘要 (支持 {YYYY-MM} 占位)
    const summary = t.summary.replace('{YYYY-MM}', ym).replace('{YYYYMM}', ym.replace('-', ''))
    // 执行日定为本月 dayOfMonth (而非当天, 便于跨月补跑)
    const date = dayjs(now).date(t.dayOfMonth).startOf('day').toDate()
    const vid = await createVoucher({
      tenantId,
      date,
      summary,
      sourceType: 'Template',
      sourceId: `${t.id}:${ym}`,    // 同模板同月唯一, 避免重复生成
      entries: entries.map((e: any) => ({
        accountCode: e.accountCode,
        accountName: e.accountName,
        debit: Number(e.debit || 0),
        credit: Number(e.credit || 0),
        summary: e.summary,
      })),
      createdById: t.createdById,
    })
    if (vid) {
      await prisma.voucherTemplate.update({
        where: { id: t.id },
        data: { lastRunAt: now, lastVoucherId: vid },
      })
      run++
    } else {
      skipped++
    }
  }
  return { run, skipped }
}

/** 给所有启用的 tenant 跑一遍 (cron 调用) */
export async function runAllTenants(): Promise<{ totalRun: number; tenants: number }> {
  const tenants = await prisma.tenant.findMany({
    where: { status: 'ACTIVE' as any },
    select: { id: true, slug: true },
  })
  let totalRun = 0
  for (const t of tenants) {
    try {
      const r = await runDueTemplates(t.id)
      totalRun += r.run
      if (r.run > 0) console.log(`[voucher-template] ${t.slug}: run ${r.run}`)
    } catch (e: any) {
      console.error(`[voucher-template] ${t.slug} 失败:`, e.message)
    }
  }
  return { totalRun, tenants: tenants.length }
}
