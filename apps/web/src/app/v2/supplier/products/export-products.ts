/**
 * 供应商商品工作台 · 导出当前结果
 *
 * 纯函数部分，方便单测覆盖 URL 编码、文件名、保存与失败路径。
 */

export type DownloadApi = (path: string, fallbackFilename: string) => Promise<{ blob: Blob; filename: string }>
export type SaveBlob = (blob: Blob, filename: string) => void

export function buildProductExportSearch(
  q: string,
  category: string,
  status: string,
  categoryId?: string,
): string {
  const params = new URLSearchParams()
  if (q.trim()) params.set('q', q.trim())
  if (categoryId) {
    params.set('categoryId', categoryId)
  } else if (category) {
    params.set('category', category)
  }
  if (status) params.set('status', status)
  return params.toString()
}

export function productExportFilename(date = new Date()): string {
  const china = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
  return `商品报价表_${china.replace(/\//g, '-')}.csv`
}

/** 触发浏览器下载；Safari 需要延迟 revokeObjectURL 才能完整保留文件。 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function downloadProductExport(
  apiDownload: DownloadApi,
  saveBlob: SaveBlob,
  q: string,
  category: string,
  status: string,
  date = new Date(),
  categoryId?: string,
): Promise<void> {
  const search = buildProductExportSearch(q, category, status, categoryId)
  const path = '/api/products/export.csv' + (search ? `?${search}` : '')
  const { blob, filename } = await apiDownload(path, productExportFilename(date))
  saveBlob(blob, filename)
}
