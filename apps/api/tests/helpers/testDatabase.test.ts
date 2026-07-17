import { describe, expect, it } from 'vitest'
import { databaseName, isSafeTestDatabaseUrl } from './testDatabase'

describe('integration database guard', () => {
  it('accepts only explicit test or CI database names', () => {
    expect(isSafeTestDatabaseUrl('postgresql://u:p@localhost:5432/dianjie_test')).toBe(true)
    expect(isSafeTestDatabaseUrl('postgresql://u:p@localhost:5432/dianjie_ci?schema=public')).toBe(true)
    expect(isSafeTestDatabaseUrl('postgresql://u:p@localhost:5432/dianjie')).toBe(false)
    expect(isSafeTestDatabaseUrl('postgresql://u:p@localhost:5432/postgres')).toBe(false)
  })

  it('rejects missing and malformed URLs', () => {
    expect(isSafeTestDatabaseUrl(undefined)).toBe(false)
    expect(isSafeTestDatabaseUrl('not-a-url')).toBe(false)
    expect(databaseName(undefined)).toBeNull()
  })
})
