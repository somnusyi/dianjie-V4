import 'dotenv/config'
import { prisma } from '@dianjie/db'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import contract from '../src/services/inventory-management-contract.json'
import { businessDateKey } from '../src/lib/businessTime'

// 写入仅允许本机隔离测试库；使用 seed-upstream-uat.ts 的测试账号，不读取生产凭据。
const database = new URL(process.env.DATABASE_URL || '')
assert(['localhost', '127.0.0.1'].includes(database.hostname) && database.pathname.endsWith('_test') && process.env.PREVIEW_MODE === 'true', '只允许本机隔离测试库')
const api = process.env.LOCAL_VERIFY_API_URL || 'http://127.0.0.1:4444'
const web = process.env.LOCAL_VERIFY_WEB_URL || 'http://127.0.0.1:3200'
for (const base of [api, web]) assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname), '只允许本机服务地址')
const outcomes: { check: string; result: string }[] = []
const pass = (check: string) => { outcomes.push({ check, result: 'passed' }); console.log(`PASS ${check}`) }
async function request(path: string, token = '', body?: unknown, method = body === undefined ? 'GET' : 'POST', base = api) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const data: any = await response.json()
  assert(response.ok, `${method} ${path}: ${response.status} ${data.error || data.message || ''}`)
  return data
}
async function main() {
  const tenantSlug = process.env.PREVIEW_TENANT_SLUG || 'supply-chain-uat'
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } })
  const product = await prisma.product.findUniqueOrThrow({ where: { tenantId_code: { tenantId: tenant.id, code: 'UAT-SKU-001' } } })
  const supplier = await prisma.supplier.findUniqueOrThrow({ where: { tenantId_no: { tenantId: tenant.id, no: 'UAT-UPSTREAM-01' } } })
  const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { tenantId: tenant.id, isDefault: true } })
  const store = await prisma.store.findUniqueOrThrow({ where: { tenantId_no: { tenantId: tenant.id, no: 'UAT-STORE-01' } } })
  const tokens: Record<string, string> = {}
  for (const [role, phone] of Object.entries({ supply: '13970000001', admin: '13970000002', finance: '13970000003', supplier: '13970000004', manager: '13970000006' })) {
    const login = await request('/api/auth/login', '', { identifier: phone, password: process.env.UAT_SEED_PASSWORD, tenantSlug })
    assert(login.token); tokens[role] = login.token
  }
  pass('5 个真实账号登录')
  for (const base of [api, web]) assert.equal((await request('/api/health', '', undefined, 'GET', base)).db, 'ok')
  pass('API 与 Web 同源代理均连通 PostgreSQL')
  const before = await prisma.warehouseLedgerBalance.findFirst({ where: { tenantId: tenant.id, warehouseId: warehouse.id, productId: product.id } })
  const initialQty = Number(before?.physicalQty || 0); const initialValue = Number(before?.inventoryValue || 0)
  const effectiveAt = new Date().toISOString()
  const inboundBody = { productId: product.id, supplierId: supplier.id, purchaseQuantity: 2, totalAmount: 200, effectiveAt, idempotencyKey: `verify-${randomUUID()}`, note: '本地真实联通验证' }
  const inbound = await request('/api/warehouse-inventory/manual-inbound', tokens.supply, inboundBody)
  assert.equal((await request('/api/warehouse-inventory/manual-inbound', tokens.supply, inboundBody)).replayed, true)
  const outbound = await request('/api/warehouse-inventory/batch-manual-outbound', tokens.supply, { items: [{ productId: product.id, inventoryQuantity: 5, totalAmount: 50 }], effectiveAt, idempotencyKey: `verify-${randomUUID()}`, reason: '本地真实联通验证领用' })
  await request(`/api/warehouse-docs/${inbound.doc.id}/confirm`, tokens.admin, undefined, 'POST')
  let balance = await prisma.warehouseLedgerBalance.findFirstOrThrow({ where: { tenantId: tenant.id, warehouseId: warehouse.id, productId: product.id } })
  assert.equal(Number(balance.physicalQty), initialQty + 15); assert.equal(Number(balance.inventoryValue), initialValue + 150)
  assert.equal((await prisma.warehouseDoc.findUniqueOrThrow({ where: { id: inbound.doc.id } })).status, 'CONFIRMED')
  pass('真实入库 20kg / 200元、出库 5kg / 50元、审核与幂等入账')

  const source = await prisma.productUpstreamSource.findFirstOrThrow({ where: { tenantId: tenant.id, productId: product.id, supplierId: supplier.id } })
  const suffix = Date.now().toString()
  const agreement = await request('/api/upstream/contracts', tokens.supply, { supplierId: supplier.id, contractNo: `LOCAL-${suffix}`, title: '本地验证采购合同', startsAt: new Date(Date.now() - 86400000).toISOString(), lines: [{ upstreamSourceId: source.id, unitPrice: 100 }] })
  await request(`/api/upstream/contracts/${agreement.id}/activate`, tokens.supply, undefined, 'POST')
  const order = await request('/api/upstream/purchase-orders', tokens.supply, { supplierId: supplier.id, warehouseId: warehouse.id, contractId: agreement.id, idempotencyKey: `verify-${randomUUID()}`, lines: [{ contractLineId: agreement.lines[0].id, quantity: 1 }] })
  for (const action of ['submit-for-approval', 'approve-and-send']) await request(`/api/upstream/purchase-orders/${order.id}/${action}`, tokens.admin, undefined, 'POST')
  await request(`/api/upstream/purchase-orders/${order.id}/accept`, tokens.supplier, undefined, 'POST')
  const shipment = await request(`/api/upstream/purchase-orders/${order.id}/shipments`, tokens.supplier, { idempotencyKey: `verify-${randomUUID()}`, lines: [{ purchaseOrderLineId: order.lines[0].id, shippedQty: 1 }] })
  await request(`/api/upstream/shipments/${shipment.id}/dispatch`, tokens.supplier, undefined, 'POST')
  const receipt = await request(`/api/upstream/shipments/${shipment.id}/receipts`, tokens.supply, { arrivedAt: new Date().toISOString(), idempotencyKey: `verify-${randomUUID()}`, lines: [{ shipmentLineId: shipment.lines[0].id, arrivedQty: 1, acceptedQty: 1 }] })
  await request(`/api/upstream/receipts/${receipt.id}/start-inspection`, tokens.supply, undefined, 'POST')
  await request(`/api/upstream/receipts/${receipt.id}/confirm`, tokens.supply, undefined, 'POST')
  assert.equal((await prisma.upstreamReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).status, 'POSTED')
  balance = await prisma.warehouseLedgerBalance.findFirstOrThrow({ where: { tenantId: tenant.id, warehouseId: warehouse.id, productId: product.id } })
  assert.equal(Number(balance.physicalQty), initialQty + 25); assert.equal(Number(balance.inventoryValue), initialValue + 250)
  pass('采购合同→下单审批→供应商接单发货→验收入库 10kg / 100元')

  const today = businessDateKey()
  const existing = await prisma.inventoryCount.findFirst({ where: { tenantId: tenant.id, storeId: store.id, countDate: new Date(`${today}T00:00:00Z`) }, orderBy: { createdAt: 'desc' } })
  let count = existing ? await request(`/api/inventory-counts/${existing.id}`, tokens.manager) : await request('/api/inventory-counts', tokens.manager, { storeId: store.id, countDate: today, note: '本地真实联通验证' })
  if (count.status === 'DRAFT') count = await request(`/api/inventory-counts/${count.id}/start`, tokens.manager, { rowVersion: count.rowVersion })
  if (count.status === 'COUNTING') {
    count = await request(`/api/inventory-counts/${count.id}/items`, tokens.manager, { rowVersion: count.rowVersion, items: count.items.map((item: any) => ({ id: item.id, countedQuantity: Number(item.bookQuantity) })) }, 'PUT')
    count = await request(`/api/inventory-counts/${count.id}/submit`, tokens.manager, { rowVersion: count.rowVersion })
  }
  if (count.status === 'REVIEWING') count = await request(`/api/inventory-counts/${count.id}/confirm`, tokens.admin, { rowVersion: count.rowVersion })
  assert.equal(count.status, 'CONFIRMED')
  const countResult = await request(`/api/inventory-management/count?start=${today}&end=${today}`, tokens.supply)
  assert(countResult.rows.some((r: any) => r.no === count.no))
  pass('盘点创建→录入→提交→确认，按当天日期能够检索')

  for (const page of contract) {
    const path = `/api/inventory-management/${page.id}`
    const direct = await request(path, tokens.supply); const proxied = await request(path, tokens.supply, undefined, 'GET', web)
    assert.deepEqual(direct.rows, proxied.rows); assert.equal(direct.total, proxied.total)
    for (const role of ['admin', 'finance']) assert.equal((await fetch(`${api}${path}`, { headers: { Authorization: `Bearer ${tokens[role]}` } })).status, 200)
    for (const role of ['supplier', 'manager']) assert.equal((await fetch(`${api}${path}`, { headers: { Authorization: `Bearer ${tokens[role]}` } })).status, 403)
    assert.equal((await fetch(`${api}${path}`)).status, 401)
    if (direct.sourceAvailable) {
      const exported = await request(`${path}?export=1`, tokens.supply)
      const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(exported.fileBase64, 'base64') as any)
      assert.equal(book.worksheets[0].rowCount, direct.total + 1)
      assert.deepEqual((book.worksheets[0].getRow(1).values as any[]).slice(1), page.columns.map(c => c.label))
    }
  }
  pass('9 页接口直连/代理一致，5 角色权限隔离，5 个有效来源 Excel 表头及行数一致')
  await prisma.$disconnect()
  balance = await prisma.warehouseLedgerBalance.findFirstOrThrow({ where: { tenantId: tenant.id, warehouseId: warehouse.id, productId: product.id } })
  assert.equal(Number(balance.physicalQty), initialQty + 25)
  const sum = await prisma.warehouseLedgerMovement.aggregate({ where: { tenantId: tenant.id, warehouseId: warehouse.id, productId: product.id }, _sum: { physicalDelta: true, valueDelta: true } })
  assert.equal(Number(sum._sum.physicalDelta), Number(balance.physicalQty)); assert.equal(Number(sum._sum.valueDelta), Number(balance.inventoryValue))
  pass('数据库重连后数据持久化，库存余额与流水数量/金额勾稽一致')
  const summary = { verifiedAt: new Date().toISOString(), outcomes, database: database.pathname.slice(1), tenant: tenantSlug,
    documents: { inbound: inbound.doc.docNo, outbound: outbound.doc.docNo, receipt: receipt.no, count: count.no },
    balance: { quantity: Number(balance.physicalQty), value: Number(balance.inventoryValue), unit: balance.inventoryUnit } }
  writeFileSync('../../tmp/live-api-verification.json', JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => prisma.$disconnect())
