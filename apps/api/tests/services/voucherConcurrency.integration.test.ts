import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { createVoucher } from '../../src/services/voucher'

const suffix = `voucher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const voucherDate = new Date('2026-07-18T08:00:00+08:00')
let tenantId = ''

function voucherInput(sourceId: string) {
  return {
    tenantId,
    date: voucherDate,
    summary: `并发凭证 ${sourceId}`,
    sourceType: 'VoucherConcurrencyTest',
    sourceId,
    entries: [
      { accountCode: '1001', accountName: '库存现金', debit: 10 },
      { accountCode: '5001', accountName: '主营业务收入', credit: 10 },
    ],
    autoPost: true,
  }
}

describe('voucher number allocation (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({
      data: { name: `凭证并发测试 ${suffix}`, slug: suffix },
    })
    tenantId = tenant.id
    await prisma.voucher.create({
      data: {
        tenantId,
        no: 'PZ-202607-0042',
        date: voucherDate,
        summary: '历史凭证号下限',
        sourceType: 'VoucherConcurrencySeed',
        sourceId: suffix,
        totalDebit: 1,
        totalCredit: 1,
        entries: {
          create: [
            { lineNo: 1, summary: '历史借方', accountCode: '1001', accountName: '库存现金', debit: 1, credit: 0 },
            { lineNo: 2, summary: '历史贷方', accountCode: '5001', accountName: '主营业务收入', debit: 0, credit: 1 },
          ],
        },
      },
    })
  })

  afterAll(async () => {
    if (!tenantId) return
    await prisma.voucherEntry.deleteMany({ where: { voucher: { tenantId } } })
    await prisma.voucher.deleteMany({ where: { tenantId } })
    await prisma.voucherGenerationFailure.deleteMany({ where: { tenantId } })
    await prisma.businessSequence.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('allocates unique monthly numbers above the historical maximum under concurrency', async () => {
    const ids = await Promise.all(
      Array.from({ length: 12 }, (_, index) => createVoucher(voucherInput(`${suffix}-parallel-${index}`))),
    )
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(12)

    const vouchers = await prisma.voucher.findMany({
      where: { tenantId, sourceType: 'VoucherConcurrencyTest' },
      orderBy: { no: 'asc' },
      select: { no: true },
    })
    expect(vouchers.map(row => row.no)).toEqual(
      Array.from({ length: 12 }, (_, index) => `PZ-202607-${String(43 + index).padStart(4, '0')}`),
    )
    expect(await prisma.voucherGenerationFailure.count({ where: { tenantId } })).toBe(0)
  })

  it('serializes the same business source and returns one voucher id', async () => {
    const sourceId = `${suffix}-same-source`
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => createVoucher(voucherInput(sourceId))),
    )
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(1)
    expect(await prisma.voucher.count({
      where: { tenantId, sourceType: 'VoucherConcurrencyTest', sourceId },
    })).toBe(1)
    expect(await prisma.voucherGenerationFailure.count({ where: { tenantId } })).toBe(0)
  })
})
