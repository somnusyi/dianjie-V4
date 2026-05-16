/**
 * 测试 voucher 幂等: 同 sourceType+sourceId 并发 N 次, 应只有 1 笔凭证
 */
require('dotenv').config({ path: __dirname + '/../.env' })
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

;(async () => {
  const t = await p.tenant.findUnique({ where: { slug: 'test' } })
  if (!t) { console.error('test tenant 不存在'); process.exit(1) }

  const { createVoucher } = require('../dist/services/voucher')
  const fakeId = `test-idempotency-${Date.now()}`

  console.log(`并发 5 次 createVoucher(sourceType=Test, sourceId=${fakeId})`)
  const promises = Array.from({ length: 5 }).map(() =>
    createVoucher({
      tenantId: t.id,
      date: new Date(),
      summary: '幂等测试',
      sourceType: 'Test',
      sourceId: fakeId,
      entries: [
        { accountCode: '1001', accountName: '库存现金', debit: 99 },
        { accountCode: '5001', accountName: '主营业务收入', credit: 99 },
      ],
    })
  )
  const results = await Promise.all(promises)
  console.log('返回的 voucherId:', results)
  const uniqueIds = new Set(results.filter(Boolean))
  console.log(`unique voucherId 数: ${uniqueIds.size} (应该 = 1)`)

  // 数据库实际几条?
  const actual = await p.voucher.count({ where: { tenantId: t.id, sourceType: 'Test', sourceId: fakeId } })
  console.log(`DB 中该 sourceId 的凭证条数: ${actual} (应该 = 1)`)

  // 清理
  await p.voucher.deleteMany({ where: { tenantId: t.id, sourceType: 'Test', sourceId: fakeId } })
  console.log('✓ 清理完成')

  await p.$disconnect()
})().catch(e => { console.error(e); process.exit(1) })
