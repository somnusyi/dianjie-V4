import { Prisma, prisma } from '@dianjie/db'

async function numberFloor(client: Pick<Prisma.TransactionClient, '$queryRaw' | 'businessSequence'>, tenantId: string) {
  const rows = await client.$queryRaw<Array<{ highest: string | null }>>`SELECT max(substring("no" from 4)::numeric)::text AS highest FROM suppliers WHERE "tenantId" = ${tenantId} AND "no" ~ '^SUP[0-9]+$'`
  const sequence = await client.businessSequence.findUnique({ where: { tenantId_scope_period: { tenantId, scope: 'SUP', period: 'ALL' } } })
  const historical = BigInt(rows[0]?.highest || '0')
  const recorded = BigInt(sequence?.value || 0)
  return historical > recorded ? historical : recorded
}
function format(value: bigint) { return `SUP${value.toString().padStart(3, '0')}` }
export async function suggestSupplierNumber(tenantId: string) {
  return format(await numberFloor(prisma, tenantId) + 1n)
}
export async function allocateSupplierNumber(tx: Prisma.TransactionClient, tenantId: string, manual?: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier-number:${tenantId}`}))`
  const floor = await numberFloor(tx, tenantId)
  const suffix = manual?.match(/^SUP([0-9]+)$/)?.[1]
  const number = manual === undefined ? floor + 1n : suffix ? BigInt(suffix) : floor
  const no = manual ?? format(number)
  if (no.length > 40) throw Object.assign(new Error('供应商编号已达到现有字段容量，请检查编号资料'), { statusCode: 409 })
  const high = number > floor ? number : floor
  // BusinessSequence is Int. Legal long custom identifiers remain supported:
  // saturate its high-water mark and always include persisted identifiers in the floor.
  const value = Number(high > 2147483647n ? 2147483647n : high)
  await tx.businessSequence.upsert({ where: { tenantId_scope_period: { tenantId, scope: 'SUP', period: 'ALL' } }, create: { tenantId, scope: 'SUP', period: 'ALL', value }, update: { value } })
  return no
}
