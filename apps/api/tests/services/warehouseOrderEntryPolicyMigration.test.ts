import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../../../..')
const schema = readFileSync(resolve(repoRoot, 'packages/db/prisma/schema.prisma'), 'utf8')
const migration = readFileSync(resolve(
  repoRoot,
  'packages/db/prisma/migrations/20260922090000_warehouse_order_entry_stock_policy/migration.sql',
), 'utf8')

describe('warehouse order-entry stock policy migration contract', () => {
  it('defines a non-null Prisma boolean whose steady-state default is reminder-only', () => {
    expect(schema).toMatch(/blockZeroStockAtOrderEntry\s+Boolean\s+@default\(false\)/)
    expect(schema).not.toMatch(/blockZeroStockAtOrderEntry\s+Boolean\?/)
  })

  it('adds the compatibility-safe reminder-only default as non-null in one statement', () => {
    expect(migration).toContain(
      'ADD COLUMN "blockZeroStockAtOrderEntry" BOOLEAN NOT NULL DEFAULT false;',
    )
    expect(migration).not.toMatch(/UPDATE\s+"warehouses"/i)
    expect(migration).not.toMatch(/inventoryMode"\s*=\s*'STRICT'/i)
  })

  it('does not rewrite ledger mode, activation state, or destructive warehouse data', () => {
    expect(migration).not.toMatch(/SET\s+"inventoryMode"/i)
    expect(migration).not.toMatch(/SET\s+"inventoryActivatedAt"/i)
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN)/i)
  })
})
