import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'
import { completeNotificationDelivery, reserveNotificationDelivery } from '../src/services/notify'

const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 通知投递完整性验证仅允许本地 PREVIEW_MODE 隔离库')
  }
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

    console.log(JSON.stringify({
      ok: true,
      twentyWayConcurrentReservationSingleWinner: true,
      sentSuppressedWithinWindow: true,
      failedDeliveryRetryable: true,
      staleProcessingRecoverable: true,
      bypassFrequencyPreserved: true,
      reservationFailureFailClosed: true,
    }))
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "notification_logs"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`).catch(() => {})
    await prisma.notificationLog.deleteMany({
      where: { tenantId: tenant.id, userId: user.id, eventKey: { startsWith: eventPrefix } },
    })
    await prisma.user.delete({ where: { id: user.id } })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
