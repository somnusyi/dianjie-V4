import {afterAll, expect, it} from 'vitest'
import {prisma} from '@dianjie/db'
import {browserSessionClock, nextBrowserSessionOrder} from '../../src/services/browserSessionOrder'

const url = new URL(process.env.DATABASE_URL!)
if (url.hostname !== '127.0.0.1' || url.port !== '15449' || url.pathname !== '/dianjie_four_gap_test') throw Error('Dedicated synthetic database required')
afterAll(() => prisma.$disconnect())

it('serializes real concurrent issuance with unique orders and nondecreasing database times', async () => {
  const before = await browserSessionClock()
  const issued = await Promise.all(Array.from({length:40}, () => nextBrowserSessionOrder()))
  const ordered = issued.sort((a,b) => BigInt(a.order) < BigInt(b.order) ? -1 : 1)
  expect(new Set(ordered.map(x => x.order)).size).toBe(40)
  for (let i=0;i<ordered.length;i++) {
    expect(BigInt(ordered[i].order) > BigInt(i ? ordered[i-1].order : before.order)).toBe(true)
    expect(ordered[i].issuedAtMs).toBeGreaterThanOrEqual(i ? ordered[i-1].issuedAtMs : before.issuedAtMs)
    expect(ordered[i].legacyExpiresAtMs).toBe(before.legacyExpiresAtMs)
  }
  const after = await browserSessionClock()
  expect(after.order).toBe(ordered.at(-1)!.order)
  expect(after.issuedAtMs).toBeGreaterThanOrEqual(ordered.at(-1)!.issuedAtMs)
  const rows = await prisma.$queryRaw<Array<{count:bigint}>>`SELECT count(*) FROM "BrowserSessionClock"`
  expect(rows[0].count).toBe(1n)
})
