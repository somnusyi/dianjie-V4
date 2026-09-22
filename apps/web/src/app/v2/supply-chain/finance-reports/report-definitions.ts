/** Finance report UI columns; all report data comes from the authenticated API. */
export type FinanceColumn = { key: string; label: string; kind?: 'money' | 'quantity' | 'percent' }
export type FinanceRow = Record<string, string | number | null>
export const financeReports = [
  { id: 'group-profit', title: '集团毛利分析表', note: '按客户和配送中心汇总收入、成本和毛利。' },
  { id: 'item-profit', title: '集团物品毛利分析表', note: '按仓库、客户和物品汇总；均价按库存基准单位计算。' },
  { id: 'profit-detail', title: '集团毛利明细表', note: '逐单逐物品展示；退回及撤销按发生日冲减。' },
]
export type FinanceReportId = typeof financeReports[number]['id']
export type FinanceFilters = { start: string; end: string; customer: string; center: string; keyword: string; warehouse: string; category: string; unit: string; document: string; source: string }
export const defaultFinanceFilters = (): FinanceFilters => {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
  return { start: `${today.slice(0, 7)}-01`, end: today, customer: '', center: '', keyword: '', warehouse: '', category: '', unit: '', document: '', source: '' }
}
