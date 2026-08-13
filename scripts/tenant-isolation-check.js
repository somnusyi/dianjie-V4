#!/usr/bin/env node
/**
 * 滇界 V4 · 租户/门店/供应商 数据隔离回归测试
 *
 * 跨 6 角色 token, 扫一遍 list-class 接口, 断言:
 *   - SUPPLIER_*  → items 全部 supplierId == 自己
 *   - MANAGER/KITCHEN_LEAD → items 全部 storeId == 自己 (或 storeId 为 null)
 *   - FINANCE/ADMIN/CHEF_DIRECTOR → 不强校验 scope (本身就是租户/集团角色)
 *   - 敏感路由 → 非授权角色应 403 (cashbook / users / budgets / capital)
 *
 * 这是 CLAUDE.md gate #3 "改权限 → 必须 多角色 验证" 的自动化兜底, CI 必跑.
 *
 * 用法:
 *   E2E_BASE=http://localhost:4000 TENANT_SLUG=test node scripts/tenant-isolation-check.js
 *   node scripts/tenant-isolation-check.js --base http://116.62.32.162:8080
 *
 * 退出码: 0=全通过 / 1=有泄漏
 */

const BASE = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : (process.env.E2E_BASE || 'http://116.62.32.162:8080')
const TENANT_SLUG = process.env.TENANT_SLUG || 'test'
const PASSWORD    = process.env.E2E_PASSWORD || 'test1234'

// 测试账号 (dianjie tenant 13900000001-008, test tenant 短账号兼容)
const ACCOUNTS = {
  boss:    { id: '13900000003', alt: 'boss', role: 'ADMIN',           scope: 'tenant'   },
  manager: { id: '13900000004', alt: 'mgr',  role: 'MANAGER',         scope: 'store'    },
  kitchen: { id: '13900000005', alt: 'chef', role: 'KITCHEN_LEAD',    scope: 'store'    },
  finance: { id: '13900000006', alt: 'fin',  role: 'FINANCE',         scope: 'tenant'   },
  chef:    { id: '13900000002', alt: 'cd',   role: 'CHEF_DIRECTOR',   scope: 'tenant'   },
  supOwn:  { id: '13900000001', alt: 'sup1', role: 'SUPPLIER_OWNER',  scope: 'supplier' },
}

// list 类接口 + 期望的 scope key
// scopeKey: 服务端返回对象上, 用哪个字段做 owner 判断
// extract: 如何从响应里取数组 (有些是 { items: [...] }, 有些直接 [])
const SCOPED_ENDPOINTS = [
  { path: '/api/orders',                  extract: r => r.items || r,           supplierKey: 'supplierId', storeKey: 'storeId' },
  { path: '/api/loss-claims',             extract: r => r,                       supplierKey: 'supplierId', storeKey: 'storeId' },
  { path: '/api/schedules',               extract: r => r,                       supplierKey: 'supplierId', storeKey: 'storeId' },
  { path: '/api/payments?pageSize=20',    extract: r => r.items || [],           supplierKey: 'supplierId'                      },
  { path: '/api/invoices',                extract: r => r.items || r,            supplierKey: 'supplierId'                      },
  { path: '/api/invoice-payments/payable',extract: r => r,                       supplierKey: 'supplierId'                      },
  { path: '/api/reconciliations',         extract: r => r,                       supplierKey: 'supplierId'                      },
  { path: '/api/receipts?days=30',        extract: r => r.items || r,            supplierKey: 'supplierId', storeKey: 'storeId' },
]

// 敏感路由: forbid 列出的角色应 403
const FORBIDDEN_ENDPOINTS = [
  { path: '/api/cashbook/accounts',     forbid: ['supOwn', 'manager', 'kitchen', 'chef'] },
  { path: '/api/cashbook/transactions', forbid: ['supOwn', 'manager', 'kitchen', 'chef'] },
  { path: '/api/users',                 forbid: ['supOwn', 'manager', 'kitchen', 'chef'] },
  { path: '/api/budgets',               forbid: ['supOwn', 'manager', 'kitchen', 'chef'] },
  { path: '/api/capital/projects',      forbid: ['supOwn', 'chef'] },
  { path: '/api/cmb/balance',           forbid: ['supOwn', 'manager', 'kitchen', 'chef'] },
  // 2026-08 发现: 这三条老路由只用 isStoreScoped 兜，而供应商不是门店范围角色，
  // 过滤器为空 → 供应商 token 能读到全租户营业额、利润表和付给别家供应商的应付明细。
  { path: '/api/dashboard/stats',         forbid: ['supOwn'] },
  { path: '/api/dashboard/purchase-trend', forbid: ['supOwn'] },
  { path: '/api/revenue',                 forbid: ['supOwn'] },
  { path: '/api/revenue/summary',         forbid: ['supOwn'] },
  { path: '/api/profit/group/snapshot',   forbid: ['supOwn'] },
]

const tokens = {}
const users  = {}
const stats  = { pass: 0, fail: 0, leaks: [] }

function ok(msg)    { stats.pass++; console.log('  ✓', msg) }
function bad(msg)   { stats.fail++; stats.leaks.push(msg); console.log('  ✗', msg) }
function step(t)    { console.log('\n[' + t + ']') }

