import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import ExcelJS from 'exceljs'
import { inventoryManagementRoutes } from '../../src/routes/inventoryManagement'
import { managementPages } from '../../src/services/inventoryManagement'

const fixture = vi.hoisted(() => ({ tx: {} as any }))
vi.mock('@dianjie/db', async original => ({ ...await original<typeof import('@dianjie/db')>(), prisma: { $transaction: (fn: any) => fn(fixture.tx) } }))
const app = Fastify()
const doc = (id: string, tenantId = 'one') => ({ id, tenantId, docNo: `DOC-${id}`, type: 'MANUAL_INBOUND', effectiveAt: new Date('2026-09-01T00:00:00Z'), warehouseId: 'wh', createdById: 'u', totalAmount: 12.5, status: 'CONFIRMED', reviewStatus: 'UNREVIEWED', createdAt: new Date('2026-08-31T16:00:00Z'), note: '测试', reason: '期初入库' })
const get = (id: string, query: Record<string, string> = {}, role = 'SUPPLY_CHAIN', tenantId = 'one') => app.inject({ url: `/api/inventory-management/${id}?${new URLSearchParams(query)}`, headers: { authorization: `Bearer ${app.jwt.sign({ role, tenantId })}` } })
beforeAll(async () => {
  await app.register(jwt, { secret: 'management-local-test-only-key' })
  app.decorate('authenticate', async (req: any) => req.jwtVerify())
  await app.register(inventoryManagementRoutes, { prefix: '/api/inventory-management' })
  await app.ready()
})
beforeEach(() => {
  fixture.tx = {
    tenant: { findUnique: vi.fn(async ({ where }: any) => ({ name: where.id, slug: where.id })) },
    warehouseDoc: { findMany: vi.fn(async ({ where }: any) => [doc('a'), doc('b'), doc('foreign', 'two')].filter(d => (!where.tenantId || d.tenantId === where.tenantId) && (!where.type || d.type === where.type))) },
    warehouse: { findMany: vi.fn(async () => [{ id: 'wh', name: '总仓' }]) },
    user: { findMany: vi.fn(async () => [{ id: 'u', name: '测试员' }]) },
    upstreamReceipt: { findMany: vi.fn(async () => []) }, inventoryCount: { findMany: vi.fn(async () => []) },
    warehouseLedgerBalance: { findMany: vi.fn(async () => []) }, warehouseLedgerMovement: { findMany: vi.fn(async () => []) },
  }
})
afterAll(async () => app.close())

