import { describe, expect, it, vi } from 'vitest'
import { nextDocumentNo } from '../../src/services/documentNo'

function transaction(latestNo: string | null, sequenceValue: number) {
  return {
    document: {
      findFirst: vi.fn().mockResolvedValue(latestNo ? { no: latestNo } : null),
    },
    businessSequence: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      upsert: vi.fn().mockResolvedValue({ value: sequenceValue }),
    },
  } as any
}

describe('nextDocumentNo', () => {
  it('starts above the largest historical document number', async () => {
    const tx = transaction('DOC202607000099', 100)

    await expect(nextDocumentNo(tx, 'tenant-a', new Date('2026-07-16T00:00:00Z')))
      .resolves.toBe('DOC202607000100')
    expect(tx.businessSequence.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-a', scope: 'DOCUMENT', period: '202607', value: { lt: 99 } },
      data: { value: 99 },
    })
  })

  it('starts a new monthly sequence at one when no history exists', async () => {
    const tx = transaction(null, 1)

    await expect(nextDocumentNo(tx, 'tenant-a', new Date('2026-08-01T00:00:00Z')))
      .resolves.toBe('DOC202608000001')
    expect(tx.businessSequence.updateMany).not.toHaveBeenCalled()
  })

  // 业务时区为 Asia/Shanghai：月初/月末边界必须按上海时间切月，
  // 与宿主机本地时区无关（历史上在 America/Los_Angeles 开发机上错出 202607）。
  it.each([
    ['2026-07-31T15:59:59Z', 'DOC202607000001'], // 上海 7/31 23:59:59
    ['2026-07-31T16:00:00Z', 'DOC202608000001'], // 上海 8/1 00:00:00
    ['2026-08-31T15:59:59Z', 'DOC202608000001'], // 上海 8/31 23:59:59
    ['2026-08-31T16:00:00Z', 'DOC202609000001'], // 上海 9/1 00:00:00
  ])('cuts the monthly sequence at the Shanghai boundary (%s)', async (at, expected) => {
    const tx = transaction(null, 1)
    await expect(nextDocumentNo(tx, 'tenant-a', new Date(at))).resolves.toBe(expected)
  })
})
