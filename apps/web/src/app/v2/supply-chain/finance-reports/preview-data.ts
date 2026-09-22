/** UI review fixtures only. No financial API/database reads or writes. */
export type FinanceColumn = { key: string; label: string; kind?: 'money' | 'quantity' | 'percent' }
export type PreviewRow = Record<string, string | number | null>
export const financeReports = [
  { id: 'group-profit', title: '集团毛利分析表', columns: [
    { key: 'customer', label: '客户名称' }, { key: 'center', label: '配送中心' }, { key: 'profit', label: '折后毛利', kind: 'money' }, { key: 'revenue', label: '折后收入', kind: 'money' }, { key: 'cost', label: '出库成本', kind: 'money' },
  ], note: '按客户和配送中心汇总。示例折后毛利 = 折后收入 − 出库成本。' },
  { id: 'item-profit', title: '集团物品毛利分析表', columns: [
    { key: 'warehouse', label: '仓库' }, { key: 'customer', label: '客户名称' }, { key: 'category', label: '类别名称' }, { key: 'itemName', label: '物品名称' }, { key: 'spec', label: '规格' }, { key: 'unit', label: '单位' }, { key: 'quantity', label: '净销量', kind: 'quantity' }, { key: 'revenue', label: '折后收入', kind: 'money' }, { key: 'cost', label: '出库成本', kind: 'money' }, { key: 'rate', label: '毛利率', kind: 'percent' }, { key: 'averageRevenue', label: '折后收入均价', kind: 'money' }, { key: 'averageCost', label: '出库成本均价', kind: 'money' },
  ], note: '按仓库、客户和物品汇总。均价按净销量计算，毛利率按收入与成本计算；分母为零时显示“—”。' },
  { id: 'profit-detail', title: '集团毛利明细表', columns: [
    { key: 'code', label: '编码' }, { key: 'name', label: '名称' }, { key: 'itemCode', label: '物品编码' }, { key: 'spec', label: '规格型号' }, { key: 'document', label: '单据号' }, { key: 'date', label: '业务日期' }, { key: 'source', label: '出入库相关项' }, { key: 'quantity', label: '数量', kind: 'quantity' }, { key: 'cost', label: '成本', kind: 'money' }, { key: 'revenue', label: '发货金额', kind: 'money' },
  ], note: '逐单逐物品展示，包含返货入库示例；成本为只读。此处是示例计算，正式成本确认规则将在 UI 审批后接入。' },
] satisfies { id: string; title: string; columns: FinanceColumn[]; note: string }[]
export type FinanceReportId = typeof financeReports[number]['id']
const round = (value: number) => Math.round(value * 100) / 100
const items = [
  { itemCode: 'DJ00001', itemName: '鲜羊肚菌', category: '菌菇类', spec: '5kg/箱', unit: 'kg', price: 120, costPrice: 92 },
  { itemCode: 'DJ00002', itemName: '人工见手青', category: '菌菇类', spec: '5kg/箱', unit: 'kg', price: 76, costPrice: 58 },
  { itemCode: 'DJ00003', itemName: '云南小土豆', category: '蔬菜类', spec: '10kg/箱', unit: 'kg', price: 12, costPrice: 8 },
  { itemCode: 'DJ00004', itemName: '菌汤底料', category: '调味料', spec: '500g/包', unit: '包', price: 25, costPrice: 18 },
  { itemCode: 'DJ00005', itemName: '鲜竹荪', category: '菌菇类', spec: '2kg/箱', unit: 'kg', price: 48, costPrice: 34 },
  { itemCode: 'DJ00006', itemName: '云南豆腐皮', category: '豆制品', spec: '1kg/袋', unit: 'kg', price: 22, costPrice: 16 },
]
export const previewDetails: PreviewRow[] = Array.from({ length: 48 }, (_, i) => {
  const item = items[i % items.length]
  const customerIndex = Math.floor(i / 6) % 4
  const quantity = i % 11 === 10 ? -2 : 8 + i % 9
  return { ...item, id: `preview-${i}`, code: `KH00${customerIndex + 1}`, name: `示例门店 ${'ABCD'[customerIndex]}`, customer: `示例门店 ${'ABCD'[customerIndex]}`, center: '示例总部配送中心', warehouse: '示例供应链总仓', date: `2026-09-${String(1 + i % 22).padStart(2, '0')}`, document: `${quantity < 0 ? 'TH' : 'CK'}202609${String(i + 1).padStart(5, '0')}`, source: quantity < 0 ? '返货入库' : '配送出库', quantity, revenue: round(quantity * item.price), cost: round(quantity * item.costPrice) }
})
export type FinanceFilters = { start: string; end: string; customer: string; center: string; keyword: string; warehouse: string; category: string; unit: string; document: string; source: string }
export const defaultFinanceFilters = (): FinanceFilters => ({ start: '2026-09-01', end: '2026-09-30', customer: '', center: '', keyword: '', warehouse: '', category: '', unit: '', document: '', source: '' })
export function selectPreviewRows(id: string, filters: FinanceFilters): PreviewRow[] {
  const details = previewDetails.filter(row => {
    if (filters.start && String(row.date) < filters.start || filters.end && String(row.date) > filters.end) return false
    for (const key of ['customer', 'center', 'warehouse', 'category', 'unit', 'source'] as const) if (filters[key] && row[key] !== filters[key]) return false
    if (filters.document && !String(row.document).includes(filters.document)) return false
    return !filters.keyword || `${row.itemName} ${row.itemCode} ${row.name} ${row.code}`.toLowerCase().includes(filters.keyword.toLowerCase())
  })
  if (id === 'profit-detail') return details
  const groups = new Map<string, PreviewRow>()
  for (const row of details) {
    const key = JSON.stringify(id === 'group-profit' ? [row.customer, row.center] : [row.warehouse, row.customer, row.itemCode, row.unit])
    const group = groups.get(key) || { ...row, id: key, quantity: 0, revenue: 0, cost: 0 }
    for (const field of ['quantity', 'revenue', 'cost']) group[field] = round(Number(group[field]) + Number(row[field]))
    groups.set(key, group)
  }
  return [...groups.values()].map(row => ({ ...row, profit: round(Number(row.revenue) - Number(row.cost)), rate: row.revenue === 0 ? null : (Number(row.revenue) - Number(row.cost)) / Number(row.revenue), averageRevenue: row.quantity === 0 ? null : Number(row.revenue) / Number(row.quantity), averageCost: row.quantity === 0 ? null : Number(row.cost) / Number(row.quantity) }))
}
