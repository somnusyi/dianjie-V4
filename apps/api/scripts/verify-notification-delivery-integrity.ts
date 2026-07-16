import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { createSigner } from 'fast-jwt'
import { prisma } from '@dianjie/db'
import { completeNotificationDelivery, reserveNotificationDelivery } from '../src/services/notify'

const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 通知投递完整性验证仅允许本地 PREVIEW_MODE 隔离库')
  }
  if (!/^http:\/\/(localhost|127\.0\.0\.1):/.test(API_BASE)) throw new Error('安全护栏: 只允许本地 API')
}

async function markRead(id: string, token: string) {
  return fetch(`${API_BASE}/api/notifications/${id}/read`, {
    method: 'PATCH', headers: { authorization: `Bearer ${token}` },
  })
}

async function authenticated(path: string, token: string, method = 'GET') {
  return fetch(`${API_BASE}/api/notifications${path}`, {
    method, headers: { authorization: `Bearer ${token}` },
  })
}

async function main() {
  assertLocalOnly()
  const suffix = Date.now().toString(36)
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '通知并发验证账号', email: `notification-delivery-${suffix}@local.test`,
      password: await bcrypt.hash('local-only', 10), role: 'FINANCE',
    },
  })
  const otherUser = await prisma.user.create({
    data: {
      tenantId: tenant.id, name: '通知越权验证账号', email: `notification-other-${suffix}@local.test`,
      password: await bcrypt.hash('local-only', 10), role: 'FINANCE',
    },
  })
  const eventPrefix = `LOCAL-NOTIFY-${suffix}`
  const functionName = `notification_delivery_${suffix}`
  const triggerName = `${functionName}_trigger`
  const reserve = (eventKey: string, bypassFrequency = false) => reserveNotificationDelivery({
    tenantId: tenant.id,
    userId: user.id,
    eventType: 'LOCAL_VERIFY',
    eventKey,
    channel: 'wecom',
    payload: { localOnly: true },
    bypassFrequency,
  })

  try {
    const concurrentKey = `${eventPrefix}:CONCURRENT`
    const concurrent = await Promise.all(Array.from({ length: 20 }, () => reserve(concurrentKey)))
    const concurrentIds = concurrent.filter((id): id is string => Boolean(id))
    assert.equal(concurrentIds.length, 1, '20 个并发实例必须只有一个获得外部投递权')
    assert.equal(await prisma.notificationLog.count({ where: { tenantId: tenant.id, userId: user.id, eventKey: concurrentKey } }), 1)
    await completeNotificationDelivery(concurrentIds[0], 'sent')
    assert.equal(await reserve(concurrentKey), null, '已发送事件在频控窗口内不得重新预留')

    const retryKey = `${eventPrefix}:FAILED-RETRY`
    const firstFailed = await reserve(retryKey)
    assert.ok(firstFailed)
    await completeNotificationDelivery(firstFailed!, 'failed', 'local forced provider failure')
    const retryReservation = await reserve(retryKey)
    assert.ok(retryReservation, '外部发送失败必须允许下一次安全重试')
    assert.notEqual(retryReservation, firstFailed)

    const staleKey = `${eventPrefix}:STALE`
    const stale = await reserve(staleKey)
    assert.ok(stale)
    await prisma.notificationLog.update({
      where: { id: stale! }, data: { createdAt: new Date(Date.now() - 6 * 60 * 1000) },
    })
    const staleRecovery = await reserve(staleKey)
    assert.ok(staleRecovery, '崩溃遗留 processing 占位超过频控窗口后必须可恢复')

    const bypassKey = `${eventPrefix}:BYPASS`
    const bypass = await Promise.all([reserve(bypassKey, true), reserve(bypassKey, true)])
    assert.equal(bypass.filter(Boolean).length, 2, '显式 bypassFrequency 应保留紧急重复触达语义')

    const failureKey = `${eventPrefix}:AUDIT-FAILURE`
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."eventKey" = '${failureKey}' THEN
          RAISE EXCEPTION 'forced notification reservation failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "notification_logs"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `)
    await assert.rejects(() => reserve(failureKey), /forced notification reservation failure/)
    assert.equal(await prisma.notificationLog.count({ where: { tenantId: tenant.id, eventKey: failureKey } }), 0)

    const direct = await prisma.notification.create({
      data: {
        tenantId: tenant.id, recipientId: user.id, recipientRole: user.role,
        type: 'LOCAL_VERIFY', title: '通知归属验证', body: '仅指定用户可标记已读',
      },
    })
    const sign = createSigner({ key: process.env.JWT_SECRET || 'local-development-only-jwt-secret', expiresIn: 7_200_000 })
    const tokenFor = (target: typeof user) => sign({
      userId: target.id, tenantId: tenant.id, role: target.role, typ: 'access', ver: 0,
    })
    const otherToken = tokenFor(otherUser)
    const intendedToken = tokenFor(user)
    assert.equal((await authenticated('?page=NaN', otherToken)).status, 400)
    assert.equal((await authenticated('?forged=true', otherToken)).status, 400)
    const otherList = await authenticated('?unreadOnly=true&page=1&pageSize=50', otherToken)
    assert.equal(otherList.status, 200)
    assert.equal((await otherList.json() as any).items.some((item: any) => item.id === direct.id), false)
    assert.equal((await authenticated('/read-all', otherToken, 'PATCH')).status, 200)
    assert.equal((await prisma.notification.findUniqueOrThrow({ where: { id: direct.id } })).read, false)
    assert.equal((await markRead(direct.id, otherToken)).status, 404)
    assert.equal((await prisma.notification.findUniqueOrThrow({ where: { id: direct.id } })).read, false)
    const intendedList = await authenticated('?unreadOnly=true&page=1&pageSize=50', intendedToken)
    assert.equal(intendedList.status, 200)
    assert.equal((await intendedList.json() as any).items.some((item: any) => item.id === direct.id), true)
    assert.equal((await markRead(direct.id, intendedToken)).status, 200)
    assert.equal((await prisma.notification.findUniqueOrThrow({ where: { id: direct.id } })).read, true)

    console.log(JSON.stringify({
      ok: true,
      twentyWayConcurrentReservationSingleWinner: true,
      sentSuppressedWithinWindow: true,
      failedDeliveryRetryable: true,
      staleProcessingRecoverable: true,
      bypassFrequencyPreserved: true,
      reservationFailureFailClosed: true,
      directNotificationReadIsolated: true,
      directNotificationListAndReadAllIsolated: true,
      notificationListQueryValidated: true,
    }))
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "notification_logs"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`).catch(() => {})
    await prisma.notificationLog.deleteMany({
      where: { tenantId: tenant.id, userId: user.id, eventKey: { startsWith: eventPrefix } },
    })
    await prisma.notification.deleteMany({ where: { tenantId: tenant.id, recipientId: { in: [user.id, otherUser.id] } } })
    await prisma.user.deleteMany({ where: { id: { in: [user.id, otherUser.id] } } })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
