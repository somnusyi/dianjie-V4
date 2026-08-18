import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 2026-08 发现:生产上有 9 个页面是纯手写假数据(零取数)，写着「国贸店 ¥320,000」
 * 「望京 SOHO 店」这类不存在的门店和编造的经营数字，顶栏甚至是「火锅连锁管理系统 · 王总」，
 * 连业态和品牌都不是云洱之境，而且没有任何 demo 标记。
 *
 * 这比报错危险一个量级:报错谁都看得见，而这些数字恰好都在「像真的」的量级上，
 * 老板在 PC 上看一眼就可能拿它做决策，永远不会触发怀疑。
 *
 * 所以这条测试的规则是:v2 下的每个页面，要么真的去取数，要么明确 404 下线，
 * 要么是转发 shim，要么在下面这份白名单里说明为什么它可以是静态的。
 * 新增一个既不取数又渲染业务数字的页面，会在这里被拦下。
 */

const V2_ROOT = path.join(__dirname)

/** 确实不需要取数的页面，每条都要写清楚理由。 */
const STATIC_PAGE_ALLOWLIST: Record<string, string> = {
  'wecom-bridge/page.tsx': '企微 OAuth 跳转桥页，只做重定向',
  'boss/payment-onboarding/page.tsx': '收款接入 checklist，状态存 localStorage，不展示经营数据',
}

function collectPages(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectPages(full, acc)
    else if (entry.name === 'page.tsx') acc.push(full)
  }
  return acc
}

describe('v2 页面不得渲染编造的业务数据', () => {
  const pages = collectPages(V2_ROOT)

  it('扫描到的页面数量是合理的（防止用例因路径写错而空跑）', () => {
    expect(pages.length).toBeGreaterThan(50)
  })

  it('每个页面要么取数、要么已下线、要么是转发、要么在白名单里', () => {
    const offenders: string[] = []
    for (const file of pages) {
      const rel = path.relative(V2_ROOT, file).split(path.sep).join('/')
      if (STATIC_PAGE_ALLOWLIST[rel]) continue
      const source = fs.readFileSync(file, 'utf8')
      const fetchesData = /apiFetch|fetch\(|useSWR/.test(source)
      const isRetired = /notFound\(\)/.test(source)
      const isReExport = /^export \{ default \}/m.test(source)
      if (!fetchesData && !isRetired && !isReExport) offenders.push(rel)
    }
    expect(offenders, `以下页面既不取数也未下线，可能在渲染硬编码的业务数字:\n${offenders.join('\n')}`)
      .toEqual([])
  })

  it('已下线的页面不残留假门店名', () => {
    const fabricated = ['国贸店', '望京', '朝阳大悦城', '三里屯店', '五道口店', '火锅连锁管理系统']
    const leaks: string[] = []
    for (const file of pages) {
      const source = fs.readFileSync(file, 'utf8')
      for (const token of fabricated) {
        if (source.includes(token)) leaks.push(`${path.relative(V2_ROOT, file)} → ${token}`)
      }
    }
    expect(leaks, `页面里仍有编造的门店/品牌名:\n${leaks.join('\n')}`).toEqual([])
  })
})
