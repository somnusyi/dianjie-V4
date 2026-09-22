import { Prisma } from '@dianjie/db'
import { describe, expect, it } from 'vitest'

import { upstreamSettlementClaimDeduction } from '../../src/routes/upstreamProcurement'

const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value)

describe('upstream settlement claim deduction', () => {
  it('deducts only the accepted overage value that was included in receipt payable', () => {
    const deduction = upstreamSettlementClaimDeduction({
      type: 'OVERAGE',
      resolvedAmount: D(30),
      lines: [{
        receiptLine: {
          arrivedQty: D(12),
          overageQty: D(2),
          acceptedQty: D(12),
          unitPrice: D(10),
        },
      }],
    })

    expect(deduction.toString()).toBe('20')
  })

  it('does not deduct rejected overage that was excluded from receipt payable', () => {
    const deduction = upstreamSettlementClaimDeduction({
      type: 'OVERAGE',
      resolvedAmount: D(20),
      lines: [{
        receiptLine: {
          arrivedQty: D(12),
          overageQty: D(2),
          acceptedQty: D(10),
          unitPrice: D(10),
        },
      }],
    })

    expect(deduction.toString()).toBe('0')
  })

  it('never deducts more than the accepted quantity on a later cumulative-overage receipt', () => {
    const deduction = upstreamSettlementClaimDeduction({
      type: 'OVERAGE',
      resolvedAmount: D(30),
      lines: [{
        receiptLine: {
          arrivedQty: D(1),
          overageQty: D(3),
          acceptedQty: D(1),
          unitPrice: D(10),
        },
      }],
    })

    expect(deduction.toString()).toBe('10')
  })
})
