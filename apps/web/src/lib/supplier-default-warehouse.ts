/**
 * 供应商默认仓 helper
 *
 * 当前每个供应商只有一个默认仓 (warehouseId = 'default').
 * 本模块集中提供:
 *   - 常量: DEFAULT_WAREHOUSE_ID / DEFAULT_WAREHOUSE_NAME
 *   - URL 工具: 为 GET 请求追加/覆盖 warehouseId=default
 *   - Body 工具: 为 POST JSON 写入体追加 warehouseId 字段
 *   - 显示名解析: 优先使用服务端返回的 warehouse.name, 未知/空值回退本地常量
 *
 * 不依赖浏览器全局 (URLSearchParams 来自 polyfill 或原生均可).
 */

export const DEFAULT_WAREHOUSE_ID = 'default'
export const DEFAULT_WAREHOUSE_NAME = '默认仓'

/**
 * 为相对 API URL 追加或覆盖 warehouseId 查询参数.
 *
 * - 无 query → 追加 ?warehouseId=default
 * - 有 query 但无 warehouseId → 追加 &warehouseId=default
 * - 已有 warehouseId → 覆盖为 default
 * - 不修改传入的原始字符串 (纯函数)
 */
export function withWarehouseParam(url: string): string {
  const qIdx = url.indexOf('?')
  if (qIdx === -1) {
    return `${url}?warehouseId=${encodeURIComponent(DEFAULT_WAREHOUSE_ID)}`
  }

  const base = url.slice(0, qIdx)
  const query = url.slice(qIdx + 1)
  const params = new URLSearchParams(query)
  params.set('warehouseId', DEFAULT_WAREHOUSE_ID)
  return `${base}?${params.toString()}`
}

/**
 * 为 JSON 写入体追加 warehouseId 字段.
 *
 * - 接受普通对象, 返回新对象 (不变异入参)
 * - 如果 body 不是可合并的 plain object, 原样返回
 */
export function withWarehouseBody<T extends Record<string, unknown>>(
  body: T,
): T & { warehouseId: string } {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return body as unknown as T & { warehouseId: string }
  }
  return { ...body, warehouseId: DEFAULT_WAREHOUSE_ID } as T & { warehouseId: string }
}

/**
 * 从 API 返回的 warehouse 元数据中解析显示名.
 *
 * 优先使用服务端 name; 空值 / 非字符串 / 未知 → 回退到本地 DEFAULT_WAREHOUSE_NAME.
 */
export function resolveWarehouseDisplayName(
  warehouse: unknown,
): string {
  if (warehouse != null && typeof warehouse === 'object' && !Array.isArray(warehouse)) {
    const name = (warehouse as Record<string, unknown>).name
    if (typeof name === 'string' && name.trim()) return name
  }
  return DEFAULT_WAREHOUSE_NAME
}
