import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'
import { ensurePaymentDueReminder } from '../src/services/scheduler'

const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 账期提醒完整性验证仅允许本地 PREVIEW_MODE 隔离库')
  }
}

async function main() {
  assertLocalOnly()
  const suffix = Date.now().toString(36)
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const store = await prisma.store.create({
    data: { tenantId: tenant.id, no: `REM-${suffix}`, name: `提醒验证门店-${suffix}` },
  })
  const supplier = await prisma.supplier.create({
    data: { tenantId: tenant.id, no: `REMS-${suffix}`, name: `提醒验证供应商-${suffix}` },
  })
  const actor = await prisma.user.create({
    data: {
      tenantId: tenant.id, storeId: store.id, storeIds: [store.id], name: '提醒验证店长',
      email: `payment-reminder-${suffix}@local.test`, password: await bcrypt.hash('local-only', 10), role: 'MANAGER',
    },
  })
  const receipt = await prisma.receipt.create({
    data: {
      tenantId: tenant.id, no: `RK-REM-${suffix}`, storeId: store.id, supplierId: supplier.id,
      deliveryDate: new Date(), totalAmount: 321.09, status: 'ACCOUNTED', confirmedAt: new Date(), createdById: actor.id,
    },
  })
  const schedule = await prisma.paymentSchedule.create({
    data: {
      tenantId: tenant.id, receiptId: receipt.id, supplierId: supplier.id, storeId: store.id,
      amount: receipt.totalAmount, creditDays: 3, confirmedAt: receipt.confirmedAt!,
      dueAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), status: 'PENDING',
    },
  })
  const markerFunction = `payment_reminder_marker_${suffix}`
  const markerTrigger = `${markerFunction}_trigger`
  const notificationFunction = `payment_reminder_notification_${suffix}`
  const notificationTrigger = `${notificationFunction}_trigger`
  const key3 = `PaymentSchedule:${schedule.id}:DUE_REMINDER_3DAY`
  const key1 = `PaymentSchedule:${schedule.id}:DUE_REMINDER_1DAY`

  try {
    const concurrent = await Promise.all([
      ensurePaymentDueReminder(schedule.id, '3DAY'),
      ensurePaymentDueReminder(schedule.id, '3DAY'),
    ])
    assert.equal(concurrent.filter(result => result.created).length, 1)
    assert.equal(await prisma.notification.count({ where: { tenantId: tenant.id, dedupeKey: key3 } }), 1)
    assert.equal((await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: schedule.id } })).notified3Days, true)

    await prisma.notification.deleteMany({ where: { tenantId: tenant.id, dedupeKey: key3 } })
    await prisma.paymentSchedule.update({ where: { id: schedule.id }, data: { notified3Days: false } })
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${markerFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${schedule.id}' AND NEW."notified3Days" = true THEN
          RAISE EXCEPTION 'forced reminder marker failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${markerTrigger}" BEFORE UPDATE ON "payment_schedules"
      FOR EACH ROW EXECUTE FUNCTION "${markerFunction}"()
    `)
    await assert.rejects(() => ensurePaymentDueReminder(schedule.id, '3DAY'), /forced reminder marker failure/)
    assert.equal(await prisma.notification.count({ where: { tenantId: tenant.id, dedupeKey: key3 } }), 1)
    assert.equal((await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: schedule.id } })).notified3Days, false)
    await prisma.$executeRawUnsafe(`DROP TRIGGER "${markerTrigger}" ON "payment_schedules"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION "${markerFunction}"()`)
    const recoveredMarker = await ensurePaymentDueReminder(schedule.id, '3DAY')
    assert.equal(recoveredMarker.duplicated, true, '标记恢复不得二次创建或触达通知')
    assert.equal(await prisma.notification.count({ where: { tenantId: tenant.id, dedupeKey: key3 } }), 1)
    assert.equal((await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: schedule.id } })).notified3Days, true)

    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${notificationFunction}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."dedupeKey" = '${key1}' THEN
          RAISE EXCEPTION 'forced reminder notification failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${notificationTrigger}" BEFORE INSERT ON "notifications"
      FOR EACH ROW EXECUTE FUNCTION "${notificationFunction}"()
    `)
    await assert.rejects(() => ensurePaymentDueReminder(schedule.id, '1DAY'), /forced reminder notification failure/)
    assert.equal(await prisma.notification.count({ where: { tenantId: tenant.id, dedupeKey: key1 } }), 0)
    assert.equal((await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: schedule.id } })).notified1Day, false)
    await prisma.$executeRawUnsafe(`DROP TRIGGER "${notificationTrigger}" ON "notifications"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION "${notificationFunction}"()`)
    const recoveredNotification = await ensurePaymentDueReminder(schedule.id, '1DAY')
    assert.equal(recoveredNotification.created, true)
    assert.equal(await prisma.notification.count({ where: { tenantId: tenant.id, dedupeKey: key1 } }), 1)
    assert.equal((await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: schedule.id } })).notified1Day, true)

    console.log(JSON.stringify({
      ok: true,
      concurrentReminderAtMostOnce: true,
      markerFailureRetriesWithoutDuplicateNotification: true,
      notificationFailureDoesNotAdvanceMarker: true,
      reminderKindsIndependent: true,
    }))
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${markerTrigger}" ON "payment_schedules"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${markerFunction}"()`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${notificationTrigger}" ON "notifications"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${notificationFunction}"()`).catch(() => {})
    await prisma.notification.deleteMany({ where: { tenantId: tenant.id, dedupeKey: { in: [key3, key1] } } })
    await prisma.paymentSchedule.delete({ where: { id: schedule.id } })
    await prisma.receipt.delete({ where: { id: receipt.id } })
    await prisma.user.delete({ where: { id: actor.id } })
    await prisma.store.delete({ where: { id: store.id } })
    await prisma.supplier.delete({ where: { id: supplier.id } })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
