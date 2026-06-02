/**
 * 期末结转凭证 (Carryover)
 *
 * 月末关账时, 把本月所有损益类科目余额结转到 "4103 本年利润":
 *   - 收入类 (6001 主营业务收入 / 其他 6xxx 收入): 借收入 / 贷本年利润 (清零收入)
 *   - 成本/费用类 (6401 主营业务成本 / 6601 销售费用 / 6602 管理费用 / 6603 财务费用):
 *     借本年利润 / 贷成本费用 (清零成本费用)
 *
 * 结转后:
 *   - 损益类科目本期净额 = 0 (下月重新计)
 *   - 本年利润累计 = 本年累计净利
 *
 * 数据源:
 *   - 本月 status=POSTED 凭证的分录 (DRAFT 不算; 关账前财务应已审完)
 *   - 按 accountCode 前 4 位归类到 6001/6401/6601/6602/6603
 *
 * 幂等: 同 tenantId + month, 二次调用返已存在 voucher
 */
import { prisma } from '@dianjie/db'
import dayjs from 'dayjs'
import { createVoucher, VoucherEntryInput } from './index'

interface CarryoverOpts {
  tenantId: string
  month: string                  // YYYY-MM
  createdById?: string | null
}

/**
 * 期末结转
 * 返回新建 voucher.id (无可结转时返 null)
 */
export async function generateCarryoverVoucher(opts: CarryoverOpts): Promise<string | null> {
  const { tenantId, month, createdById = null } = opts

  // 幂等: 同 tenantId + sourceType=Carryover + sourceId=month 已存在则返
  const exist = await prisma.voucher.findFirst({
    where: { tenantId, sourceType: 'Carryover', sourceId: month },
    select: { id: true },
  })
  if (exist) return exist.id

  // 1. 拉本月 POSTED 凭证分录, 按科目前缀归类
  const start = dayjs(month + '-01').startOf('month').toDate()
  const end = dayjs(month + '-01').endOf('month').toDate()
  const entries = await prisma.voucherEntry.findMany({
    where: {
      voucher: {
        tenantId,
        status: 'POSTED',
        date: { gte: start, lte: end },
        // 不结转自己, 避免反复结转
        NOT: { sourceType: 'Carryover' },
      },
    },
    select: {
      accountCode: true,
      accountName: true,
      debit: true,
      credit: true,
    },
  })

  // 2. 按 4 位代码累加 (主科目级别)
  // 收入类 (6001-): 贷方 - 借方 = 本期收入净额
  // 成本/费用类 (6401, 6601, 6602, 6603): 借方 - 贷方 = 本期成本费用净额
  const map: Record<string, { debit: number; credit: number; name: string }> = {}
  for (const e of entries) {
    const top4 = e.accountCode.slice(0, 4)
    if (!['6001', '6401', '6601', '6602', '6603'].includes(top4)) continue
    if (!map[top4]) {
      const topAccountName = ({
        '6001': '主营业务收入',
        '6401': '主营业务成本',
        '6601': '销售费用',
        '6602': '管理费用',
        '6603': '财务费用',
      } as Record<string, string>)[top4]
      map[top4] = { debit: 0, credit: 0, name: topAccountName }
    }
    map[top4].debit += Number(e.debit)
    map[top4].credit += Number(e.credit)
  }

  // 3. 生成分录
  const carryEntries: VoucherEntryInput[] = []
  let profitDebit = 0    // 累计借方本年利润 (= 总成本费用)
  let profitCredit = 0   // 累计贷方本年利润 (= 总收入)

  // 收入: 借 收入 / 贷 本年利润
  const revenueNet = (map['6001']?.credit || 0) - (map['6001']?.debit || 0)
  if (Math.abs(revenueNet) > 0.01) {
    carryEntries.push({
      accountCode: '6001', accountName: map['6001'].name,
      debit: revenueNet > 0 ? revenueNet : 0,
      credit: revenueNet < 0 ? -revenueNet : 0,
      summary: `结转主营业务收入`,
    })
    profitCredit += revenueNet > 0 ? revenueNet : 0
    profitDebit  += revenueNet < 0 ? -revenueNet : 0
  }
  // 成本/费用: 借 本年利润 / 贷 成本费用
  for (const code of ['6401', '6601', '6602', '6603']) {
    const m = map[code]
    if (!m) continue
    const expenseNet = m.debit - m.credit  // 正数 = 净支出
    if (Math.abs(expenseNet) > 0.01) {
      carryEntries.push({
        accountCode: code, accountName: m.name,
        debit: expenseNet < 0 ? -expenseNet : 0,
        credit: expenseNet > 0 ? expenseNet : 0,
        summary: `结转${m.name}`,
      })
      profitDebit  += expenseNet > 0 ? expenseNet : 0
      profitCredit += expenseNet < 0 ? -expenseNet : 0
    }
  }

  if (carryEntries.length === 0) {
    console.log(`[carryover] ${tenantId} ${month} 无可结转损益, skip`)
    return null
  }

  // 4. 本年利润对冲 (一定平账)
  const profitNet = profitCredit - profitDebit  // 正 = 本月盈利, 负 = 亏损
  if (profitNet > 0.01) {
    // 盈利: 贷 本年利润
    carryEntries.push({
      accountCode: '4103', accountName: '本年利润',
      credit: profitNet, summary: `结转本月净利`,
    })
  } else if (profitNet < -0.01) {
    // 亏损: 借 本年利润
    carryEntries.push({
      accountCode: '4103', accountName: '本年利润',
      debit: -profitNet, summary: `结转本月亏损`,
    })
  }

  // 5. 落库 (期末结转日期 = 该月最后一天)
  // lockMode=strict 但 carryover 本身就是关账前最后一笔, 此时 period 仍是 OPEN, 不冲突
  const id = await createVoucher({
    tenantId,
    date: end,
    summary: `${month} 期末结转 损益 → 本年利润`,
    word: '结转',
    sourceType: 'Carryover',
    sourceId: month,
    entries: carryEntries,
    createdById,
    lockMode: 'strict',
  })

  console.log(`[carryover] ${tenantId} ${month} 已结转: 收入 ${profitCredit.toFixed(2)}, 成本费用 ${profitDebit.toFixed(2)}, 净利 ${profitNet.toFixed(2)}, voucherId=${id}`)
  return id
}
