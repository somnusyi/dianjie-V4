import { prisma } from '@dianjie/db'

/**
 * 供应商文本 → 供应商主数据 解析（P2 入库结构化）。
 *
 * 匹配顺序：
 * 1) 精确匹配供应商档案名（重名时 ENABLED 优先；仍有多个 ENABLED 同名则视为歧义，不猜）
 * 2) 命中供应商名称别名表（人工认领一次后永久生效）
 *
 * 数据包多供应商聚合行（"A、B"）不应调用本解析——调用方自行判断是否单一来源。
 */
export async function resolveSupplierIdsByNames(tenantId: string, names: string[]): Promise<Map<string, string>> {
  const clean = [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))]
  const result = new Map<string, string>()
  if (clean.length === 0) return result

  const suppliers = await prisma.supplier.findMany({
    where: { tenantId, name: { in: clean } },
    select: { id: true, name: true, status: true },
  })
  const byName = new Map<string, typeof suppliers>()
  for (const supplier of suppliers) {
    const list = byName.get(supplier.name) || []
    list.push(supplier)
    byName.set(supplier.name, list)
  }
  const unresolved: string[] = []
  for (const name of clean) {
    const list = byName.get(name) || []
    const enabled = list.filter(supplier => supplier.status === 'ENABLED')
    const pick = enabled.length === 1 ? enabled[0] : list.length === 1 ? list[0] : null
    if (pick) result.set(name, pick.id)
    else unresolved.push(name)
  }
  if (unresolved.length > 0) {
    const aliases = await prisma.supplierNameAlias.findMany({
      where: { tenantId, alias: { in: unresolved } },
      select: { alias: true, supplierId: true },
    })
    for (const alias of aliases) result.set(alias.alias, alias.supplierId)
  }
  return result
}

export async function resolveSupplierIdByName(tenantId: string, name: string): Promise<string | null> {
  const resolved = await resolveSupplierIdsByNames(tenantId, [name])
  return resolved.get(String(name || '').trim()) || null
}
