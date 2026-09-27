import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@dianjie/db', async importOriginal => {
  const actual = await importOriginal<typeof import('@dianjie/db')>()
  return {
    ...actual,
    prisma: { $transaction: vi.fn() } as any,
  }
})

import { prisma } from '@dianjie/db'
import { approveLossClaimAtomically } from '../../src/routes/lossClaims'

const P = prisma as any

describe('late arrival claim automatic approval guard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not write a late report when a scheduler caller requests automatic approval', async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      lossClaim: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'claim-late',
          tenantId: 'tenant-1',
          status: 'PENDING',
          isManual: false,
          createdAt: new Date('2026-09-24T04:00:00.001Z'),
          receipt: { deliveryDate: new Date('2026-09-24T00:00:00.000Z') },
          items: [],
          purchaseOrder: null,
        }),
      },
      paymentSchedule: { findUnique: vi.fn() },
      opLog: { create: vi.fn() },
    }
    P.$transaction.mockImplementation(async (fn: any) => fn(tx))

    const result = await approveLossClaimAtomically({
      claimId: 'claim-late', tenantId: 'tenant-1', operatorId: 'system',
      reason: 'scheduler', automatic: true,
    })

    expect(result).toMatchObject({ transitioned: false, skipped: 'OVERDUE_REQUIRES_MANUAL_APPROVAL' })
    expect(tx.paymentSchedule.findUnique).not.toHaveBeenCalled()
    expect(tx.opLog.create).not.toHaveBeenCalled()
  })
})
