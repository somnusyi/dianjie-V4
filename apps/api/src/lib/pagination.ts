export function parseBoundedInteger(
  value: unknown,
  { defaultValue, min = 1, max }: { defaultValue: number; min?: number; max: number },
): number | null {
  if (value === undefined || value === null || value === '') return defaultValue
  const normalized = typeof value === 'string' ? value.trim() : value
  if (normalized === '') return defaultValue
  const parsed = typeof normalized === 'number' ? normalized : Number(normalized)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null
  return parsed
}

export function parsePagination(
  query: Record<string, unknown> | undefined,
  { defaultPageSize, maxPageSize, maxPage = 100_000 }: {
    defaultPageSize: number
    maxPageSize: number
    maxPage?: number
  },
): { page: number; pageSize: number } | null {
  const page = parseBoundedInteger(query?.page, { defaultValue: 1, max: maxPage })
  const pageSize = parseBoundedInteger(query?.pageSize, { defaultValue: defaultPageSize, max: maxPageSize })
  return page === null || pageSize === null ? null : { page, pageSize }
}
