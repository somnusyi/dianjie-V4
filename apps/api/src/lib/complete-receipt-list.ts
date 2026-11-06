/** Complete existing list contracts without silently treating a first page as the whole balance. */
export async function readCompleteReceiptList<T extends { id: string }>(
  readPage: (cursor?: string) => Promise<T[]>, pageSize: number, maxPages = 100,
): Promise<T[]> {
  const result: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const rows = await readPage(cursor)
    if (rows.length > pageSize || rows.some(row => !row.id || seen.has(row.id))) {
      throw Object.assign(new Error('待开票清单读取不完整，请刷新重试'), { statusCode: 503 })
    }
    for (const row of rows) {
      if (seen.has(row.id)) throw Object.assign(new Error('待开票清单读取不完整，请刷新重试'), { statusCode: 503 })
      seen.add(row.id); result.push(row)
    }
    if (rows.length < pageSize) return result
    cursor = rows.at(-1)!.id
  }
  throw Object.assign(new Error('待开票资料量过大，请联系管理员分批核对'), { statusCode: 503 })
}
