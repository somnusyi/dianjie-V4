#!/usr/bin/env node
/**
 * UI Smoke Test (Playwright headless)
 *
 * 用途: API 通过不代表 UI 没问题. 这个脚本用 headless 浏览器跑 6 角色登录 + 关键页面渲染,
 *       捕获白屏 / 路由 404 / JS 报错 / 关键元素缺失.
 *
 * 用法:
 *   node scripts/ui-smoke.js                   # 默认 ECS
 *   node scripts/ui-smoke.js --headed          # 显示浏览器看着跑
 *   node scripts/ui-smoke.js --base http://...
 */

const { chromium } = require('playwright')

const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'http://116.62.32.162:8080'
const HEADED = process.argv.includes('--headed')

// keyText 每个角色用其实际 BottomNav 文字 (不同角色 label 不同)
const ACCOUNTS = {
  boss:    { phone: '13900000003', expectURL: /\/v2\/boss\/home/,    keyText: ['集团'] },
  manager: { phone: '13900000004', expectURL: /\/v2\/manager\/home/, keyText: ['店长'] },
  kitchen: { phone: '13900000005', expectURL: /\/v2\/chef\/home/,    keyText: ['厨师长'] },
  finance: { phone: '13900000006', expectURL: /\/v2\/finance\/home/, keyText: ['工作台', '资金'] },
  chef:    { phone: '13900000002', expectURL: /\/v2\/chef-director/, keyText: ['工作台', '审批'] },
  supplier:{ phone: '13900000001', expectURL: /\/v2\/supplier\/home/,keyText: ['订单', '库存'] },
}

const pagesToVisit = {
  supplier: [
    { path: '/v2/supplier/orders', mustNotContain: ['页面不存在', '404'] },
    { path: '/v2/supplier/products', mustNotContain: ['页面不存在', 'undefined'] },
    { path: '/v2/supplier/inventory', mustNotContain: ['页面不存在'] },
  ],
  chef: [
    { path: '/v2/chef-director/approvals', mustNotContain: ['页面不存在'] },
  ],
  boss: [
    { path: '/v2/boss/approvals', mustNotContain: ['页面不存在'] },
    { path: '/v2/boss/stores', mustNotContain: ['页面不存在'] },
  ],
}

const stats = { pass: 0, fail: 0, errors: [] }
function ok(msg) { stats.pass++; console.log('  ✓', msg) }
function bad(msg, e) { stats.fail++; stats.errors.push(msg + (e ? ' → ' + e : '')); console.log('  ✗', msg, e ? '→ ' + e : '') }

async function loginAs(page, account) {
  await page.goto(BASE + '/v2/login')
  await page.waitForLoadState('networkidle')
  await page.fill('input[placeholder*="13800138000"]', account.phone)
  await page.fill('input[type="password"]', 'test1234')
  // 等密码栏的两个 input 都填好
  await page.click('button:has-text("登录")')
  // 等跳转
  await page.waitForURL(account.expectURL, { timeout: 10000 })
  // BottomNav / 仪表盘内容是 client 加载, networkidle 后再等 1.5s 渲染稳定
  await page.waitForTimeout(1500)
}

async function run() {
  console.log('================ UI Smoke ================')
  console.log('BASE:', BASE, '· HEADED:', HEADED)
  const browser = await chromium.launch({ headless: !HEADED })
  const consoleErrors = []

  for (const [key, account] of Object.entries(ACCOUNTS)) {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    page.on('pageerror', err => consoleErrors.push(`[${key}] ${err.message}`))
    page.on('response', r => { if (r.status() >= 500) consoleErrors.push(`[${key}] ${r.status()} ${r.url()}`) })

    try {
      console.log('\n[' + key + ']')
      await loginAs(page, account)
      const url = page.url()
      if (account.expectURL.test(url)) ok(`登录跳转 OK (${url.replace(BASE,'')})`)
      else bad(`登录跳转错: ${url}`)

      // 用 innerText 拿可见文字, 避免误报 RSC payload 里的 $undefined
      const visible = await page.locator('body').innerText().catch(() => '')
      for (const t of account.keyText) {
        if (visible.includes(t)) ok(`首页含 "${t}"`)
        else bad(`首页缺 "${t}"`)
      }

      const sub = pagesToVisit[key] || []
      for (const visit of sub) {
        try {
          await page.goto(BASE + visit.path)
          await page.waitForLoadState('networkidle', { timeout: 10000 })
          const h = await page.locator('body').innerText().catch(() => '')
          let allClear = true
          for (const must of (visit.mustNotContain || [])) {
            if (h.includes(must)) { bad(`${visit.path} 含 "${must}"`); allClear = false }
          }
          if (allClear) ok(`${visit.path} 渲染 OK`)
        } catch (e) {
          bad(`${visit.path}`, e.message?.slice(0,80))
        }
      }
    } catch (e) {
      bad(`${key} 流程`, e.message?.slice(0, 200))
    } finally {
      await ctx.close()
    }
  }

  await browser.close()

  if (consoleErrors.length > 0) {
    console.log('\n⚠ 控制台/网络错误:')
    consoleErrors.slice(0, 20).forEach(e => console.log('  ·', e.slice(0, 200)))
  }

  console.log('\n================ 结果 ================')
  console.log(`✓ 通过 ${stats.pass}  ✗ 失败 ${stats.fail}  · 控制台错误 ${consoleErrors.length}`)
  if (stats.fail > 0) {
    console.log('\n失败明细:')
    stats.errors.forEach(e => console.log(' -', e))
    process.exit(1)
  } else { console.log('🎉 全部通过') }
}

run().catch(e => { console.error('💥', e); process.exit(2) })
