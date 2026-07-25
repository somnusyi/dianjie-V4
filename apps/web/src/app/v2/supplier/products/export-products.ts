export type ProductExportFilters = {
  searchQ: string
  categoryFilter: string
  statusFilter: string
}

/**
 * 根据当前筛选条件构造后端 CSV 导出地址。
 * 空值字段不会出现在查询串里，避免给后端发送无意义参数。
 */
export function buildProductExportUrl(filters: ProductExportFilters): string {
  const params = new URLSearchParams()
  const q = filters.searchQ?.trim()
  if (q) params.set('q', q)
  if (filters.categoryFilter) params.set('category', filters.categoryFilter)
  if (filters.statusFilter) params.set('status', filters.statusFilter)
  const query = params.toString()
  return `/api/products/export.csv${query ? `?${query}` : ''}`
}

/** 触发浏览器下载一个 Blob 文件，使用完后立即释放对象 URL。 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export type ProductExportDownloader = (
  path: string,
  fallbackFilename: string,
) => Promise<{ blob: Blob; filename: string }>

/**
 * 根据当前筛选条件请求已认证的 CSV 导出，并触发浏览器下载。
 * downloader 参数默认为 apiDownload，可被测试注入。
 */
export async function downloadProductExport(
  filters: ProductExportFilters,
  downloader: ProductExportDownloader,
) {
  const url = buildProductExportUrl(filters)
  const { blob, filename } = await downloader(url, '商品报价表.csv')
  downloadBlob(blob, filename)
}
