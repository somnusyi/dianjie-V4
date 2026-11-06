import { apiFetch } from './v2-auth'

const PAGE_SIZE = 200
const INCOMPLETE = '对账单未完整加载，请刷新重试'

/** Keep the array contract while reading every page before exposing totals. */
export async function loadUpstreamSettlementStatements<T extends { id: string }>(): Promise<T[]> {
  const result: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await apiFetch<T[]>(`/api/upstream/settlement-statements${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
    if (!Array.isArray(page) || page.length > PAGE_SIZE) throw new Error(INCOMPLETE)
    for (const item of page) {
      // Also reject an old API that ignores cursor, rather than reporting a partial total.
      if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) throw new Error(INCOMPLETE)
      seen.add(item.id)
      result.push(item)
    }
    if (page.length < PAGE_SIZE) return result
    cursor = page[page.length - 1].id
  }
  throw new Error('对账单记录较多，未能完整读取，请联系管理员处理')
}
