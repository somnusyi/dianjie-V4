/**
 * CMB 流水自动同步到本地 cashbook
 *
 * 解决根本问题:
 *   老板/财务直接用招行 APP 转账, 客户回款, 其他不经过滇界的银行流水
 *   永远不进本地 cashbook → 账面对不上是结构性缺陷, 不修对账永远累积错差
 *
 * 策略:
 *   1. 定时 (每 30 分钟) 拉每个 cmbBindAccount 账户近 N 天的 CMB transactions
 *   2. 逐条决策:
 *      a) yurRef 跟现有 cash_transactions.refId 匹配 → Phase 1 sink 已经写过, 跳过
 *      b) refType='CmbAutoSync' + refId='cmb:account:date:sequence' 已存在 → 之前自动同步过, 跳过
 *      c) 都不匹配 → 新流水, 自动写 cashbook
 *         · category = '未分类入账' / '未分类出账' (财务事后归类到 营业收入 / 房租 / 等)
 *         · note 拼装对方/附言/yurRef
 *         · createdById = 该 tenant 第一个 FINANCE (fallback BOSS)
 *         · txDate 用 CMB 流水实际时间 (YYYYMMDD HHMMSS)
 *
 * 防重:
 *   - syncKey = `cmb:${cmbAccount}:${YYYYMMDD}:${sequence}` 全球唯一 (sequence 是 CMB 全账户唯一编号)
 *   - 写之前 findFirst({ refType: 'CmbAutoSync', refId: syncKey }) 判存在
 *   - 即使同时多个 worker 跑 → 顶多重复, 但 unique constraint 没加 (避免 migration), 由应用层兜底
 *
 * 限流:
 *   - cmbTransactions API 同账户 10s/次, 多账户并行不互撞
 *   - 30 分钟一轮足够安全
 */
import { Prisma, prisma } from '@dianjie/db'
import { cmbTransactions, type CmbTransaction } from './cmbPayment'
import dayjs from 'dayjs'
import { writeCashTransaction } from './cashbook'

const SYNC_REF_TYPE = 'CmbAutoSync'

/** 银行读取也必须显式开启；开发/预览环境即使误配开关也绝不调用外部服务。 */
export function isCmbSyncEnabled() {
  return process.env.NODE_ENV === 'production'
    && process.env.PREVIEW_MODE !== 'true'
    && process.env.CMB_SYNC_ENABLED === 'true'
}

export interface CmbSyncResult {
  account: string
  accountName: string
  pulled: number          // 从 CMB 拉的总条数
  matched: number         // 跟现有 sink (yurRef) 配上, 跳过
  alreadySynced: number   // 之前已自动同步过, 跳过
  newlyWritten: number    // 这次新写入 cashbook 的
  errors: number
  errorMsg?: string
}

/**
 * 找 tenant 的 system actor (谁背 cron 写流水的责任)
 * 优先 FINANCE (该 tenant 第一个 ACTIVE), fallback ADMIN, 都没就报错
 */