async function api(method, path, body, token) {
  const headers = { Authorization: token ? 'Bearer ' + token : '' }
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let data; try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data, ok: res.ok }
}

async function tryLogin(account) {
  // 先用主 id, 失败再 fallback 短账号
  for (const id of [account.id, account.alt]) {
    const r = await api('POST', '/api/auth/login', { identifier: id, password: PASSWORD, tenantSlug: TENANT_SLUG })
    if (r.ok) return { token: r.data.token, user: r.data.user }
  }
  return null
}

function checkScope(role, items, account, ep) {
  if (!Array.isArray(items)) return { ok: true, total: 0 }
  if (items.length === 0) return { ok: true, total: 0 }

  // tenant 级角色: 不检查 (BOSS/FINANCE/CHEF_DIRECTOR 看全租户是设计意图)
  if (account.scope === 'tenant') return { ok: true, total: items.length }

  // store 级: 应该所有 item 的 storeKey 字段 == user.storeId (或为空)
  if (account.scope === 'store' && ep.storeKey) {
    const myStoreId = users[role].storeId
    if (!myStoreId) return { ok: true, total: items.length, note: '账号未绑店' }
    const leaks = items.filter(it => it[ep.storeKey] && it[ep.storeKey] !== myStoreId)
    return {
      ok: leaks.length === 0,
      total: items.length,
      leakCount: leaks.length,
      sample: leaks[0]?.[ep.storeKey],
    }
  }

  // supplier 级: 应该所有 item 的 supplierKey 字段 == user.supplierId
  if (account.scope === 'supplier' && ep.supplierKey) {
    const mySupplierId = users[role].supplierId
    if (!mySupplierId) return { ok: false, total: items.length, note: '账号无 supplierId 绑定' }
    const leaks = items.filter(it => it[ep.supplierKey] && it[ep.supplierKey] !== mySupplierId)
    return {
      ok: leaks.length === 0,
      total: items.length,
      leakCount: leaks.length,
      sample: leaks[0]?.[ep.supplierKey],
    }
  }

  return { ok: true, total: items.length }
}

async function run() {
  console.log('================ 滇界 租户隔离回归 ================')
  console.log('BASE:  ', BASE)
  console.log('TENANT:', TENANT_SLUG)

  // ── 步骤 1: 全角色登录 ──
  step('1. 登录全部 6 角色')
  for (const [key, a] of Object.entries(ACCOUNTS)) {
    const r = await tryLogin(a)
    if (!r) {
      bad(`${key.padEnd(8)} 登录失败 (尝试了 ${a.id} 和 ${a.alt})`)
      continue
    }
    tokens[key] = r.token
    users[key]  = r.user
    ok(`${key.padEnd(8)} → ${r.user.role} ${r.user.storeId ? '/store=' + r.user.storeId.slice(-6) : ''} ${r.user.supplierId ? '/sup=' + r.user.supplierId.slice(-6) : ''}`)
  }

  // ── 步骤 2: list 接口 scope 校验 ──
  step('2. 列表接口数据 scope 校验')
  for (const ep of SCOPED_ENDPOINTS) {
    for (const [role, account] of Object.entries(ACCOUNTS)) {
      if (!tokens[role]) continue
      const r = await api('GET', ep.path, null, tokens[role])
      if (!r.ok) {
        // 200 / 403 / 401 都算预期 (供应商对 receipts 这种可能没权限); 5xx 才算错
        if (r.status >= 500) bad(`${role} GET ${ep.path} → ${r.status} ${JSON.stringify(r.data).slice(0,100)}`)
        else ok(`${role.padEnd(8)} ${ep.path.padEnd(34)} → ${r.status} (no data, skip scope)`)
        continue
      }
      const items = ep.extract(r.data) || []
      const result = checkScope(role, items, account, ep)
      if (result.ok) {
        ok(`${role.padEnd(8)} ${ep.path.padEnd(34)} ${String(result.total).padStart(3)} 条 ${result.note || '✓ scope'}`)
      } else {
        bad(`${role.padEnd(8)} ${ep.path.padEnd(34)} 共 ${result.total} 条, 其中 ${result.leakCount} 条越权 (示例 ${ep.storeKey || ep.supplierKey}=${result.sample})`)
      }
    }
  }

  // ── 步骤 3: 敏感接口 403 校验 ──
  step('3. 敏感接口禁止角色应 403')
  for (const ep of FORBIDDEN_ENDPOINTS) {
    for (const role of ep.forbid) {
      if (!tokens[role]) continue
      const r = await api('GET', ep.path, null, tokens[role])
      if (r.status === 403) ok(`${role.padEnd(8)} ${ep.path.padEnd(34)} 拒绝 ✓`)
      else bad(`${role.padEnd(8)} ${ep.path.padEnd(34)} 应 403 实为 ${r.status}`)
    }
  }

  // ── 总结 ──
  console.log('\n========== 总结 ==========')
  console.log(`通过: ${stats.pass}`)
  console.log(`失败: ${stats.fail}`)
  if (stats.fail > 0) {
    console.log('\n泄漏明细:')
    stats.leaks.forEach(l => console.log('  ✗', l))
    process.exit(1)
  } else {
    console.log('✓ 全部隔离规则通过')
  }
}

run().catch(e => {
  console.error('脚本异常:', e)
  process.exit(2)
})
