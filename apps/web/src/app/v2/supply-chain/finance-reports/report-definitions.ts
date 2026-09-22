/** Finance report UI columns; all report data comes from the authenticated API. */
export type FinanceColumn = { key: string; label: string; kind?: 'money' | 'quantity' | 'percent' }
export type FinanceRow = Record<string, string | number | null>
export const financeReports = [
  { id: 'group-profit', title: '集团毛利分析表', columns: [
    { key: 'customer', label: '客户名称' }, { key: 'center', label: '配送中心' }, { key: 'profit', label: '折后毛利', kind: 'money' }, { key: 'revenue', label: '折后收入', kind: 'money' }, { key: 'cost', label: '出库成本', kind: 'money' },
  ], note: '按客户和配送中心汇总。折后毛利 = 折后收入 − 出库成本。' },
  { id: 'item-profit', title: '集团物品毛利分析表', columns: [
    { key: 'warehouse', label: '仓库' }, { key: 'customer', label: '客户名称' }, { key: 'category', label: '类别名称' }, { key: 'itemName', label: '物品名称' }, { key: 'spec', label: '规格' }, { key: 'unit', label: '单位' }, { key: 'quantity', label: '净销量', kind: 'quantity' }, { key: 'revenue', label: '折后收入', kind: 'money' }, { key: 'cost', label: '出库成本', kind: 'money' }, { key: 'rate', label: '毛利率', kind: 'percent' }, { key: 'averageRevenue', label: '折后收入均价', kind: 'money' }, { key: 'averageCost', label: '出库成本均价', kind: 'money' },
  ], note: '按仓库、客户和物品汇总。均价按净销量计算，毛利率按收入与成本计算；分母为零时显示“—”。' },
  { id: 'profit-detail', title: '集团毛利明细表', columns: [
    { key: 'code', label: '编码' }, { key: 'name', label: '名称' }, { key: 'itemCode', label: '物品编码' }, { key: 'spec', label: '规格型号' }, { key: 'document', label: '单据号' }, { key: 'date', label: '业务日期' }, { key: 'source', label: '出入库相关项' }, { key: 'quantity', label: '数量', kind: 'quantity' }, { key: 'cost', label: '成本', kind: 'money' }, { key: 'revenue', label: '发货金额', kind: 'money' },
  ], note: '逐单逐物品展示，成本只读；退回及撤销按发生日冲减。' },
] satisfies { id: string; title: string; columns: FinanceColumn[]; note: string }[]
export type FinanceReportId = typeof financeReports[number]['id']
export type FinanceFilters = { start: string; end: string; customer: string; center: string; keyword: string; warehouse: string; category: string; unit: string; document: string; source: string }
export const defaultFinanceFilters = (): FinanceFilters => {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
  return { start: `${today.slice(0, 7)}-01`, end: today, customer: '', center: '', keyword: '', warehouse: '', category: '', unit: '', document: '', source: '' }
}