async function getSystemActor(tenantId: string): Promise<string> {
  const finance = await prisma.user.findFirst({
    where: { tenantId, role: 'FINANCE', status: 'ACTIVE' },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  if (finance) return finance.id
  const admin = await prisma.user.findFirst({
    where: { tenantId, role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  if (admin) return admin.id
  throw new Error(`tenant ${tenantId} 没找到 FINANCE/ADMIN 用户, 无法自动同步 CMB 流水`)
}

/** 把 CMB date+time (YYYYMMDD + HHMMSS) 转 Date */
export function parseCmbDateTime(date: string, time: string): Date {
  const y = date.slice(0, 4)
  const m = date.slice(4, 6)
  const d = date.slice(6, 8)
  const hh = time.slice(0, 2) || '00'
  const mm = time.slice(2, 4) || '00'
  const ss = time.slice(4, 6) || '00'
  return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}+08:00`)
}

/**
 * 把一条已经从银行获取的流水原子落入资金台账。
 * 该函数不访问外部银行，可由测试和同步循环复用。
 */
export async function applyCmbTransaction(opts: {
  tenantId: string
  cashAccountId: string
  cmbAccount: string
  actorId: string
  transaction: CmbTransaction
}): Promise<{ created: boolean; syncKey: string; cashTransactionId?: string }> {
  const item = opts.transaction
  const syncKey = `cmb:${opts.cmbAccount}:${item.date}:${item.sequence}`
  const amount = Math.abs(Number(item.amount))
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`招行流水金额无效: ${item.amount}`)
  }
  try {
    return await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cmb-sync:${opts.tenantId}:${opts.cashAccountId}:${syncKey}`}))`
      const existing = await tx.cashTransaction.findFirst({
        where: {
          tenantId: opts.tenantId,
          accountId: opts.cashAccountId,
          refType: SYNC_REF_TYPE,
          refId: syncKey,
        },
        select: { id: true },
      })
      if (existing) return { created: false, syncKey, cashTransactionId: existing.id }

      const direction: 1 | -1 = item.direction === 'C' ? 1 : -1
      const noteParts: string[] = []
      if (item.counterName) noteParts.push(`对方: ${item.counterName}`)
      if (item.remark) noteParts.push(`附言: ${item.remark}`)
      if (item.yurRef) noteParts.push(`参考号: ${item.yurRef}`)
      noteParts.push('(招行自动同步)')
      const note = noteParts.join(' · ').slice(0, 500)
      const cashTx = await writeCashTransaction(tx, {
        tenantId: opts.tenantId,
        accountId: opts.cashAccountId,
        direction,
        category: direction === 1 ? '未分类入账' : '未分类出账',
        amount,
        note,
        txDate: parseCmbDateTime(item.date, item.time),
        refType: SYNC_REF_TYPE,
        refId: syncKey,
        createdById: opts.actorId,
      })
      if (!cashTx) throw new Error('招行流水资金账户写入失败')
      await tx.opLog.create({
        data: {
          tenantId: opts.tenantId,
          userId: opts.actorId,
          isAi: true,
          action: `同步招行${direction === 1 ? '入账' : '出账'} ¥${amount.toFixed(2)}`,
          entityType: 'CashTransaction',
          targetId: cashTx.id,
          metadata: {
            cashAccountId: opts.cashAccountId,
            syncKey,
            direction,
            amount: amount.toFixed(2),
            bankSequence: item.sequence,
            bankDate: item.date,
            yurRef: item.yurRef || null,
          },
        },
      })
      return { created: true, syncKey, cashTransactionId: cashTx.id }
    })
  } catch (error: any) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.cashTransaction.findFirst({
        where: {
          tenantId: opts.tenantId,
          accountId: opts.cashAccountId,
          refType: SYNC_REF_TYPE,
          refId: syncKey,
        },
        select: { id: true },
      })
      if (existing) return { created: false, syncKey, cashTransactionId: existing.id }
    }
    throw error
  }
}

/** 同步单个账户 */
export async function syncCmbAccount(opts: {
  tenantId: string
  cashAccountId: string
  cmbAccount: string
  accountName?: string
  fromDate: Date
  toDate: Date
}): Promise<CmbSyncResult> {
  if (!isCmbSyncEnabled()) {
    throw new Error('招行流水同步未启用，未调用银行')
  }
  const result: CmbSyncResult = {
    account: opts.cmbAccount,
    accountName: opts.accountName || opts.cmbAccount,
    pulled: 0, matched: 0, alreadySynced: 0, newlyWritten: 0, errors: 0,
  }

  // 1. 拉 CMB 流水
  let tx
  try {
    tx = await cmbTransactions({
      account: opts.cmbAccount,
      beginDate: dayjs(opts.fromDate).format('YYYYMMDD'),
      endDate: dayjs(opts.toDate).format('YYYYMMDD'),
    })
  } catch (e: any) {
    result.errors = 1
    result.errorMsg = `CMB API 异常: ${e?.message}`
    return result
  }

  if (!tx.success || !tx.transactions) {
    result.errors = 1
    result.errorMsg = `CMB 流水查询失败: ${tx.resultMsg || tx.resultCode || 'unknown'}`
    return result
  }
  result.pulled = tx.transactions.length
  if (result.pulled === 0) return result

  // 2. 一次性查 yurRef 已 sink 的
  const yurRefs = tx.transactions.map(t => t.yurRef).filter(Boolean) as string[]
  const yurRefSinked = new Set<string>()
  if (yurRefs.length > 0) {
    const sinks = await prisma.cashTransaction.findMany({
      where: {
        tenantId: opts.tenantId,
        accountId: opts.cashAccountId,
        refId: { in: yurRefs },
      },
      select: { refId: true },
    })
    sinks.forEach(s => s.refId && yurRefSinked.add(s.refId))
  }

  // 3. 一次性查已自动同步过的
  const allSyncKeys = tx.transactions.map(t => `cmb:${opts.cmbAccount}:${t.date}:${t.sequence}`)
  const alreadySyncedKeys = new Set<string>()
  const syncedRows = await prisma.cashTransaction.findMany({
    where: {
      tenantId: opts.tenantId,
      refType: SYNC_REF_TYPE,
      refId: { in: allSyncKeys },
    },
    select: { refId: true },
  })
  syncedRows.forEach(r => r.refId && alreadySyncedKeys.add(r.refId))

  // 4. 系统 actor
  let actor: string
  try {
    actor = await getSystemActor(opts.tenantId)
  } catch (e: any) {
    result.errors = 1
    result.errorMsg = e?.message
    return result
  }

  // 5. 逐条处理
  for (const t of tx.transactions) {
    if (t.yurRef && yurRefSinked.has(t.yurRef)) {
      result.matched++
      continue
    }
    const syncKey = `cmb:${opts.cmbAccount}:${t.date}:${t.sequence}`
    if (alreadySyncedKeys.has(syncKey)) {
      result.alreadySynced++
      continue
    }

    try {
      const applied = await applyCmbTransaction({
        tenantId: opts.tenantId,
        cashAccountId: opts.cashAccountId,
        cmbAccount: opts.cmbAccount,
        actorId: actor,
        transaction: t,
      })
      if (applied.created) result.newlyWritten++
      else result.alreadySynced++
    } catch (e: any) {
      console.error(`[cmbAutoSync] ${syncKey} write failed:`, e?.message)
      result.errors++
    }
  }

  return result
}

/**
 * 同步所有 cmbBindAccount 账户 (跨 tenant)
 * @param daysBack 拉最近几天 (默认 1, 即昨天+今天)
 */
export async function syncAllCmbAccounts(daysBack = 1): Promise<CmbSyncResult[]> {
  if (!isCmbSyncEnabled()) return []
  const accounts = await prisma.cashAccount.findMany({
    where: { cmbBindAccount: { not: null }, status: 'ACTIVE' },
    select: { id: true, tenantId: true, cmbBindAccount: true, name: true },
  })
  if (accounts.length === 0) return []

  const fromDate = dayjs().subtract(daysBack, 'day').toDate()
  const toDate = dayjs().toDate()

  return await Promise.all(
    accounts.map(a =>
      syncCmbAccount({
        tenantId: a.tenantId,
        cashAccountId: a.id,
        cmbAccount: a.cmbBindAccount!,
        accountName: a.name,
        fromDate, toDate,
      }).catch(e => ({
        account: a.cmbBindAccount!, accountName: a.name,
        pulled: 0, matched: 0, alreadySynced: 0, newlyWritten: 0,
        errors: 1, errorMsg: e?.message || String(e),
      } as CmbSyncResult)),
    ),
  )
}
