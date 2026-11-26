import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '@dianjie/db'
import { upstreamProcurementRoutes } from '../../src/routes/upstreamProcurement'

let app: ReturnType<typeof Fastify>, tenantId: string, foreignTenantId: string
let supplierA: string, supplierB: string, foreignId: string, hiddenId: string
let aIds: string[], bIds: string[]
const headers = (supplier = supplierA, role = 'SUPPLIER_OWNER') => ({ 'x-supplier': supplier, 'x-role': role })
const base = '/api/upstream/settlement-statements'
beforeAll(async () => {
  vi.stubEnv('UPSTREAM_PROCUREMENT_ENABLED', 'true')
  tenantId = (await prisma.tenant.create({ data: { slug: `pages-${randomUUID()}`, name: '结算核对机构' } })).id
  foreignTenantId = (await prisma.tenant.create({ data: { slug: `pages-other-${randomUUID()}`, name: '另一结算机构' } })).id
  supplierA = (await prisma.supplier.create({ data: { tenantId, no: 'A', name: '云岭食材' } })).id
  supplierB = (await prisma.supplier.create({ data: { tenantId, no: 'B', name: '山川食材' } })).id
  const foreignSupplier = (await prisma.supplier.create({ data: { tenantId: foreignTenantId, no: 'C', name: '远山食材' } })).id
  const row = (supplierId: string, version: number, no: string) => ({ tenantId, supplierId, no, version, status: 'SENT_TO_SUPPLIER' as const, periodStart: new Date('2026-10-01T00:00:00Z'), periodEnd: new Date('2026-10-31T00:00:00Z'), payableAmount: '13.01', createdById: 'local-fixture', buyerConfirmedAt: new Date('2026-10-18T04:00:00Z') })
  await prisma.upstreamSettlementStatement.createMany({ data: [
    ...Array.from({ length: 201 }, (_, i) => row(supplierA, i + 1, `A-${i + 1}`)),
    ...Array.from({ length: 200 }, (_, i) => row(supplierB, i + 1, `B-${i + 1}`)),
  ] })
  aIds = (await prisma.upstreamSettlementStatement.findMany({ where: { tenantId, supplierId: supplierA }, orderBy: [{ periodEnd: 'desc' }, { version: 'desc' }, { id: 'desc' }], select: { id: true } })).map(x => x.id)
  bIds = (await prisma.upstreamSettlementStatement.findMany({ where: { tenantId, supplierId: supplierB }, orderBy: [{ periodEnd: 'desc' }, { version: 'desc' }, { id: 'desc' }], select: { id: true } })).map(x => x.id)
  hiddenId = (await prisma.upstreamSettlementStatement.create({ data: { ...row(supplierA, 202, 'A-DRAFT'), status: 'DRAFT', buyerConfirmedAt: null } })).id
  foreignId = (await prisma.upstreamSettlementStatement.create({ data: { ...row(foreignSupplier, 1, 'C-1'), tenantId: foreignTenantId } })).id
  app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = { tenantId, role: req.headers['x-role'], supplierId: req.headers['x-supplier'], userId: 'local-fixture' } })
  await app.register(upstreamProcurementRoutes, { prefix: '/api/upstream' })
  await app.ready()
})
afterAll(async () => {
  await app?.close()
  for (const id of [tenantId, foreignTenantId].filter(Boolean)) {
    await prisma.upstreamSettlementStatement.deleteMany({ where: { tenantId: id } })
    await prisma.supplier.deleteMany({ where: { tenantId: id } })
    await prisma.tenant.delete({ where: { id } })
  }
  vi.unstubAllEnvs()
  await prisma.$disconnect()
})
describe('upstream settlement cursor scope', () => {
  it.each(['SUPPLIER_OWNER', 'SUPPLIER_STAFF'])('%s reads all 201 own records without drafts or duplicates', async role => {
    const first = await app.inject({ url: base, headers: headers(supplierA, role) })
    expect(first.statusCode).toBe(200)
    expect(first.json().map((x: any) => x.id)).toEqual(aIds.slice(0, 200))
    const next = await app.inject({ url: `${base}?cursor=${aIds[199]}`, headers: headers(supplierA, role) })
    expect(next.statusCode).toBe(200)
    expect(next.json().map((x: any) => x.id)).toEqual(aIds.slice(200))
  })
  it('an exact 200 row list ends with an empty next page', async () => {
    const next = await app.inject({ url: `${base}?cursor=${bIds[199]}`, headers: headers(supplierB) })
    expect(next.statusCode).toBe(200)
    expect(next.json()).toEqual([])
  })
  it('query supplierId cannot replace the authenticated company even after cursor', async () => {
    const result = await app.inject({ url: `${base}?supplierId=${supplierB}&cursor=${aIds[199]}`, headers: headers() })
    expect(result.statusCode).toBe(200)
    expect(result.json().map((x: any) => x.id)).toEqual(aIds.slice(200))
  })
  it.each(['supplier', 'tenant', 'draft', 'missing'])('rejects a %s cursor outside the visible set', async kind => {
    const cursor = kind === 'supplier' ? bIds[0] : kind === 'tenant' ? foreignId : kind === 'draft' ? hiddenId : randomUUID()
    const result = await app.inject({ url: `${base}?cursor=${cursor}`, headers: headers() })
    expect(result.statusCode).toBe(409)
    expect(result.json().error).toContain('刷新')
  })
  it('rejects malformed cursor values', async () => {
    expect((await app.inject({ url: `${base}?cursor=`, headers: headers() })).statusCode).toBe(400)
  })
  it('keeps the old array response and stable complete internal ordering', async () => {
    const expected = await prisma.upstreamSettlementStatement.findMany({ where: { tenantId }, orderBy: [{ periodEnd: 'desc' }, { version: 'desc' }, { id: 'desc' }], select: { id: true } })
    const result: string[] = []
    let cursor = ''
    for (let n = 0; n < 3; n++) {
      const page = await app.inject({ url: base + (cursor ? `?cursor=${cursor}` : ''), headers: headers('', 'FINANCE') })
      expect(page.statusCode).toBe(200)
      expect(Array.isArray(page.json())).toBe(true)
      result.push(...page.json().map((x: any) => x.id))
      cursor = result[result.length - 1]
    }
    expect(result).toEqual(expected.map(x => x.id))
    expect(result).toContain(hiddenId)
    expect(result).not.toContain(foreignId)
  })
})
