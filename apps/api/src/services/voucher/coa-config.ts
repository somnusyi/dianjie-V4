/**
 * 会计科目前缀配置 (兼容两套体系)
 *
 * 客户 (dianjie 合肥瑶海店) 实际用 **企业会计准则 2006** (5xxx 损益 / 3xxx 所有者权益).
 * 代码库历史模板 `chart-of-accounts-restaurant.ts` 用 **好会计/小企业旧准则** (6xxx 损益 / 4xxx 所有者权益).
 * 两套并存场景: test tenant 镜像 dianjie 时会同时有 5xxx (从 dianjie 来) + 6xxx (从默认 seed).
 *
 * 设计: 每个"会计概念"声明 **多个前缀**, 查询时全部 OR 一起跑, 自动兼容两套.
 *
 * 本年利润目标科目 (carryover 落账目标) 用 resolveProfitAccount() 运行时查 tenant CoA, 选 3103 优先 / 4103 兜底.
 */
import { prisma } from '@dianjie/db'

/** 损益类前缀 (4 位主科目) */
export const PNL_PREFIXES = {
  // 收入
  revenueMain:   ['5001', '6001'] as string[],   // 主营业务收入
  revenueOther:  ['5051', '6051'] as string[],   // 其他业务收入
  revenueNonOp:  ['5301'] as string[],           // 营业外收入 (2006)
  investIncome:  ['5111'] as string[],           // 投资收益 (2006)
  interestIncome:['5603'] as string[],           // 利息收入 (并入财务费用核算)
  // 成本费用
  costMain:      ['5401', '6401'] as string[],   // 主营业务成本
  costOther:     ['5402'] as string[],           // 其他业务成本
  tax:           ['5403', '6403'] as string[],   // 税金及附加
  sellingExp:    ['5601', '6601'] as string[],   // 销售费用
  mgmtExp:       ['5602', '6602'] as string[],   // 管理费用
  financeExp:    ['5603', '6603'] as string[],   // 财务费用
  assetImpair:   ['5711'] as string[],           // 资产减值损失 (2006)
  nonOpExpense:  ['6711'] as string[],           // 营业外支出 (兼容)
  incomeTax:     ['5801'] as string[],           // 所得税费用 (2006)
}

/** 所有损益类前缀合集 (carryover 用) */
export const ALL_PNL_PREFIXES: string[] = [
  ...PNL_PREFIXES.revenueMain,
  ...PNL_PREFIXES.revenueOther,
  ...PNL_PREFIXES.revenueNonOp,
  ...PNL_PREFIXES.investIncome,
  ...PNL_PREFIXES.costMain,
  ...PNL_PREFIXES.costOther,
  ...PNL_PREFIXES.tax,
  ...PNL_PREFIXES.sellingExp,
  ...PNL_PREFIXES.mgmtExp,
  ...PNL_PREFIXES.financeExp,
  ...PNL_PREFIXES.assetImpair,
  ...PNL_PREFIXES.nonOpExpense,
]

/**
 * carryover 归类分桶
 * 用于把不同前缀合并到同一行 (例: 5001/6001 都算"主营业务收入")
 */
export const PNL_BUCKETS: Array<{
  key: string
  name: string
  prefixes: string[]
  side: 'revenue' | 'expense'   // revenue: 期末贷余, expense: 期末借余
}> = [
  { key: 'revenueMain',  name: '主营业务收入', prefixes: PNL_PREFIXES.revenueMain,  side: 'revenue' },
  { key: 'revenueOther', name: '其他业务收入', prefixes: PNL_PREFIXES.revenueOther, side: 'revenue' },
  { key: 'revenueNonOp', name: '营业外收入',   prefixes: PNL_PREFIXES.revenueNonOp, side: 'revenue' },
  { key: 'investIncome', name: '投资收益',     prefixes: PNL_PREFIXES.investIncome, side: 'revenue' },
  { key: 'costMain',     name: '主营业务成本', prefixes: PNL_PREFIXES.costMain,     side: 'expense' },
  { key: 'costOther',    name: '其他业务成本', prefixes: PNL_PREFIXES.costOther,    side: 'expense' },
  { key: 'tax',          name: '税金及附加',   prefixes: PNL_PREFIXES.tax,          side: 'expense' },
  { key: 'sellingExp',   name: '销售费用',     prefixes: PNL_PREFIXES.sellingExp,   side: 'expense' },
  { key: 'mgmtExp',      name: '管理费用',     prefixes: PNL_PREFIXES.mgmtExp,      side: 'expense' },
  { key: 'financeExp',   name: '财务费用',     prefixes: PNL_PREFIXES.financeExp,   side: 'expense' },
  { key: 'assetImpair',  name: '资产减值损失', prefixes: PNL_PREFIXES.assetImpair,  side: 'expense' },
  { key: 'nonOpExpense', name: '营业外支出',   prefixes: PNL_PREFIXES.nonOpExpense, side: 'expense' },
]

/** 资负表前缀 (按概念, 每概念可多前缀) */
export const BS_PREFIXES = {
  // 资产
  cash:        ['1001'],
  bank:        ['1002'],
  otherCash:   ['1012'],                  // 其他货币资金 (美团/抖音/支付宝/微信余额)
  ar:          ['1122'],                  // 应收账款
  otherAr:     ['1221'],                  // 其他应收款
  prepaid:     ['1123'],                  // 预付账款
  inventory:   ['1403', '1405', '1411'],  // 原材料 + 库存商品 + 周转材料
  longExp:     ['1701', '1801'],          // 长期待摊
  fixedAsset:  ['1601'],
  accumDep:    ['1602'],                  // 借方红字 (累计折旧, 减项)
  // 负债
  ap:          ['2202'],
  payroll:     ['2211'],
  taxPayable:  ['2221'],
  otherAp:     ['2241'],
  advance:     ['2203', '2401'],          // 预收账款
  shortLoan:   ['2001'],
  // 权益
  paidInCapital:    ['3001', '4001'],
  capitalReserve:   ['3002', '4002'],
  surplusReserve:   ['3101', '4101'],
  profitYTD:        ['3103', '4103'],     // 本年利润
  retainedEarnings: ['3104', '4104'],     // 利润分配 / 未分配利润
}

/**
 * 查询本年利润目标科目 (carryover 落账目标)
 * 优先 3103 (企业会计准则 2006), 兜底 4103 (好会计旧准则)
 */
export async function resolveProfitAccount(tenantId: string): Promise<{ code: string; name: string }> {
  // 直接查 chart_of_accounts; 不存在则用 3103 默认
  const found = await prisma.chartOfAccount.findFirst({
    where: { tenantId, code: { in: ['3103', '4103'] } },
    select: { code: true, name: true },
    orderBy: { code: 'asc' },   // 3103 优先
  })
  return found || { code: '3103', name: '本年利润' }
}
