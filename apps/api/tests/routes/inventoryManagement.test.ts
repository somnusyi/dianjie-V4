import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import ExcelJS from 'exceljs'
import { inventoryManagementRoutes } from '../../src/routes/inventoryManagement'
import { managementPages } from '../../src/services/inventoryManagement'

const fixture = vi.hoisted(() => ({ tx: {} as any }))
vi.mock('@dianjie/db', async original => ({ ...await original<typeof import('@dianjie/db')>(), prisma: { $transaction: (fn: any) => fn(fixture.tx) } }))
const app = Fastify()
const doc = (id: string, tenantId = 'one') => ({ id, tenantId, docNo: `DOC-${id}`, type: 'MANUAL_INBOUND', effectiveAt: new Date('2026-09-01T00:00:00Z'), warehouseId: 'wh', createdById: 'u', totalAmount: 12.5, status: 'CONFIRMED', reviewStatus: 'UNREVIEWED', createdAt: new Date('2026-08-31T16:00:00Z'), note: '测试', reason: '期初入库', attachments: [{ name: '随货单.pdf' }] })
const get = (id: string, query: Record<string, string> = {}, role = 'SUPPLY_CHAIN', tenantId = 'one') => app.inject({ url: `/api/inventory-management/${id}?${new URLSearchParams(query)}`, headers: { authorization: `Bearer ${app.jwt.sign({ role, tenantId })}` } })
beforeAll(async () => {
  await app.register(jwt, { secret: 'management-local-test-only-key' })
  app.decorate('authenticate', async (req: any) => req.jwtVerify())
  await app.register(inventoryManagementRoutes, { prefix: '/api/inventory-management' })
  await app.ready()
})
beforeEach(() => {
  fixture.tx = {
    store:{findMany:vi.fn(async()=>[{id:'store-empty',name:'没有盘点的门店'}])},
    tenant: { findUnique: vi.fn(async ({ where }: any) => ({ name: where.id, slug: where.id })) },
    warehouseDoc: { findMany: vi.fn(async ({ where }: any) => [doc('a'), doc('b'), doc('foreign', 'two')].filter(d => (!where.tenantId || d.tenantId === where.tenantId) && (!where.type || d.type === where.type))) },
    warehouse: { findMany: vi.fn(async () => [{ id: 'wh', name: '总仓' }]) },
    user: { findMany: vi.fn(async () => [{ id: 'u', name: '测试员' }]) },
    upstreamReceipt: { findMany: vi.fn(async () => []) }, inventoryCount: { findMany: vi.fn(async () => []) },
    warehouseStocktake: { findMany: vi.fn(async () => []) },
    warehouseStocktakeAdjustment: { findMany: vi.fn(async () => []) },
    upstreamPurchaseReturn: { findMany: vi.fn(async () => []) },
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
    for (const model of ['warehouseDoc', 'warehouse', 'user', 'upstreamReceipt', 'upstreamPurchaseReturn', 'inventoryCount', 'warehouseStocktake', 'warehouseStocktakeAdjustment', 'warehouseLedgerBalance', 'warehouseLedgerMovement']) for (const [args] of fixture.tx[model].findMany.mock.calls) expect(args.where.tenantId).toBe('one')
  })
  it('筛选使用完整结果后再分页；导出包括所有匹配结果', async () => {
    const page = (await get('other-in', { pageSize: '1', page: '2' })).json()
    expect(page.total).toBe(2); expect(page.totals.amount).toBe(25); expect(page.rows[0]).toMatchObject({ seq: 2, no: 'DOC-b', amount: 12.5, printed: null, source: '其他入库', attachments: '1 项', recordType: 'WAREHOUSE_DOC', detailId: 'b' })
    const filtered = (await get('other-in', { filters: JSON.stringify({ no: 'doc-b', review: '未复审' }), pageSize: '1', page: '50' })).json()
    expect(filtered.total).toBe(1); expect(filtered.page).toBe(1); expect(filtered.rows[0].seq).toBe(1)
    const exported = (await get('other-in', { pageSize: '1', export: '1' })).json()
    const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(exported.fileBase64, 'base64') as any)
    expect(book.worksheets[0].rowCount).toBe(3)
    expect(book.worksheets[0].getRow(1).values).toContain('打印状态')
    expect(book.worksheets[0].getRow(1).values).toContain('附件')
  })
  it('采购入库的四个排除字段不出现在响应与导出表头中', async () => {
    const result = (await get('purchase-in')).json()
    expect(result.columns.map((c: any) => c.label)).toEqual(['序号', '单据编号', '入库日期', '上游单据号', '采购机构', '仓库', '供应商', '金额', '状态', '复审状态', '创建时间', '创建人', '备注', '附件'])
    expect(result.rows[0]).toMatchObject({ recordType: 'WAREHOUSE_DOC', detailId: 'b' })
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
  it('多人盘点、盘盈和盘亏已接入独立单据来源', async () => {
    for (const id of ['multi-count', 'profit', 'loss']) {
      expect((await get(id)).json()).toMatchObject({ sourceAvailable: true, total: 0, rows: [] })
      expect((await get(id, { export: '1' })).statusCode).toBe(200)
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
  it('盘点列表使用实际范围、差异项数与机构仓库映射，过滤和合计一致', async () => {
    fixture.tx.warehouseStocktake.findMany.mockResolvedValue([
      { id: 'all', no: 'PD-ALL', warehouse: { name: '甲仓' }, countScope: 'ALL', countDate: new Date('2026-10-12'), createdAt: new Date('2026-10-12'), createdById: 'u', reviewedAt: new Date('2026-10-12'), itemCount: 4, countedCount: 4, differenceCount: 2, totalBookValue: 10, totalCountedValue: 12, totalDifferenceValue: 2, status: 'CONFIRMED' },
      { id: 'selected', no: 'PD-SELECTED', warehouse: { name: '乙仓' }, countScope: 'SELECTED', countDate: new Date('2026-10-12'), createdAt: new Date('2026-10-12'), createdById: 'u', itemCount: 1, countedCount: 1, differenceCount: 0, totalBookValue: 20, totalCountedValue: 20, totalDifferenceValue: 0, status: 'CONFIRMED' },
    ])
    const response = (await get('count')).json()
    expect(response.rows[0]).toMatchObject({ countType: '全部盘', countMethod: '汇总盘点', differenceCount: 2, difference: '有差异', printed: null })
    expect(response.rows[1]).toMatchObject({ countType: '指定物品', differenceCount: 0, difference: '无差异' })
    expect(response.warehousesByOrg.one).toEqual(['乙仓', '总仓', '甲仓'].sort())
    const filtered = (await get('count', { filters: JSON.stringify({ countType: '全部盘', difference: '有差异' }) })).json()
    expect(filtered.total).toBe(1); expect(filtered.rows[0].no).toBe('PD-ALL'); expect(filtered.totals.actualAmount).toBe(12)
  })

})

it('stocktake organization and warehouse choices survive an empty date result',async()=>{
 fixture.tx.warehouse.findMany.mockResolvedValue([{id:'wh-new',name:'尚无盘点的仓库'}])
 for(const id of ['count','multi-count']){
  const response=await get(id,{start:'2026-01-01',end:'2026-01-02'});expect(response.statusCode,response.body).toBe(200)
  const data=response.json();expect(data.rows).toHaveLength(0);expect(data.options.org).toContain('one');expect(data.options.warehouse).toContain('尚无盘点的仓库')
  expect(data.warehousesByOrg.one).toEqual(['尚无盘点的仓库']);expect(data.warehouseOptions).toEqual([{id:'wh-new',name:'尚无盘点的仓库'}])
  if(id==='count')expect(data.options.org).toContain('没有盘点的门店')
 }
 expect(fixture.tx.store.findMany.mock.calls[0][0].where).toEqual({tenantId:'one'})
})

it('uses exact IDs for same-name stocktake warehouses without changing legacy name requests',async()=>{
 fixture.tx.warehouse.findMany.mockResolvedValue([{id:'wh-a',name:'同名仓'},{id:'wh-b',name:'同名仓'}])
 const base={countDate:new Date('2026-10-12T00:00:00Z'),warehouse:{name:'同名仓'},itemCount:0,totalBookValue:0,totalCountedValue:0,totalDifferenceValue:0,countScope:'ALL',differenceCount:0,countedCount:0,status:'DRAFT',createdAt:new Date(),createdById:'u'}
 fixture.tx.warehouseStocktake.findMany.mockResolvedValue([{...base,id:'a',no:'PD-a',warehouseId:'wh-a'},{...base,id:'b',no:'PD-b',warehouseId:'wh-b'}])
 const selected=(await get('count',{filters:JSON.stringify({org:'tenant:one',warehouse:'warehouse:wh-b'})})).json()
 expect(selected.rows.map((row:any)=>row.no)).toEqual(['PD-b'])
 expect(selected.choiceOptions.warehouse.map((choice:any)=>choice.value)).toEqual(['warehouse:wh-a','warehouse:wh-b'])
 expect((await get('count',{filters:JSON.stringify({warehouse:'同名仓'})})).json().rows).toHaveLength(2)
 expect((await get('count',{filters:JSON.stringify({org:'tenant:two'})})).json().rows).toHaveLength(0)
})

it('does not infer an independent result stocktake from reviewed or draft multi-count status',async()=>{
 const base={countDate:new Date('2026-10-12T00:00:00Z'),warehouse:{name:'总仓'},warehouseId:'wh',itemCount:1,createdAt:new Date(),createdBy:{name:'合成供应链'},sections:[],note:null,reviewedAt:null}
 fixture.tx.warehouseStocktake.findMany.mockResolvedValue([{...base,id:'reviewed',no:'MULTI-REVIEWED',status:'CONFIRMED'},{...base,id:'draft',no:'MULTI-DRAFT',status:'DRAFT'}])
 const data=(await get('multi-count')).json()
 expect(data.rows.map((row:any)=>row.generated)).toEqual([null,null])
 expect(data.supportedFilters).not.toContain('generated')
 expect(data.note).toContain('生成状态待核对')
 for(const generated of ['是','否']){
  const oldRequest=(await get('multi-count',{filters:JSON.stringify({generated})})).json()
  expect(oldRequest.rows).toHaveLength(2);expect(oldRequest.note).toContain('本次未应用该条件')
 }
 const exportResult=(await get('multi-count',{export:'1'})).json();const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(exportResult.fileBase64,'base64') as any)
 const index=(book.worksheets[0].getRow(1).values as any[]).indexOf('是否生成盘点单')
 expect(index).toBeGreaterThan(0);expect(book.worksheets[0].getRow(2).getCell(index).value).toBeNull()
})
