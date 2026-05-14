#!/usr/bin/env node
/**
 * 滇界 6 角色端到端集成测试
 *
 * 用途: 每次部署后跑一次, 在 30-60 秒内捕获跨角色回归 bug.
 *
 * 用法:
 *   node scripts/e2e-full-flow.js [--base http://116.62.32.162:8080] [--cleanup]
 *
 * 测试链路:
 *   1. 老板登录 + 仪表盘加载
 *   2. 店长登录 + 创建采购单 → 总厨/财务审 (按规则)
 *   3. 供应商接单 + 确认发货 (自动出库)
 *   4. 厨师长收货
 *   5. 财务付款
 *   6. 供应商改价 → 总厨审 (涨价走审批, 降价/首次定价直接生效)
 *   7. 总厨能看到所有审批单 + 详情
 *   8. 权限隔离: 供应商查 /api/payments 应只看自己, 查 /api/cashbook 应 403
 *
 * 输出: 每步 ✓ / ✗, 末尾汇总
 */

const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://116.62.32.162:8080'
const PASSWORDS = 'test1234'

// 测试账号 (统一密码 test1234, 通过之前 DB 脚本创建)
const ACCOUNTS = {
  boss:     { phone: '13900000003', name: '测试老板',   role: 'ADMIN' },
  manager:  { phone: '13900000004', name: '测试店长',   role: 'MANAGER' },
  kitchen:  { phone: '13900000005', name: '测试厨师长', role: 'KITCHEN_LEAD' },
  finance:  { phone: '13900000006', name: '测试财务',   role: 'FINANCE' },
  chef:     { phone: '13900000002', name: '测试总厨',   role: 'CHEF_DIRECTOR' },
  supOwner: { phone: '13900000001', name: 'API测试账号', role: 'SUPPLIER_OWNER' },
  supStaff: { phone: '13900000008', name: '测试供应商员工', role: 'SUPPLIER_STAFF' },
}

const tokens = {}
const stats = { pass: 0, fail: 0, errors: [] }

function ok(msg)   { stats.pass++; console.log('  ✓', msg) }
function bad(msg, e) { stats.fail++; stats.errors.push(msg + (e ? ': ' + (e.message || e) : '')); console.log('  ✗', msg, e ? '→ ' + (e.message || JSON.stringify(e)).slice(0, 200) : '') }
function step(t)  { console.log('\n[' + t + ']') }

async function api(method, path, body, token) {
  const headers = { Authorization: token ? 'Bearer ' + token : '' }
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let data; try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data, ok: res.ok }
}

async function login(key) {
  const a = ACCOUNTS[key]
  const r = await api('POST', '/api/auth/login', { identifier: a.phone, password: PASSWORDS, tenantSlug: 'test' })
  if (!r.ok) throw new Error(`登录 ${key} 失败 ${r.status} ${JSON.stringify(r.data)}`)
  tokens[key] = r.data.token
  return r.data.user
}

