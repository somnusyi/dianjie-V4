import { apiFetch } from './v2-auth'

type VoucherPage<T> = { items: T[]; total: number; page: number; pageSize: number }

/** Read every legal page; a failed or changing list must never become a partial month. */
export async function loadVouchers<T extends { id: string }>(from: string, to: string, status: string): Promise<T[]> {
  const rows: T[] = []
  const seen = new Set<string>()
  let total: number | undefined
  for (let page = 1; page <= 1000; page++) {
    const query = new URLSearchParams({ from, to, status, page: String(page), pageSize: '200' })
    const data = await apiFetch<VoucherPage<T>>(`/api/vouchers?${query}`)
    if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0 ||
        data.page !== page || data.pageSize !== 200 || data.items.length > 200 ||
        (total !== undefined && data.total !== total)) {
      throw new Error('凭证未完整加载或已变化，请刷新后重试')
    }
    total = data.total
    for (const row of data.items) {
      if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id)) {
        throw new Error('凭证分页重复或无效，请刷新后重试')
      }
      seen.add(row.id)
      rows.push(row)
    }
    if (rows.length === total) return rows
    if (rows.length > total || data.items.length < 200) throw new Error('凭证未完整加载，请刷新后重试')
  }
  throw new Error('凭证数量较多，未能完整读取，请联系管理员处理')
}

/** Count-only surfaces use the server total rather than the first page length. */
export async function loadVoucherCount(from: string, to: string, status: string): Promise<number> {
  const query = new URLSearchParams({ from, to, status, page: '1', pageSize: '1' })
  const data = await apiFetch<VoucherPage<{ id: string }>>(`/api/vouchers?${query}`)
  if (!data || !Number.isSafeInteger(data.total) || data.total < 0 || data.page !== 1 || data.pageSize !== 1) {
    throw new Error('凭证数量读取不完整，请刷新后重试')
  }
  return data.total
}
