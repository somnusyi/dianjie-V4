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
 * 为内部供应链库存写入 URL 追加 supplierId 与 warehouseId=default.
 *
 * - 总是追加/覆盖 supplierId
 * - 总是追加/覆盖 warehouseId=default
 * - 保留 URL 中其它既有参数
 * - 不修改传入的原始字符串 (纯函数)
 */
export function withSupplierWarehouseParams(url: string, supplierId: string): string {
  const normalizedSupplierId = supplierId.trim()
  if (!normalizedSupplierId) {
    throw new Error('入库前必须选择供应商')
  }
  const qIdx = url.indexOf('?')
  const base = qIdx === -1 ? url : url.slice(0, qIdx)
  const query = qIdx === -1 ? '' : url.slice(qIdx + 1)
  const params = new URLSearchParams(query)
  params.set('supplierId', normalizedSupplierId)
  params.set('warehouseId', DEFAULT_WAREHOUSE_ID)
  return `${base}?${params.toString()}`
}

/** 入库响应中仓库字段的合法形状 */
export interface InboundWarehouseResult {
  warehouseId: string
  warehouseName: string
}

/**
 * 校验入库接口成功响应必须包含真实仓库信息.
 *
 * 要求:
 *   - response.warehouseId 为非空字符串且不能仍是别名 'default'
 *   - response.warehouse 为对象, 其 id 与 warehouseId 一致且非空
 *   - response.warehouse.name 为非空字符串
 *
 * 校验失败时抛出 Error, 调用方应视为写入失败, 不展示成功文案、不清空表单/预览.
 */
export function assertInboundWarehouseResponse(response: unknown): InboundWarehouseResult {
  if (response == null || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('入库响应格式异常：缺少仓库信息')
  }
  const res = response as Record<string, unknown>

  const rawWarehouseId = res.warehouseId
  const warehouseId = typeof rawWarehouseId === 'string' ? rawWarehouseId.trim() : ''
  if (!warehouseId || warehouseId === DEFAULT_WAREHOUSE_ID) {
    throw new Error('入库响应未返回真实仓库 ID')
  }

  const warehouse = res.warehouse
  if (warehouse == null || typeof warehouse !== 'object' || Array.isArray(warehouse)) {
    throw new Error('入库响应缺少仓库元数据')
  }
  const wh = warehouse as Record<string, unknown>

  const rawId = wh.id
  const id = typeof rawId === 'string' ? rawId.trim() : ''
  if (!id || id !== warehouseId) {
    throw new Error('入库响应仓库 ID 不一致')
  }

  const rawName = wh.name
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  if (!name) {
    throw new Error('入库响应缺少仓库名称')
  }

  return { warehouseId: id, warehouseName: name }
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
