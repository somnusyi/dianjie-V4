export function databaseName(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return null
  try {
    const pathname = new URL(databaseUrl).pathname.replace(/^\//, '')
    return pathname || null
  } catch {
    return null
  }
}

export function isSafeTestDatabaseUrl(databaseUrl: string | undefined): boolean {
  const name = databaseName(databaseUrl)
  return Boolean(name && /(?:_test|_ci)$/i.test(name))
}