describe('管理表格读取接口', () => {
  it('验证真实 JWT，拒绝未登录与供应商/门店角色，允许内部供应链及管理员', async () => {
    expect((await app.inject('/api/inventory-management/other-in')).statusCode).toBe(401)
    for (const role of ['SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'MANAGER', 'PURCHASER']) expect((await get('other-in', {}, role)).statusCode).toBe(403)
    expect(fixture.tx.warehouseDoc.findMany).not.toHaveBeenCalled()
    for (const role of ['SUPPLY_CHAIN', 'ADMIN', 'FINANCE']) expect((await get('other-in', {}, role)).statusCode).toBe(200)
  })
  it('租户隔离同时覆盖业务单据及创建人/仓库查找', async () => {
    expect((await get('other-in')).json().rows.map((r: any) => r.no)).toEqual(['DOC-a', 'DOC-b'])
    expect((await get('other-in', {}, 'ADMIN', 'two')).json().rows.map((r: any) => r.no)).toEqual(['DOC-foreign'])
    for (const model of ['warehouseDoc', 'warehouse', 'user']) expect(fixture.tx[model].findMany.mock.calls.map((c: any) => c[0].where.tenantId)).toEqual(['one', 'two'])
  })
  it.each(managementPages.map(p => p.id))('%s 返回预期状态，所有根业务查询都携带租户', async id => {
    expect((await get(id)).statusCode).toBe(200)
    for (const model of ['warehouseDoc', 'warehouse', 'user', 'upstreamReceipt', 'inventoryCount', 'warehouseLedgerBalance', 'warehouseLedgerMovement']) for (const [args] of fixture.tx[model].findMany.mock.calls) expect(args.where.tenantId).toBe('one')
  })
  it('筛选使用完整结果后再分页；导出包括所有匹配结果', async () => {
    const page = (await get('other-in', { pageSize: '1', page: '2' })).json()
    expect(page.total).toBe(2); expect(page.totals.amount).toBe(25); expect(page.rows[0]).toMatchObject({ seq: 2, no: 'DOC-b', amount: 12.5, printed: null })
    const filtered = (await get('other-in', { filters: JSON.stringify({ no: 'doc-b', review: '未复审' }), pageSize: '1', page: '50' })).json()
    expect(filtered.total).toBe(1); expect(filtered.page).toBe(1); expect(filtered.rows[0].seq).toBe(1)
    const exported = (await get('other-in', { pageSize: '1', export: '1' })).json()
    const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(exported.fileBase64, 'base64') as any)
    expect(book.worksheets[0].rowCount).toBe(3)
    expect(book.worksheets[0].getRow(1).values).toContain('打印状态')
  })
  it('采购入库的四个排除字段不出现在响应与导出表头中', async () => {
    const result = (await get('purchase-in')).json()
    expect(result.columns.map((c: any) => c.label)).toEqual(['序号', '单据编号', '入库日期', '上游单据号', '采购机构', '仓库', '供应商', '金额', '状态', '复审状态', '创建时间', '创建人', '备注', '附件'])
    const file = (await get('purchase-in', { export: '1' })).json()
    const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(file.fileBase64, 'base64') as any)
    for (const label of ['对账状态', '发票状态', '打印状态', '质检次数']) expect(book.worksheets[0].getRow(1).values).not.toContain(label)
  })
  it('日期查询以上海零点为边界，日期与筛选格式无效时拒绝', async () => {
    await get('other-in', { start: '2026-09-01', end: '2026-09-01' })
    expect(fixture.tx.warehouseDoc.findMany.mock.calls[0][0].where.effectiveAt).toEqual({ gte: new Date('2026-08-31T16:00:00Z'), lt: new Date('2026-09-01T16:00:00Z') })
    await get('purchase-in', { start: '2026-09-01', dateField: 'createdAt' })
    expect(fixture.tx.upstreamReceipt.findMany.mock.calls[0][0].where.createdAt.gte).toEqual(new Date('2026-08-31T16:00:00Z'))
    for (const q of [{ start: '2026-02-30' }, { start: '2026-09-02', end: '2026-09-01' }, { filters: 'invalid' }, { filters: '{"unknown":"x"}' }, { pageSize: '1000' }]) expect((await get('other-in', q)).statusCode).toBe(400)
  })
  it('缺少独立单据来源时明确返回不可用，并拒绝导出', async () => {
    for (const id of ['purchase-return', 'multi-count', 'profit', 'loss']) {
      expect((await get(id)).json()).toMatchObject({ sourceAvailable: false, total: 0, rows: [] })
      expect((await get(id, { export: '1' })).statusCode).toBe(422)
    }
  })
  it('大结果显式报错，不能悄悄截断列表或导出', async () => {
    fixture.tx.warehouseDoc.findMany.mockResolvedValue(Array.from({ length: 10001 }, (_, i) => doc(String(i))))
    expect((await get('other-in', { export: '1' })).statusCode).toBe(422)
  })
  it('库存日均量分开计算时间窗口及库存单位，缺失上下限保持空值', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-23T02:00:00Z'))
    try {
      fixture.tx.warehouseLedgerBalance.findMany.mockResolvedValue([{ id: 'balance', warehouseId: 'wh', productId: 'p', inventoryUnit: 'kg', physicalQty: 18, warehouse: { code: 'WH', name: '总仓' }, product: { code: 'P1', name: '土豆', spec: '', category: '蔬菜' } }])
      fixture.tx.warehouseLedgerMovement.findMany.mockResolvedValue([
        { warehouseId: 'wh', productId: 'p', inventoryUnit: 'kg', effectiveAt: new Date('2026-09-22T00:00:00Z'), physicalDelta: -14 },
        { warehouseId: 'wh', productId: 'p', inventoryUnit: 'kg', effectiveAt: new Date('2026-09-10T00:00:00Z'), physicalDelta: -14 },
        { warehouseId: 'wh', productId: 'p', inventoryUnit: '箱', effectiveAt: new Date('2026-09-01T00:00:00Z'), physicalDelta: -10 },
      ])
      const res = (await get('limits')).json()
      expect(res.rows[0]).toMatchObject({ avg7: 2, avg14: 2, avg30: null, avg60: null, currentQty: 18, minQty: null, maxQty: null, safeQty: null })
      expect(fixture.tx.warehouseLedgerMovement.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'one', reversal: { is: null }, effectiveAt: { lt: new Date('2026-09-22T16:00:00Z') } })
    } finally { vi.useRealTimers() }
  })
})
