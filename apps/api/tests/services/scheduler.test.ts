import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findMany, approveLossClaimAtomically } = vi.hoisted(() => ({
  findMany: vi.fn(),
  approveLossClaimAtomically: vi.fn(),
}))

vi.mock('@dianjie/db', async importOriginal => ({
  ...await importOriginal<typeof import('@dianjie/db')>(),
  prisma: { lossClaim: { findMany } },
}))
vi.mock('../../src/routes/lossClaims', () => ({ approveLossClaimAtomically }))

import { autoApproveEligibleLossClaims } from '../../src/services/scheduler'

describe('autoApproveEligibleLossClaims', () => {
  beforeEach(() => {
    findMany.mockReset()
    approveLossClaimAtomically.mockReset().mockResolvedValue({ transitioned: true })
  })

  it('scans past more than 1,000 late reports so a later eligible claim is not starved', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const now = new Date('2026-09-24T07:00:00.000Z')
    const lateCreatedAt = new Date('2026-09-21T06:00:00.000Z')
    const lateReceiptDate = new Date('2026-09-20T00:00:00.000Z')
    const timelyCreatedAt = new Date('2026-09-23T02:00:00.000Z') // 10:00 Shanghai
    const timelyReceiptDate = new Date('2026-09-23T00:00:00.000Z')
    const claims = [
      ...Array.from({ length: 1001 }, (_, index) => ({
        id: `late-${String(index).padStart(4, '0')}`, no: `LC-LATE-${index}`, tenantId: 'tenant', createdById: 'user',
        createdAt: lateCreatedAt, receipt: { deliveryDate: lateReceiptDate },
      })),
      { id: 'eligible-after-late', no: 'LC-ELIGIBLE', tenantId: 'tenant', createdById: 'user', createdAt: timelyCreatedAt, receipt: { deliveryDate: timelyReceiptDate } },
    ]
    findMany.mockImplementation(async (query: any) => {
      const start = query.cursor ? claims.findIndex(claim => claim.id === query.cursor.id) + 1 : 0
      return claims.slice(start, start + query.take)
    })

    try {
      const outcome = await autoApproveEligibleLossClaims({
        subtract: () => ({ toDate: () => new Date('2026-09-23T07:00:00.000Z') }),
      } as any)

      expect(findMany).toHaveBeenCalledTimes(6)
      expect(outcome).toEqual({ autoApprovedCount: 1, overdueManualReviewCount: 1001, scannedLossClaims: 1002 })
      expect(approveLossClaimAtomically).toHaveBeenCalledTimes(1)
      expect(approveLossClaimAtomically).toHaveBeenCalledWith(expect.objectContaining({ claimId: 'eligible-after-late', automatic: true }))
      expect(now).toBeInstanceOf(Date)
    } finally {
      log.mockRestore()
    }
  })
})
