/**
 * 本机沙盒专用：通过真实 HTTP API 验收总仓批量入库。
 * 所有成功流水都带 accept-* 幂等键，只允许连接 localhost API 和本地预览库。
 */
import assert from 'node:assert/strict'

const API_BASE = (process.env.LOCAL_API_BASE || 'http://127.0.0.1:4444').replace(/\/$/, '')
const DATABASE_URL = process.env.DATABASE_URL || ''
const PHONE = process.env.LOCAL_SUPPLY_CHAIN_PHONE || ''
const PASSWORD = process.env.LOCAL_SUPPLY_CHAIN_PASSWORD || ''

function assertLocalSandbox() {
  const apiUrl = new URL(API_BASE)
  const dbUrl = new URL(DATABASE_URL)
  const database = decodeURIComponent(dbUrl.pathname.slice(1))
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(apiUrl.hostname), '安全护栏：API 必须是 localhost')
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(dbUrl.hostname), '安全护栏：数据库必须是 localhost')
  assert.ok(database.includes('dianjie_v4_local'), '安全护栏：只允许 dianjie_v4_local')
  assert.equal(process.env.PREVIEW_MODE, 'true', '安全护栏：PREVIEW_MODE 必须为 true')
  assert.match(PHONE, /^1[3-9]\d{9}$/, '必须显式提供本地手机号')
  assert.ok(PASSWORD.length >= 6, '必须显式提供本地密码')
}

type Json = Record<string, any> | any[]
let token = ''
const results: Array<{ test: string; status: 'PASS'; evidence: string }> = []

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  })
  let body: Json
  try { body = await response.json() as Json } catch { body = {} }
  return { status: response.status, body }
}

function pass(test: string, evidence: string) {
  results.push({ test, status: 'PASS', evidence })
}

async function stock() {
  const response = await request('/api/warehouse-inventory?scope=stock&page=1&pageSize=500')
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return response.body as any
}

