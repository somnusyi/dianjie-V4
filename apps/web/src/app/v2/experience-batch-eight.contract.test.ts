import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NOTIFICATION_TYPE_LABEL, notificationRefLink } from '@/lib/notification-routing'

const root = resolve(process.cwd(), 'src/app')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('操作体验批次八旧入口收口', () => {
  it('旧登录成功后按用户角色进入 v2 落地页', () => {
    const source = read('login/page.tsx')
    expect(source).toContain('setSession(res.data.token, res.data.user, res.data.tenant, res.data.refreshToken)')
    expect(source).toContain('router.replace(routeForRole(res.data.user.role))')
    expect(source).not.toContain("router.push('/dashboard')")
  })

  it.each(['payments', 'reconciliations', 'schedules', 'design-system'])(
    '旧孤儿路由 %s 保留源码但入口返回 not found',
    (route) => {
      expect(read(`${route}/layout.tsx`)).toContain('notFound()')
      expect(read(`${route}/page.tsx`).length).toBeGreaterThan(0)
    },
  )

  it('列表入口不伪装成直接接单/拒单，差异确认明确动作和金额', () => {
    const orders = read('v2/supplier/orders/page.tsx')
    const differences = read('v2/supplier/differences/page.tsx')
    expect(orders).toContain('查看订单并处理')
    expect(orders).not.toContain('>拒单</a>')
    expect(orders).not.toContain('>接单</a>')
    expect(differences).toContain('提出异议')
    expect(differences).toContain('{kindMeta.supplierActionLabel} ¥{Number(claim.totalLossAmount).toFixed(2)}')
  })

  it('超级管理员首页直接提供深层治理功能入口', () => {
    const home = read('v2/boss/home/page.tsx')
    expect(home).toContain('href="/v2/boss/assistant"')
    expect(home).toContain('href="/v2/boss/autofix"')
  })

  it('供应商确认对账通知带财务可执行深链', () => {
    const notification = {
      id: 'notification-1',
      type: 'UPSTREAM_SETTLEMENT_CONFIRMED',
      title: '上游对账单待锁定',
      body: '供应商已确认',
      refType: 'UpstreamSettlementStatement',
      refId: 'statement-1',
      read: false,
      createdAt: '2026-09-28T00:00:00.000Z',
    }
    expect(NOTIFICATION_TYPE_LABEL[notification.type]).toBe('上游对账待锁定')
    expect(notificationRefLink(notification, 'FINANCE')).toBe('/v2/finance-pc/upstream-settlements?statementId=statement-1')
    expect(notificationRefLink(notification, 'SUPPLIER_OWNER')).toBeNull()
  })

  it('店长采购与验收保持在 manager 路由空间', () => {
    const drawer = read('v2/manager/_drawer.tsx')
    const home = read('v2/manager/home/page.tsx')
    expect(drawer).toContain("href: '/v2/manager/purchase/new'")
    expect(home).toContain('/v2/manager/purchase/${o.id}/receive')
    expect(read('v2/manager/purchase/new/page.tsx')).toContain('chef/purchase/new/page')
    expect(read('v2/manager/purchase/[id]/receive/page.tsx')).toContain('chef/purchase/[id]/receive/page')
    expect(read('v2/chef/purchase/[id]/receive/page.tsx')).toContain("managerContext ? '/v2/manager/home' : '/v2/chef/check/new'")
  })

  it('移动单据卡片中的可编辑字段保留程序化名称', () => {
    const docs = read('v2/supply-chain/docs/page.tsx')
    expect(docs).toContain('aria-label={`${line.productName}数量`}')
    expect(docs).toContain('aria-label={`${line.productName}金额`}')
    expect(docs).toContain('aria-label={`${line.productName}备注`}')
  })
})
