import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '@dianjie/db'
import { upstreamProcurementRoutes } from '../../src/routes/upstreamProcurement'

let app: ReturnType<typeof Fastify>, tenantId: string, foreignTenantId: string, supplier: string, otherSupplier: string, uploader: string
let version = 0
const base = '/api/upstream/settlement-statements'
const headers = (role = 'FINANCE') => ({ 'x-role': role })
async function statement(amount = '100.1234', status: 'LOCKED' | 'CONFIRMED' = 'LOCKED', tenant = tenantId, company = supplier) {
  return prisma.upstreamSettlementStatement.create({ data: { tenantId: tenant, supplierId: company, no: `ST-${++version}`, version, status, periodStart: new Date('2026-10-01Z'), periodEnd: new Date('2026-10-31Z'), payableAmount: amount, createdById: uploader } })
}
async function invoice(amount = '100.13', status: 'VERIFIED' | 'PENDING' | 'REJECTED' = 'VERIFIED', tenant = tenantId, company = supplier) {
  return prisma.invoice.create({ data: { tenantId: tenant, supplierId: company, invoiceNo: randomUUID(), amount, status, issueDate: new Date('2026-10-01Z'), fileUrl: '', uploadedById: uploader } })
}
const allocate = (statementId: string, invoiceId: string, amount: unknown, role = 'FINANCE') => app.inject({ method: 'POST', url: `${base}/${statementId}/invoices`, headers: headers(role), payload: { invoiceId, amount } })
beforeAll(async () => {
  vi.stubEnv('UPSTREAM_PROCUREMENT_ENABLED', 'true')
  tenantId = (await prisma.tenant.create({ data: { slug: `allocation-${randomUUID()}`, name: '结算分摊核对机构' } })).id
  foreignTenantId = (await prisma.tenant.create({ data: { slug: `allocation-other-${randomUUID()}`, name: '另一分摊机构' } })).id
  supplier = (await prisma.supplier.create({ data: { tenantId, no: 'A', name: '云岭食材' } })).id
  otherSupplier = (await prisma.supplier.create({ data: { tenantId, no: 'B', name: '山川食材' } })).id
  uploader = (await prisma.user.create({ data: { tenantId, email: `${randomUUID()}@local.invalid`, password: '!no-login-fixture', name: '结算经办', role: 'FINANCE' } })).id
  app = Fastify()
  app.decorate('authenticate', async (req: any) => { req.user = { tenantId, role: req.headers['x-role'], userId: uploader, supplierId: supplier } })
  await app.register(upstreamProcurementRoutes, { prefix: '/api/upstream' })
  await app.ready()
})
afterAll(async () => {
  await app?.close()
  for (const id of [tenantId, foreignTenantId].filter(Boolean)) {
    await prisma.upstreamSettlementInvoiceAllocation.deleteMany({ where: { tenantId: id } })
    await prisma.upstreamSettlementStatement.deleteMany({ where: { tenantId: id } })
    await prisma.invoice.deleteMany({ where: { tenantId: id } })
    await prisma.user.deleteMany({ where: { tenantId: id } })
    await prisma.supplier.deleteMany({ where: { tenantId: id } })
    await prisma.tenant.delete({ where: { id } })
  }
  vi.unstubAllEnvs()
  await prisma.$disconnect()
})
describe('upstream invoice allocation boundaries (API-only, no UI claim)', () => {
  it('partial then separate final invoice preserves four decimal amounts and changes only final status', async () => {
    const st = await statement(), a = await invoice('40.12'), b = await invoice('60.01')
    const first = await allocate(st.id, a.id, '40.12')
    expect(first.statusCode).toBe(200)
    expect(first.json().status).toBe('LOCKED')
    const last = await allocate(st.id, b.id, '60.0034')
    expect(last.statusCode).toBe(200)
    expect(last.json().status).toBe('INVOICED')
    expect(last.json().payableAmount).toBe('100.1234')
    const rows = await prisma.upstreamSettlementInvoiceAllocation.findMany({ where: { statementId: st.id }, orderBy: { amount: 'asc' } })
    expect(rows.map(x => x.amount.toString())).toEqual(['40.12', '60.0034'])
    expect(rows.every(x => x.createdById === uploader)).toBe(true)
  })
  it.each(['SUPPLY_CHAIN', 'SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'MANAGER', 'KITCHEN_LEAD', 'ADMIN'])('%s cannot allocate', async role => {
    const st = await statement(), inv = await invoice()
    expect((await allocate(st.id, inv.id, 1, role)).statusCode).toBe(403)
    expect(await prisma.upstreamSettlementInvoiceAllocation.count({ where: { statementId: st.id } })).toBe(0)
  })
  it.each(['PENDING', 'REJECTED'] as const)('refuses %s invoices', async status => {
    const st = await statement(), inv = await invoice('100.13', status)
    expect((await allocate(st.id, inv.id, 1)).statusCode).toBe(400)
    expect(await prisma.upstreamSettlementInvoiceAllocation.count({ where: { statementId: st.id } })).toBe(0)
  })
  it('rejects another supplier invoice and a foreign statement without allocations', async () => {
    const st = await statement(), inv = await invoice('100.13', 'VERIFIED', tenantId, otherSupplier)
    expect((await allocate(st.id, inv.id, 1)).statusCode).toBe(400)
    const foreignCompany = await prisma.supplier.create({ data: { tenantId: foreignTenantId, no: 'C', name: '远山食材' } })
    const foreign = await statement('100', 'LOCKED', foreignTenantId, foreignCompany.id)
    expect((await allocate(foreign.id, inv.id, 1)).statusCode).toBe(409)
    expect(await prisma.upstreamSettlementInvoiceAllocation.count({ where: { statementId: { in: [st.id, foreign.id] } } })).toBe(0)
  })
  it('rejects unlocked statement, zero, negative and excess balances atomically', async () => {
    const unlocked = await statement('100', 'CONFIRMED'), inv = await invoice('50')
    expect((await allocate(unlocked.id, inv.id, 1)).statusCode).toBe(409)
    const st = await statement('40')
    for (const amount of [0, -1, 41]) expect((await allocate(st.id, inv.id, amount)).statusCode).toBe(400)
    const st2 = await statement('100')
    expect((await allocate(st2.id, inv.id, 51)).statusCode).toBe(400)
    expect(await prisma.upstreamSettlementInvoiceAllocation.count({ where: { statementId: { in: [unlocked.id, st.id, st2.id] } } })).toBe(0)
  })
  it('one invoice balance is shared across statements and cannot be allocated twice beyond its amount', async () => {
    const a = await statement('60'), b = await statement('60'), inv = await invoice('100')
    expect((await allocate(a.id, inv.id, 60)).statusCode).toBe(200)
    expect((await allocate(b.id, inv.id, 41)).statusCode).toBe(400)
    expect((await allocate(b.id, inv.id, 40)).statusCode).toBe(200)
    const rows = await prisma.upstreamSettlementInvoiceAllocation.findMany({ where: { invoiceId: inv.id } })
    expect(rows.map(x => Number(x.amount)).reduce((a, b) => a + b, 0)).toBe(100)
    expect((await prisma.upstreamSettlementStatement.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('LOCKED')
  })
  it.each(['0.99999', '0.00001'])('rejects amount %s beyond storage precision without silently rounding', async amount => {
    const st = await statement('1'), inv = await invoice('1')
    const response = await allocate(st.id, inv.id, amount)
    expect(response.statusCode).toBe(400)
    expect(await prisma.upstreamSettlementInvoiceAllocation.count({ where: { statementId: st.id } })).toBe(0)
    expect((await prisma.upstreamSettlementStatement.findUniqueOrThrow({ where: { id: st.id } })).status).toBe('LOCKED')
  })

  it('same pair exact replay returns original allocation; changed amount is a conflict', async () => {
    const st = await statement('100'), inv = await invoice('100')
    expect((await allocate(st.id, inv.id, '20')).statusCode).toBe(200)
    expect((await allocate(st.id, inv.id, '20')).statusCode).toBe(200)
    expect((await allocate(st.id, inv.id, '30')).statusCode).toBe(409)
    const rows = await prisma.upstreamSettlementInvoiceAllocation.findMany({ where: { statementId: st.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].amount.toString()).toBe('20')
  })
  it('fully allocated pair exact replay still returns original success', async () => {
    const st = await statement('10'), inv = await invoice('10')
    expect((await allocate(st.id, inv.id, '10')).statusCode).toBe(200)
    expect((await allocate(st.id, inv.id, '10')).statusCode).toBe(200)
    expect(await prisma.upstreamSettlementInvoiceAllocation.count({ where: { statementId: st.id } })).toBe(1)
    expect((await prisma.upstreamSettlementStatement.findUniqueOrThrow({ where: { id: st.id } })).status).toBe('INVOICED')
  })
  it('competing statements cannot overallocate one invoice or return an internal server error', async () => {
    const a = await statement('60'), b = await statement('60'), inv = await invoice('100')
    const responses = await Promise.all([allocate(a.id, inv.id, '60'), allocate(b.id, inv.id, '60')])
    expect(responses.filter(x => x.statusCode === 200)).toHaveLength(1)
    expect(responses.every(x => [200, 400, 409].includes(x.statusCode))).toBe(true)
    const rows = await prisma.upstreamSettlementInvoiceAllocation.findMany({ where: { invoiceId: inv.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].amount.toString()).toBe('60')
  })

  it('concurrent exact same pair has one row and success or refresh conflict, never 500', async () => {
    const st = await statement('100'), inv = await invoice('100')
    const responses = await Promise.all(Array.from({ length: 4 }, () => allocate(st.id, inv.id, '20')))
    expect(responses.some(x => x.statusCode === 200)).toBe(true)
    expect(responses.every(x => [200, 409].includes(x.statusCode))).toBe(true)
    expect(await prisma.upstreamSettlementInvoiceAllocation.count({ where: { statementId: st.id } })).toBe(1)
  })

  it('rejects a verified invoice from another tenant against an owned statement', async () => {
    const foreignCompany = await prisma.supplier.create({ data: { tenantId: foreignTenantId, no: `F-${++version}`, name: '远川食材' } })
    const foreignUser = await prisma.user.create({ data: { tenantId: foreignTenantId, email: `${randomUUID()}@local.invalid`, password: '!no-login-fixture', name: '票据经办', role: 'FINANCE' } })
    const inv = await prisma.invoice.create({ data: { tenantId: foreignTenantId, supplierId: foreignCompany.id, invoiceNo: randomUUID(), amount: '100', status: 'VERIFIED', issueDate: new Date('2026-10-01Z'), fileUrl: '', uploadedById: foreignUser.id } })
    const st = await statement('100')
    expect((await allocate(st.id, inv.id, '1')).statusCode).toBe(400)
    expect(await prisma.upstreamSettlementInvoiceAllocation.count({ where: { OR: [{ statementId: st.id }, { invoiceId: inv.id }] } })).toBe(0)
  })
  it('allows SUPER_ADMIN within the same tenant and supplier', async () => {
    const st = await statement('0.0001'), inv = await invoice('1')
    expect((await allocate(st.id, inv.id, '1e-4', 'SUPER_ADMIN')).statusCode).toBe(200)
    expect((await prisma.upstreamSettlementStatement.findUniqueOrThrow({ where: { id: st.id } })).status).toBe('INVOICED')
  })
  it.each(['1e-5', '9999999999999999', 'NaN', 'Infinity'])('invalid or excess amount %s leaves no allocation', async amount => {
    const st = await statement('100'), inv = await invoice('100')
    expect((await allocate(st.id, inv.id, amount)).statusCode).toBe(400)
    expect(await prisma.upstreamSettlementInvoiceAllocation.count({ where: { statementId: st.id } })).toBe(0)
  })

})
