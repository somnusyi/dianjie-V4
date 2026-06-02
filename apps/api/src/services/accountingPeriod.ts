/**
 * 月结锁账服务
 *
 * 业务约束:
 *   - 财务月末关账 (close): 当月凭证不可手工新增 / 反审 / 作废
 *   - 关账后, 业务自动事件 (招行付款 / 入库 / 内部转账 等) 触发的凭证
 *     date 自动顺延至下一个 OPEN 月份的 1 号 (即"做调整凭证")
 *   - 财务长可 reopen (留痕审计)
 *
 * 使用:
 *   - shiftDateIfLocked(tenantId, originalDate, isAuto): 自动场景, 返回应该写入的 date
 *   - assertOpen(tenantId, date): 手工场景, 锁了就抛错
 */
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'

/** YYYY-MM 月份字串 */
function monthOf(d: Date | string): string {
  return dayjs(d).format('YYYY-MM')
}

export async function isPeriodLocked(tenantId: string, date: Date | string): Promise<boolean> {
  const month = monthOf(date)
  const period = await prisma.accountingPeriod.findUnique({
    where: { tenantId_month: { tenantId, month } },
    select: { status: true },
  })
  return period?.status === 'CLOSED'
}

/** 手工场景: 锁了直接抛错 */
export async function assertPeriodOpen(tenantId: string, date: Date | string): Promise<void> {
  if (await isPeriodLocked(tenantId, date)) {
    throw new Error(`${monthOf(date)} 已关账, 该月凭证不可改/新增. 请联系财务重开 (reopen) 或将业务挂下月.`)
  }
}

/**
 * 自动场景: 如果当月已关账, 把日期顺延到下一个 OPEN 月份的 1 号
 * (常见做法: 关账后业务自动事件挂下月做调整凭证)
 */
export async function shiftDateIfLocked(tenantId: string, original: Date | string): Promise<Date> {
  let d = dayjs(original)
  let attempts = 0
  while (attempts++ < 12) {  // 最多顺延 12 个月, 避免死循环
    const month = d.format('YYYY-MM')
    const period = await prisma.accountingPeriod.findUnique({
      where: { tenantId_month: { tenantId, month } },
      select: { status: true },
    })
    if (period?.status !== 'CLOSED') return d.toDate()
    // 顺延到下月 1 号
    d = d.add(1, 'month').startOf('month')
  }
  // 兜底: 全锁的离谱情况, 用原日期 (后续会抛错)
  return dayjs(original).toDate()
}

/** 获取某月期间 (含状态), 不存在自动创建 OPEN */
export async function getOrCreatePeriod(tenantId: string, month: string) {
  let p = await prisma.accountingPeriod.findUnique({
    where: { tenantId_month: { tenantId, month } },
  })
  if (!p) {
    p = await prisma.accountingPeriod.create({
      data: { tenantId, month, status: 'OPEN' },
    })
  }
  return p
}

/** 关账 (CLOSED). 期末结转 carryover 由 voucher service 处理后通过 closePeriod 调用. */
export async function closePeriod(opts: {
  tenantId: string
  month: string                   // YYYY-MM
  closedById: string
  closeNote?: string
  carryoverVoucherId?: string
}) {
  const { tenantId, month, closedById, closeNote = null, carryoverVoucherId = null } = opts
  const period = await getOrCreatePeriod(tenantId, month)
  if (period.status === 'CLOSED') {
    throw new Error(`${month} 已关账, 请先 reopen`)
  }
  return prisma.accountingPeriod.update({
    where: { id: period.id },
    data: {
      status: 'CLOSED',
      closedAt: new Date(),
      closedById,
      closeNote,
      carryoverVoucherId,
    },
  })
}

/** 重开 (审计留痕) */
export async function reopenPeriod(opts: {
  tenantId: string
  month: string
  reopenedById: string
  reopenNote: string  // 必填, 留痕
}) {
  const { tenantId, month, reopenedById, reopenNote } = opts
  if (!reopenNote?.trim()) throw new Error('reopen 必须填原因 (审计留痕)')
  const period = await getOrCreatePeriod(tenantId, month)
  if (period.status !== 'CLOSED') throw new Error(`${month} 当前非 CLOSED 状态, 无需 reopen`)
  return prisma.accountingPeriod.update({
    where: { id: period.id },
    data: {
      status: 'REOPENED',
      reopenedAt: new Date(),
      reopenedById,
      reopenNote,
    },
  })
}
