/**
 * 供应商后台分类过滤 — 隐藏门店端操作维度分类
 *
 * 门店按岗位/档口建的分类（如"素菜岗""水吧""BOM待采购映射"）
 * 与供应商供货无关，在供应商后台的分类管理、商品筛选、库存筛选中统一隐藏。
 * 被隐藏分类下已挂载的商品不受影响，仍可在"全部"视图和分组列表中正常展示。
 */

/** 已知的门店端专属分类名（不以"岗"结尾但同样属于门店操作维度） */
const STORE_ONLY_EXACT_NAMES: ReadonlySet<string> = new Set([
  '前厅调料',
  '水吧',
  'BOM待采购映射',
])

/**
 * 判断分类名是否属于门店端操作维度，应在供应商后台隐藏。
 *
 * 规则：
 * 1. 以"岗"结尾 — 门店岗位分类（素菜岗、菌菇岗、配锅岗…）
 * 2. 精确命中已知门店分类名单
 */
export function isStoreOnlyCategory(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  if (trimmed.endsWith('岗')) return true
  return STORE_ONLY_EXACT_NAMES.has(trimmed)
}

/** 从分类列表中过滤掉门店端分类，返回仅供货相关分类 */
export function filterSupplierCategories<T extends { name: string }>(categories: T[]): T[] {
  return categories.filter(c => !isStoreOnlyCategory(c.name))
}
