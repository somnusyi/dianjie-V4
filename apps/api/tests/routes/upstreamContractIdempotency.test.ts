import { describe, expect, it } from 'vitest'

import { upstreamContractRequestFingerprint } from '../../src/routes/upstreamProcurement'

const request = {
  supplierId: 'supplier-1',
  contractNo: 'HT202609-01',
  title: '2026年菌菇供货合同',
  startsAt: new Date('2026-09-01T00:00:00.000Z'),
  settlementCycle: 'MONTHLY' as const,
  settlementDays: 0,
  taxInclusive: true,
  currency: 'CNY',
  idempotencyKey: 'contract-request-1',
  lines: [
    {
      upstreamSourceId: 'source-1',
      unitPrice: 88,
      packageMultiple: 1,
      shortTolerancePct: 0,
      overTolerancePct: 0,
    },
  ],
}

describe('upstream contract request fingerprint', () => {
  it('相同请求得到稳定指纹', () => {
    expect(upstreamContractRequestFingerprint(request)).toBe(upstreamContractRequestFingerprint(structuredClone(request)))
  })

  it('同一幂等键更改合同价格会产生不同指纹', () => {
    const changed = {
      ...request,
      lines: [{ ...request.lines[0], unitPrice: 89 }],
    }
    expect(upstreamContractRequestFingerprint(changed)).not.toBe(upstreamContractRequestFingerprint(request))
  })
})
