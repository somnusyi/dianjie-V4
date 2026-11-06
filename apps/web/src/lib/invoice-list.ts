import { apiFetch } from './v2-auth'

/** Only expose a complete visible set; a failed or repeated page is never a total. */
export async function loadInvoices<T extends { id: string }>(status?: string): Promise<T[]> {
  const result: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const query = new URLSearchParams()
    if (status) query.set('status', status)
    if (cursor) query.set('cursor', cursor)
    const page = await apiFetch<T[]>(`/api/invoices${query.size ? `?${query}` : ''}`)
    if (!Array.isArray(page) || page.length > 50) throw new Error('发票未完整加载，请刷新重试')
    for (const item of page) {
      if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) throw new Error('发票未完整加载，请刷新重试')
      seen.add(item.id)
      result.push(item)
    }
    if (page.length < 50) return result
    cursor = page[page.length - 1].id
  }
  throw new Error('发票记录较多，未能完整读取，请联系管理员处理')
}
