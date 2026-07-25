import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import {
  fireAndForgetNotifyProductChange,
  notifyProductChange,
} from '../../src/services/notify/productChange'

const suffix = `product-change-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let tenantAId = ''
let tenantBId = ''
let tenantCId = ''
let chefDirectorAId = ''
let chefDirectorInactiveAId = ''
let legacyChefAId = ''
let managerAId = ''
let adminAId = ''
let chefDirectorBId = ''
let managerCId = ''

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function createUser(data: {
  tenantId: string
  name: string
  role: any
  status?: any
  wecom?: string
}) {
  const user = await prisma.user.create({
    data: {
      tenantId: data.tenantId,
      name: data.name,
      email: `${suffix}-${data.tenantId}-${data.name}@local.test`,
      password: 'test',
      role: data.role,
      status: data.status || 'ACTIVE',
      wecomUserId: data.wecom || null,
    },
  })
  return user.id
}

describe('product change notification (integration)', () => {
  beforeAll(async () => {
    const [tenantA, tenantB, tenantC] = await Promise.all([
      prisma.tenant.create({ data: { name: `商品变更A ${suffix}`, slug: `pc-a-${suffix}` } }),
      prisma.tenant.create({ data: { name: `商品变更B ${suffix}`, slug: `pc-b-${suffix}` } }),
      prisma.tenant.create({ data: { name: `商品变更C ${suffix}`, slug: `pc-c-${suffix}` } }),
    ])
    tenantAId = tenantA.id
    tenantBId = tenantB.id
    tenantCId = tenantC.id

    chefDirectorAId = await createUser({
      tenantId: tenantAId, name: '总厨A', role: 'CHEF_DIRECTOR', wecom: 'wx-chef-a',
    })
    chefDirectorInactiveAId = await createUser({
      tenantId: tenantAId, name: '停用总厨A', role: 'CHEF_DIRECTOR', status: 'INACTIVE',
    })
    legacyChefAId = await createUser({
      tenantId: tenantAId, name: 'legacy总厨A', role: 'CHEF', wecom: 'wx-legacy-a',
    })
    managerAId = await createUser({
      tenantId: tenantAId, name: '店长A', role: 'MANAGER', wecom: 'wx-manager-a',
    })
    adminAId = await createUser({
      tenantId: tenantAId, name: '老板A', role: 'ADMIN', wecom: 'wx-admin-a',
    })

    chefDirectorBId = await createUser({
      tenantId: tenantBId, name: '总厨B', role: 'CHEF_DIRECTOR', wecom: 'wx-chef-b',
    })

    managerCId = await createUser({
      tenantId: tenantCId, name: '店长C', role: 'MANAGER', wecom: 'wx-manager-c',
    })
  })

  afterAll(async () => {
    for (const tenantId of [tenantAId, tenantBId, tenantCId]) {
      if (!tenantId) continue
      await prisma.notificationLog.deleteMany({ where: { tenantId } })
      await prisma.notification.deleteMany({ where: { tenantId } })
      await prisma.user.deleteMany({ where: { tenantId } })
      await prisma.tenant.delete({ where: { id: tenantId } })
    }
  })

  it('notifies each active CHEF_DIRECTOR and legacy CHEF in the same tenant, excluding others', async () => {
    const productId = `prod-a-${suffix}`
    const eventKey = `PRODUCT:${productId}:PRICE_CHANGE:${Date.now()}`

    const result = await notifyProductChange({
      tenantId: tenantAId,
      productId,
      action: 'PRICE_CHANGE',
      operatorId: adminAId,
      eventKey,
      before: { name: '清远鸡', price: 26, status: 'ENABLED' },
      after: { name: '清远鸡', price: 22, status: 'ENABLED' },
    })

    expect(result.skipped.noRecipients).toBe(false)
    expect(new Set(result.notifiedUserIds)).toEqual(new Set([chefDirectorAId, legacyChefAId]))

    const notifications = await prisma.notification.findMany({
      where: { tenantId: tenantAId, type: 'PRODUCT_CHANGED', refId: productId },
    })
    expect(notifications).toHaveLength(2)

    for (const n of notifications) {
      expect(n.recipientRole).toBe('CHEF_DIRECTOR')
      expect(n.recipientId).toBeTruthy()
      expect(n.dedupeKey).toBe(`${eventKey}:${n.recipientId}`)
      expect(n.title).toContain('调价')
      expect(n.body).toContain('清远鸡')
      expect(n.body).toContain('26')
      expect(n.body).toContain('22')
    }

    const notifiedRecipientIds = new Set(notifications.map((n) => n.recipientId))
    expect(notifiedRecipientIds).toEqual(new Set([chefDirectorAId, legacyChefAId]))

    // 非总厨角色、INACTIVE 总厨、其它租户均不应收到系统消息
    expect(notifications.some((n) => n.recipientId === chefDirectorInactiveAId)).toBe(false)
    expect(notifications.some((n) => n.recipientId === managerAId)).toBe(false)
    expect(notifications.some((n) => n.recipientId === adminAId)).toBe(false)
    expect(notifications.some((n) => n.recipientId === chefDirectorBId)).toBe(false)
  })

  it('sends WeCom to the exact same user list and logs failure without throwing', async () => {
    const productId = `prod-wecom-${suffix}`
    const eventKey = `PRODUCT:${productId}:UPDATE:${Date.now()}`

    // 本环境未配置企微, 外部投递会失败, 但不应抛回调用方
    await expect(notifyProductChange({
      tenantId: tenantAId,
      productId,
      action: 'UPDATE',
      operatorId: adminAId,
      eventKey,
      before: { name: '土豆牛腩', spec: '500g/份' },
      after: { name: '土豆牛腩', spec: '600g/份' },
    })).resolves.toBeDefined()

    const logs = await prisma.notificationLog.findMany({
      where: { tenantId: tenantAId, eventType: 'PRODUCT_CHANGED', eventKey },
    })
    expect(logs.length).toBeGreaterThanOrEqual(2)

    const logUserIds = new Set(logs.map((l) => l.userId))
    expect(logUserIds).toEqual(new Set([chefDirectorAId, legacyChefAId]))

    // 失败记录写入 NotificationLog, 留下可重试证据
    const failedLogs = logs.filter((l) => l.status === 'failed')
    expect(failedLogs.length).toBeGreaterThanOrEqual(2)
    for (const log of failedLogs) {
      expect(log.channel).toBe('wecom')
      expect(log.errorMsg).toBeTruthy()
    }

    // 不应包含其它角色/租户
    expect(logs.some((l) => l.userId === managerAId)).toBe(false)
    expect(logs.some((l) => l.userId === chefDirectorBId)).toBe(false)
    expect(logs.some((l) => l.userId === chefDirectorInactiveAId)).toBe(false)
  })

  it('is idempotent: repeated calls do not duplicate system notifications', async () => {
    const productId = `prod-idem-${suffix}`
    const eventKey = `PRODUCT:${productId}:ENABLE:${Date.now()}`

    const input = {
      tenantId: tenantAId,
      productId,
      action: 'ENABLE',
      operatorId: adminAId,
      eventKey,
      before: { name: '酸汤鱼', status: 'DISABLED' },
      after: { name: '酸汤鱼', status: 'ENABLED' },
    }

    await notifyProductChange(input)
    await notifyProductChange(input)

    const notifications = await prisma.notification.findMany({
      where: { tenantId: tenantAId, type: 'PRODUCT_CHANGED', refId: productId },
    })
    expect(notifications).toHaveLength(2)
    expect(new Set(notifications.map((n) => n.recipientId))).toEqual(
      new Set([chefDirectorAId, legacyChefAId]),
    )
  })

  it('skips notification when no chef director exists', async () => {
    const productId = `prod-empty-${suffix}`
    const eventKey = `PRODUCT:${productId}:CREATE:${Date.now()}`

    const result = await notifyProductChange({
      tenantId: tenantCId,
      productId,
      action: 'CREATE',
      operatorId: managerCId,
      eventKey,
      before: {},
      after: { name: '新品测试', category: '蔬菜' },
    })

    expect(result.skipped.noRecipients).toBe(true)
    expect(result.notifiedUserIds).toHaveLength(0)

    const notifications = await prisma.notification.findMany({
      where: { tenantId: tenantCId, type: 'PRODUCT_CHANGED' },
    })
    expect(notifications).toHaveLength(0)
  })

  it('fireAndForget wrapper does not throw and still writes failure log', async () => {
    const productId = `prod-fire-${suffix}`
    const eventKey = `PRODUCT:${productId}:DISABLE:${Date.now()}`

    // fireAndForget 是同步返回, 不应抛出
    expect(() => {
      fireAndForgetNotifyProductChange({
        tenantId: tenantAId,
        productId,
        action: 'DISABLE',
        operatorId: adminAId,
        eventKey,
        before: { name: '测试停售品', status: 'ENABLED' },
        after: { name: '测试停售品', status: 'DISABLED' },
      })
    }).not.toThrow()

    await sleep(800)

    const logs = await prisma.notificationLog.findMany({
      where: { tenantId: tenantAId, eventType: 'PRODUCT_CHANGED', eventKey, status: 'failed' },
    })
    expect(logs.length).toBeGreaterThanOrEqual(2)
    expect(new Set(logs.map((l) => l.userId))).toEqual(new Set([chefDirectorAId, legacyChefAId]))
  })
})
