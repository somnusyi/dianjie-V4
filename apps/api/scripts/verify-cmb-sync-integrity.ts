import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { Prisma, prisma } from '@dianjie/db'
import { applyCmbTransaction, isCmbSyncEnabled, syncAllCmbAccounts } from '../src/services/cmbAutoSync'
import type { CmbTransaction } from '../src/services/cmbPayment'

const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏: 招行同步完整性验证仅允许本地 PREVIEW_MODE 隔离库')
  }
}

function bankTransaction(sequence: string, amount: string, direction: 'C' | 'D' = 'C'): CmbTransaction {
  return {
    date: '20260716', time: '120000', sequence, direction, amount,
    counterName: '本地伪银行对手方', counterAcct: 'LOCAL-ONLY',
    remark: `本地测试 ${sequence}`, yurRef: '',
  }
}

async function main() {
  assertLocalOnly()
  assert.equal(isCmbSyncEnabled(), false, '预览环境必须硬性关闭招行同步')
  assert.deepEqual(await syncAllCmbAccounts(1), [], '关闭时不得枚举账户或访问银行')

  const suffix = Date.now().toString(36)
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const actor = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      name: '招行同步完整性财务',
      email: `cmb-sync-${suffix}@local.test`,
      password: await bcrypt.hash('local-only', 10),
      role: 'FINANCE',
    },
  })
  const account = await prisma.cashAccount.create({
    data: {
      tenantId: tenant.id, name: `招行同步完整性账户-${suffix}`,
      type: 'BANK', balance: 100, cmbBindAccount: `LOCAL-${suffix}`, status: 'ACTIVE',
    },
  })
  const otherAccount = await prisma.cashAccount.create({
    data: {
      tenantId: tenant.id, name: `招行同步完整性对手账户-${suffix}`,
      type: 'BANK', balance: 50, status: 'ACTIVE',
    },
  })
  const triggerName = `cmb_sync_guard_${suffix.replace(/[^a-z0-9]/gi, '_')}`
  const functionName = `${triggerName}_fn`

  const apply = (transaction: CmbTransaction) => applyCmbTransaction({
    tenantId: tenant.id,
    cashAccountId: account.id,
    cmbAccount: account.cmbBindAccount!,
    actorId: actor.id,
    transaction,
  })

  try {
    const duplicate = await Promise.all([
      apply(bankTransaction(`SEQ-${suffix}-25`, '25.00')),
      apply(bankTransaction(`SEQ-${suffix}-25`, '25.00')),
    ])
    assert.equal(duplicate.filter(result => result.created).length, 1)
    assert.equal(new Set(duplicate.map(result => result.cashTransactionId)).size, 1)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: account.id } })).balance), 125)
    const syncKey25 = duplicate[0].syncKey
    assert.equal(await prisma.cashTransaction.count({
      where: { tenantId: tenant.id, accountId: account.id, refType: 'CmbAutoSync', refId: syncKey25 },
    }), 1)

    const concurrentDistinct = await Promise.all([
      apply(bankTransaction(`SEQ-${suffix}-5`, '-5.00', 'D')),
      apply(bankTransaction(`SEQ-${suffix}-10`, '-10.00', 'D')),
    ])
    assert.ok(concurrentDistinct.every(result => result.created))
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: account.id } })).balance), 110)
    const last = await prisma.cashTransaction.findFirst({
      where: { tenantId: tenant.id, accountId: account.id, refType: 'CmbAutoSync' },
      orderBy: { createdAt: 'desc' },
    })
    assert.equal(Number(last?.balanceAfter), 110)

    await assert.rejects(
      () => apply(bankTransaction(`SEQ-${suffix}-BAD`, 'not-money')),
      /金额无效/,
    )

    const directRef = `internal-${suffix}`
    await prisma.cashTransaction.createMany({
      data: [
        {
          tenantId: tenant.id, accountId: account.id, direction: -1, category: 'internal-transfer',
          amount: 1, balanceAfter: 109, txDate: new Date(), refType: 'CMB_INTERNAL', refId: directRef,
          createdById: actor.id,
        },
        {
          tenantId: tenant.id, accountId: otherAccount.id, direction: 1, category: 'internal-transfer',
          amount: 1, balanceAfter: 51, txDate: new Date(), refType: 'CMB_INTERNAL', refId: directRef,
          createdById: actor.id,
        },
      ],
    })
    await assert.rejects(
      () => prisma.cashTransaction.create({
        data: {
          tenantId: tenant.id, accountId: account.id, direction: -1, category: 'duplicate',
          amount: 1, balanceAfter: 108, txDate: new Date(), refType: 'CMB_INTERNAL', refId: directRef,
          createdById: actor.id,
        },
      }),
      (error: any) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002',
    )

    const rollbackSequence = `SEQ-${suffix}-ROLLBACK`
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."entityType" = 'CashTransaction'
           AND NEW."metadata"->>'bankSequence' = '${rollbackSequence}' THEN
          RAISE EXCEPTION 'forced cmb sync audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON "op_logs"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `)
    await assert.rejects(() => apply(bankTransaction(rollbackSequence, '20.00')), /forced cmb sync audit failure/)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: account.id } })).balance), 110)
    assert.equal(await prisma.cashTransaction.count({
      where: { tenantId: tenant.id, accountId: account.id, refId: { contains: rollbackSequence } },
    }), 0)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "op_logs"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`)
    const recovered = await apply(bankTransaction(rollbackSequence, '20.00'))
    assert.equal(recovered.created, true)
    assert.equal(Number((await prisma.cashAccount.findUniqueOrThrow({ where: { id: account.id } })).balance), 130)

    const synced = await prisma.cashTransaction.findMany({
      where: { tenantId: tenant.id, accountId: account.id, refType: 'CmbAutoSync' },
      select: { id: true },
    })
    assert.equal(await prisma.opLog.count({
      where: { tenantId: tenant.id, entityType: 'CashTransaction', targetId: { in: synced.map(row => row.id) } },
    }), synced.length)

    console.log(JSON.stringify({
      ok: true,
      previewFailsClosedWithoutBankCall: true,
      concurrentDuplicateIdempotent: true,
      concurrentDistinctBalanceSerialized: true,
      perAccountBusinessReferenceUnique: true,
      internalTransferTwoSidesAllowed: true,
      auditFailureRollsBackAndRetries: true,
      everySyncedRowAudited: true,
    }))
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "op_logs"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`).catch(() => {})
    const rows = await prisma.cashTransaction.findMany({
      where: { tenantId: tenant.id, accountId: { in: [account.id, otherAccount.id] } },
      select: { id: true },
    })
    await prisma.opLog.deleteMany({
      where: {
        tenantId: tenant.id,
        OR: [{ targetId: { in: rows.map(row => row.id) } }, { userId: actor.id }],
      },
    })
    await prisma.cashTransaction.deleteMany({
      where: { tenantId: tenant.id, accountId: { in: [account.id, otherAccount.id] } },
    })
    await prisma.cashAccount.deleteMany({ where: { id: { in: [account.id, otherAccount.id] } } })
    await prisma.user.delete({ where: { id: actor.id } })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => prisma.$disconnect())
