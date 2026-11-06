import { prisma } from '@dianjie/db'
export type BrowserSessionClock = { order: string; issuedAtMs: number; legacyExpiresAtMs: number }
/** One persisted row serializes sequence issuance and a nondecreasing DB clock across all API processes. */
export async function browserSessionClock(issue = false): Promise<BrowserSessionClock> {
  const rows = await prisma.$queryRaw<Array<{ value: bigint; issuedAtMs: bigint; legacyExpiresAtMs: bigint; rollback: boolean }>>`
    UPDATE "BrowserSessionClock" SET
      "lastOrder" = CASE WHEN ${issue} THEN nextval('browser_session_intent_seq') ELSE "lastOrder" END,
      "logicalTimeMs" = GREATEST("logicalTimeMs", FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
    WHERE "id" = true
    RETURNING "lastOrder" AS value, "logicalTimeMs" AS "issuedAtMs", "legacyExpiresAtMs",
      FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint < "logicalTimeMs" AS rollback`
  const row = rows[0]
  if (!row || typeof row.value !== 'bigint' || (issue && row.value < 1n) || row.rollback || !Number.isSafeInteger(Number(row.issuedAtMs)) || !Number.isSafeInteger(Number(row.legacyExpiresAtMs)))
    throw Object.assign(new Error('浏览器会话时钟暂不可用，请稍后重试'), { statusCode: 503 })
  return { order: row.value.toString(), issuedAtMs: Number(row.issuedAtMs), legacyExpiresAtMs: Number(row.legacyExpiresAtMs) }
}
export async function nextBrowserSessionOrder(): Promise<BrowserSessionClock> { return browserSessionClock(true) }
