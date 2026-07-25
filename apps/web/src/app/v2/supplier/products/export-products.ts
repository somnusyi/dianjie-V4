/**
 * 供应商商品工作台 · 导出当前结果
 *
 * 纯函数部分，方便单测覆盖 URL 编码、文件名和失败路径。
 */

export type DownloadApi = (path: string, fallbackFilename: string) => Promise<{ blob: Blob; filename: string }>
export type SaveBlob = (blob: Blob, filename: string) => void

export function buildProductExportSearch(q: string, category: string, status: string): string {
  const params = new URLSearchParams()
  if (q.trim()) params.set('q', q.trim())
  if (category) params.set('category', category)
  if (status) params.set('status', status)
  return params.toString()
}

export function productExportFilename(date = new Date()): string {
  return `商品报价表_${date.toISOString().slice(0, 10)}.csv`
}

export async function downloadProductExport(
  apiDownload: DownloadApi,
  saveBlob: SaveBlob,
  q: string,
  category: string,
  status: string,
  date = new Date(),
): Promise<void> {
  const search = buildProductExportSearch(q, category, status)
  const path = '/api/products/export.csv' + (search ? `?${search}` : '')
  const { blob, filename } = await apiDownload(path, productExportFilename(date))
  saveBlob(blob, filename)
}