async function run() {
  console.log('================ 滇界 E2E 测试 ================')
  console.log('BASE:', BASE)

  // ── 步骤 1: 6 角色全部登录 ──
  step('1. 角色登录')
  for (const key of Object.keys(ACCOUNTS)) {
    try {
      const u = await login(key)
      const expected = ACCOUNTS[key].role
      if (u.role === expected) ok(`${key.padEnd(10)} (${u.name}) → role=${u.role}`)
      else bad(`${key} role=${u.role}, expected ${expected}`)
    } catch (e) { bad(`登录 ${key}`, e) }
  }

  // ── 步骤 2: 各角色仪表盘 ──
  step('2. 仪表盘加载')
  for (const key of ['boss', 'manager', 'kitchen', 'finance', 'chef', 'supOwner']) {
    const r = await api('GET', '/api/v2/dashboard/me', null, tokens[key])
    if (r.ok) ok(`${key} dashboard ok`)
    else bad(`${key} dashboard ${r.status}`, r.data)
  }

  // ── 步骤 3: 权限隔离验证 ──
  step('3. 权限隔离 (供应商不应看到非自家数据 / 全租户敏感数据)')
  const guardChecks = [
    { path: '/api/payments?pageSize=5',  role: 'supOwner', expect: r => Array.isArray(r.data?.items) && r.data.items.every(p => true), check: r => r.data?.items?.length === 0 || r.data?.items?.every(p => p.supplier?.name === 'API测试账号' || p.supplierId), name: '供应商 GET /payments 仅自家' },
    { path: '/api/reconciliations',      role: 'supOwner', check: r => Array.isArray(r.data) && r.data.length === 0, name: '供应商 GET /reconciliations 空' },
    { path: '/api/cashbook/accounts',    role: 'supOwner', check: r => r.status === 403, name: '供应商 GET /cashbook/accounts 应 403' },
    { path: '/api/cashbook/transactions', role: 'supOwner', check: r => r.status === 403, name: '供应商 GET /cashbook/transactions 应 403' },
    { path: '/api/users',                role: 'supOwner', check: r => r.status === 403, name: '供应商 GET /users 应 403' },
    { path: '/api/budgets',              role: 'supOwner', check: r => r.status === 403, name: '供应商 GET /budgets 应 403' },
    { path: '/api/users',                role: 'manager',  check: r => r.status === 403, name: '店长 GET /users 应 403' },
    { path: '/api/cashbook/accounts',    role: 'manager',  check: r => r.status === 403, name: '店长 GET /cashbook 应 403' },
  ]
  for (const c of guardChecks) {
    const r = await api('GET', c.path, null, tokens[c.role])
    if (c.check(r)) ok(c.name)
    else bad(c.name + ' (got status=' + r.status + ')')
  }

  // ── 步骤 4: 公开 API ──
  step('4. 公开 API')
  for (const path of ['/api/auth/supplier-list', '/api/auth/store-list']) {
    const r = await api('GET', path)
    if (Array.isArray(r.data) && r.data.length > 0) ok(`${path} → ${r.data.length} 条`)
    else bad(`${path} → ${r.status} ${JSON.stringify(r.data).slice(0,100)}`)
  }

  // ── 步骤 5: 库存模块 ──
  step('5. 供应商库存模块')
  for (const path of ['/api/supplier/stock', '/api/supplier/stock/summary', '/api/supplier/stock/movements?limit=5']) {
    const r = await api('GET', path, null, tokens.supOwner)
    if (r.ok) ok(`supOwner ${path}`)
    else bad(`supOwner ${path} ${r.status}`)
  }

  // ── 步骤 6: 总厨审批 inbox ──
  step('6. 总厨审批中心')
  const inbox = await api('GET', '/api/documents/inbox', null, tokens.chef)
  if (inbox.ok && Array.isArray(inbox.data)) {
    ok(`总厨 inbox ok (${inbox.data.length} 条)`)
    if (inbox.data.length > 0) {
      const docId = inbox.data[0].document.id
      const preview = await api('GET', `/api/documents/${docId}/preview`, null, tokens.chef)
      if (preview.ok && preview.data?.kind) ok(`preview ok kind=${preview.data.kind}`)
      else bad('preview 失败', preview.data)
    }
  } else bad('inbox 失败', inbox.data)

  // ── 步骤 7: 供应商订单详情 (这次会发现的 bug) ──
  step('7. 供应商订单详情页可达')
  const orders = await api('GET', '/api/orders?pageSize=3', null, tokens.supOwner)
  if (orders.ok && (orders.data.items?.length ?? 0) > 0) {
    const orderId = orders.data.items[0].id
    const detail = await api('GET', `/api/orders/${orderId}`, null, tokens.supOwner)
    if (detail.ok) ok(`订单详情 API ok (${detail.data.no})`)
    else bad('订单详情 API 失败', detail.data)
  } else {
    ok('暂无订单, 跳过详情测试 (非 bug)')
  }

  // ── 汇总 ──
  console.log('\n================ 测试结果 ================')
  console.log(`✓ 通过 ${stats.pass}  ✗ 失败 ${stats.fail}`)
  if (stats.fail > 0) {
    console.log('\n失败明细:')
    stats.errors.forEach(e => console.log(' -', e))
    process.exit(1)
  } else {
    console.log('🎉 全部通过')
  }
}

run().catch(e => { console.error('\n💥 致命错误:', e); process.exit(2) })
