/**
 * 餐饮行业标准会计科目表 (按企业会计准则 + 餐饮业实际)
 * 与好会计的科目体系兼容, code 沿用国标
 *
 * 一级科目 (1xxx 资产 / 2xxx 负债 / 3xxx 权益 / 5xxx 成本 / 6xxx 费用)
 * 末级用于实际记账, 中间层用于汇总
 */

export type SeedAccount = {
  code: string
  name: string
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'
  parent?: string
  isDetail?: boolean
}

export const RESTAURANT_COA: SeedAccount[] = [
  // ── 资产 ─────────────────────────────────────
  { code: '1001', name: '库存现金',                type: 'ASSET' },
  { code: '1002', name: '银行存款',                type: 'ASSET',  isDetail: false },
  { code: '100201', name: '银行存款-招商银行',     type: 'ASSET',  parent: '1002' },
  { code: '100202', name: '银行存款-基本户',       type: 'ASSET',  parent: '1002' },
  { code: '1012', name: '其他货币资金',            type: 'ASSET',  isDetail: false },
  { code: '101201', name: '其他货币资金-美团',     type: 'ASSET',  parent: '1012' },
  { code: '101202', name: '其他货币资金-抖音',     type: 'ASSET',  parent: '1012' },
  { code: '101203', name: '其他货币资金-支付宝',   type: 'ASSET',  parent: '1012' },
  { code: '101204', name: '其他货币资金-微信',     type: 'ASSET',  parent: '1012' },
  { code: '1122', name: '应收账款',                type: 'ASSET' },
  { code: '1221', name: '其他应收款',              type: 'ASSET' },
  { code: '1403', name: '原材料',                  type: 'ASSET' },
  { code: '1405', name: '库存商品',                type: 'ASSET' },        // 餐饮: 食材入库
  { code: '1411', name: '周转材料',                type: 'ASSET' },        // 一次性餐具/打印纸等
  { code: '1601', name: '固定资产',                type: 'ASSET' },
  { code: '1602', name: '累计折旧',                type: 'ASSET' },        // 借方红字
  { code: '1701', name: '长期待摊费用',            type: 'ASSET' },        // 装修分摊

  // ── 负债 ─────────────────────────────────────
  { code: '2001', name: '短期借款',                type: 'LIABILITY' },
  { code: '2202', name: '应付账款',                type: 'LIABILITY' },     // 应付供应商
  { code: '2211', name: '应付职工薪酬',            type: 'LIABILITY' },
  { code: '2221', name: '应交税费',                type: 'LIABILITY',  isDetail: false },
  { code: '222101', name: '应交税费-增值税',       type: 'LIABILITY',  parent: '2221' },
  { code: '222102', name: '应交税费-企业所得税',   type: 'LIABILITY',  parent: '2221' },
  { code: '222103', name: '应交税费-个人所得税',   type: 'LIABILITY',  parent: '2221' },
  { code: '222104', name: '应交税费-城市维护建设税', type: 'LIABILITY', parent: '2221' },
  { code: '2241', name: '其他应付款',              type: 'LIABILITY' },
  { code: '2401', name: '预收账款',                type: 'LIABILITY' },     // 储值卡/预付餐券

  // ── 所有者权益 ──────────────────────────────
  { code: '4001', name: '实收资本',                type: 'EQUITY' },
  { code: '4101', name: '盈余公积',                type: 'EQUITY' },
  { code: '4103', name: '本年利润',                type: 'EQUITY' },
  { code: '4104', name: '利润分配',                type: 'EQUITY' },

  // ── 收入 ────────────────────────────────────
  { code: '6001', name: '主营业务收入',            type: 'REVENUE',  isDetail: false },
  { code: '600101', name: '主营业务收入-堂食',     type: 'REVENUE',  parent: '6001' },
  { code: '600102', name: '主营业务收入-外卖',     type: 'REVENUE',  parent: '6001' },
  { code: '600103', name: '主营业务收入-储值',     type: 'REVENUE',  parent: '6001' },
  { code: '6051', name: '其他业务收入',            type: 'REVENUE' },

  // ── 成本 / 费用 ────────────────────────────
  { code: '6401', name: '主营业务成本',            type: 'EXPENSE',  isDetail: false },
  { code: '640101', name: '主营业务成本-食材',     type: 'EXPENSE',  parent: '6401' },
  { code: '640102', name: '主营业务成本-酒水',     type: 'EXPENSE',  parent: '6401' },
  { code: '640103', name: '主营业务成本-外卖佣金', type: 'EXPENSE',  parent: '6401' },
  { code: '6601', name: '销售费用',                type: 'EXPENSE',  isDetail: false },
  { code: '660101', name: '销售费用-广告费',       type: 'EXPENSE',  parent: '6601' },
  { code: '660102', name: '销售费用-业务招待费',   type: 'EXPENSE',  parent: '6601' },
  { code: '660103', name: '销售费用-报损',         type: 'EXPENSE',  parent: '6601' },
  { code: '660104', name: '销售费用-外送费',       type: 'EXPENSE',  parent: '6601' },
  { code: '6602', name: '管理费用',                type: 'EXPENSE',  isDetail: false },
  { code: '660201', name: '管理费用-工资',         type: 'EXPENSE',  parent: '6602' },
  { code: '660202', name: '管理费用-社保',         type: 'EXPENSE',  parent: '6602' },
  { code: '660203', name: '管理费用-房租',         type: 'EXPENSE',  parent: '6602' },
  { code: '660204', name: '管理费用-水电费',       type: 'EXPENSE',  parent: '6602' },
  { code: '660205', name: '管理费用-办公费',       type: 'EXPENSE',  parent: '6602' },
  { code: '660206', name: '管理费用-折旧',         type: 'EXPENSE',  parent: '6602' },
  { code: '660207', name: '管理费用-长期待摊摊销', type: 'EXPENSE',  parent: '6602' },
  { code: '660208', name: '管理费用-其他',         type: 'EXPENSE',  parent: '6602' },
  { code: '6603', name: '财务费用',                type: 'EXPENSE',  isDetail: false },
  { code: '660301', name: '财务费用-手续费',       type: 'EXPENSE',  parent: '6603' },
  { code: '660302', name: '财务费用-利息',         type: 'EXPENSE',  parent: '6603' },
  { code: '6711', name: '营业外支出',              type: 'EXPENSE' },
]

/** seed 标准餐饮科目表到指定 tenant */
export async function seedRestaurantCoA(prisma: any, tenantId: string) {
  for (const a of RESTAURANT_COA) {
    await prisma.chartOfAccount.upsert({
      where: { tenantId_code: { tenantId, code: a.code } },
      create: {
        tenantId, code: a.code, name: a.name, type: a.type,
        parentCode: a.parent || null,
        isDetail: a.isDetail !== false,   // 默认末级
        builtin: true,
      },
      update: {
        name: a.name, type: a.type,
        parentCode: a.parent || null,
        isDetail: a.isDetail !== false,
        builtin: true,
      },
    })
  }
}