async function main() {
  assertLocalSandbox()
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const effectiveAt = new Date().toISOString()

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: PHONE, password: PASSWORD, tenantSlug: 'dianjie' }),
  })
  assert.equal(login.status, 200, JSON.stringify(login.body))
  assert.equal((login.body as any).user.role, 'SUPPLY_CHAIN')
  token = (login.body as any).token
  assert.ok(token)
  pass('登录与权限', 'SUPPLY_CHAIN 账号登录成功')

  const candidatesResponse = await request('/api/warehouse-inventory/inbound-candidates?limit=500')
  assert.equal(candidatesResponse.status, 200, JSON.stringify(candidatesResponse.body))
  const candidates = (candidatesResponse.body as any).items as any[]
  const testCandidates = candidates.filter(item => String(item.code).startsWith('TEST-WH-'))
  const expectedCodes = ['TEST-WH-BEEF', 'TEST-WH-EGGS', 'TEST-WH-MUSHROOM', 'TEST-WH-OIL', 'TEST-WH-RICE', 'TEST-WH-SODA']
  assert.deepEqual(testCandidates.map(item => item.code).sort(), expectedCodes)
  assert.ok(!candidates.some(item => item.code === 'TEST-WH-PENDING'))
  pass('候选商品列表', '6 个已核验商品可见，待核验商品被排除')

  const suppliersResponse = await request('/api/suppliers')
  assert.equal(suppliersResponse.status, 200, JSON.stringify(suppliersResponse.body))
  const suppliers = suppliersResponse.body as any[]
  const upstream = suppliers.find(item => item.no === 'TEST-UP-001')
  assert.ok(upstream?.businessScopes?.includes('WAREHOUSE_UPSTREAM'))
  const wrongSupplier = suppliers.find(item => item.status === 'ENABLED' && !item.businessScopes?.includes('WAREHOUSE_UPSTREAM'))
  assert.ok(wrongSupplier, '本地没有可用于负例的非上游供应商')
  pass('供应商下拉', '测试上游供应商可见，业务范围正确')

  const byCode = new Map(candidates.map(item => [item.code, item]))
  const rice = byCode.get('TEST-WH-RICE')
  const oil = byCode.get('TEST-WH-OIL')
  const beef = byCode.get('TEST-WH-BEEF')
  assert.ok(rice && oil && beef)

  const before = await stock()
  const beforeMovementCount = before.summary.movementCount
  const beforeByCode = new Map(before.items.map((item: any) => [item.code, item]))
  const beforeQty = (code: string) => Number((beforeByCode.get(code) as any)?.physicalQty || 0)
  const beforeValue = (code: string) => Number((beforeByCode.get(code) as any)?.inventoryValue || 0)

  const key = `accept-batch-${runId}`
  const successBody = {
    items: [
      { productId: rice.id, purchaseQuantity: 2, unitPrice: 150, totalAmount: 300, batchNo: `RICE-${runId}` },
      { productId: oil.id, purchaseQuantity: 3, unitPrice: 168, totalAmount: 504, batchNo: `OIL-${runId}` },
      { productId: beef.id, purchaseQuantity: 4, unitPrice: 68, totalAmount: 272, batchNo: `BEEF-${runId}`, manufactureDate: '2026-09-01', expiryDate: '2026-09-30' },
    ],
    effectiveAt,
    idempotencyKey: key,
    supplierId: upstream.id,
    note: '本地验收：总仓批量入库正常路径',
  }
  const posted = await request('/api/warehouse-inventory/batch-manual-inbound', { method: 'POST', body: JSON.stringify(successBody) })
  assert.equal(posted.status, 200, JSON.stringify(posted.body))
  assert.equal((posted.body as any).replayed, false)
  assert.equal((posted.body as any).count, 3)
  assert.equal((posted.body as any).totalAmount, 1076)
  assert.deepEqual((posted.body as any).gateWarnings, [])
  assert.equal((posted.body as any).doc?.status, 'POSTED')
  pass('批量入库正常路径', '3 种商品整单成功，金额 1076，生成已过账入库单')

  const after = await stock()
  const afterByCode = new Map(after.items.map((item: any) => [item.code, item]))
  const delta = (code: string, field: 'physicalQty' | 'inventoryValue') =>
    Number((afterByCode.get(code) as any)?.[field] || 0) - (field === 'physicalQty' ? beforeQty(code) : beforeValue(code))
  assert.equal(delta('TEST-WH-RICE', 'physicalQty'), 50)
  assert.equal(delta('TEST-WH-OIL', 'physicalQty'), 36)
  assert.equal(delta('TEST-WH-BEEF', 'physicalQty'), 4000)
  assert.equal(delta('TEST-WH-RICE', 'inventoryValue'), 300)
  assert.equal(delta('TEST-WH-OIL', 'inventoryValue'), 504)
  assert.equal(delta('TEST-WH-BEEF', 'inventoryValue'), 272)
  assert.equal(after.summary.movementCount, beforeMovementCount + 3)
  pass('单位换算与库存入账', '大米 +50kg，菜籽油 +36瓶，牛肉 +4000g，金额分别 +300/+504/+272')

  const replay = await request('/api/warehouse-inventory/batch-manual-inbound', { method: 'POST', body: JSON.stringify(successBody) })
  assert.equal(replay.status, 200, JSON.stringify(replay.body))
  assert.equal((replay.body as any).replayed, true)
  assert.equal((await stock()).summary.movementCount, beforeMovementCount + 3)
  pass('幂等重放', '相同请求返回 replayed=true，没有重复入账')

  const conflictBody = structuredClone(successBody)
  conflictBody.items[0].totalAmount = 301
  const conflict = await request('/api/warehouse-inventory/batch-manual-inbound', { method: 'POST', body: JSON.stringify(conflictBody) })
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body))
  assert.equal((await stock()).summary.movementCount, beforeMovementCount + 3)
  pass('幂等键冲突', '同一幂等键更改金额返回 409，无新流水')

  async function rejectedWithoutWrite(test: string, expectedStatus: number, body: any, evidence: string) {
    const countBefore = (await stock()).summary.movementCount
    const response = await request('/api/warehouse-inventory/batch-manual-inbound', { method: 'POST', body: JSON.stringify(body) })
    assert.equal(response.status, expectedStatus, `${test}: ${JSON.stringify(response.body)}`)
    assert.equal((await stock()).summary.movementCount, countBefore, `${test}: 拒绝后流水数变化`)
    pass(test, `${evidence}；流水数不变`)
  }

  await rejectedWithoutWrite('重复商品校验', 400, {
    ...successBody, idempotencyKey: `accept-dup-${runId}`,
    items: [successBody.items[0], { ...successBody.items[0], batchNo: null }],
  }, '同一商品重复添加被拒绝')

  const pendingId = 'cmtjtyemu000r3vpuozdi5z51'
  await rejectedWithoutWrite('整单原子回滚', 409, {
    ...successBody, idempotencyKey: `accept-atomic-${runId}`,
    items: [
      { productId: rice.id, purchaseQuantity: 1, unitPrice: 150 },
      { productId: pendingId, purchaseQuantity: 1, unitPrice: 10 },
    ],
  }, '一行单位待核验时整单拒绝')

  await rejectedWithoutWrite('供应商范围闸口', 409, {
    ...successBody, idempotencyKey: `accept-supplier-${runId}`, supplierId: wrongSupplier.id,
    items: [{ productId: rice.id, purchaseQuantity: 1, unitPrice: 150 }],
  }, '非总仓上游供应商被拒绝')

  await rejectedWithoutWrite('生产/到期日期校验', 400, {
    ...successBody, idempotencyKey: `accept-date-${runId}`,
    items: [{ productId: beef.id, purchaseQuantity: 1, unitPrice: 68, manufactureDate: '2026-09-20', expiryDate: '2026-09-10' }],
  }, '到期日早于生产日被拒绝')

  const records = await request(`/api/warehouse-inventory/inbound-records?source=batch&supplierId=${encodeURIComponent(upstream.id)}&q=TEST-WH&page=1&pageSize=100`)
  assert.equal(records.status, 200, JSON.stringify(records.body))
  const runRecords = (records.body as any).items.filter((item: any) => item.sourceId === key)
  assert.equal(runRecords.length, 3)
  assert.equal(runRecords.reduce((sum: number, item: any) => sum + Number(item.amount), 0), 1076)
  assert.ok(runRecords.every((item: any) => item.supplier?.id === upstream.id && item.doc?.id))
  pass('入库记录查询', '3 条批量入库记录可查，供应商和入库单关联完整')

  const movementIds = new Set((posted.body as any).movements.map((item: any) => item.id))
  let lotCount = 0
  for (const product of [rice, oil, beef]) {
    const lots = await request(`/api/warehouse-inventory/lots?productId=${encodeURIComponent(product.id)}&includeDepleted=true&limit=100`)
    assert.equal(lots.status, 200, JSON.stringify(lots.body))
    lotCount += (lots.body as any[]).filter(item => movementIds.has(item.sourceMovementId)).length
  }
  assert.equal(lotCount, 3)
  pass('批次台账', '3 条入库流水均生成对应批次')

  const audit = await request('/api/warehouse-inventory/audit')
  assert.equal(audit.status, 200, JSON.stringify(audit.body))
  pass('台账审计接口', '审计接口可正常读取')

  console.log(JSON.stringify({ ok: true, runId, passed: results.length, results }, null, 2))
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), results }, null, 2))
  process.exitCode = 1
})
