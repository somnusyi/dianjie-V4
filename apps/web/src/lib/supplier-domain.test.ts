import { describe, expect, it } from 'vitest'
import {
  normalizeSupplierOrderStatus,
  supplierDeliveryStatusMeta,
  supplierLossClaimKindMeta,
  supplierLossClaimResponsibility,
  supplierLossClaimSettlementHint,
  supplierOrderBucket,
  supplierOrderStatusMeta,
} from './supplier-domain'

describe('supplier domain dictionary', () => {
  it('uses the database spelling CANCELLED and tolerates the legacy typo', () => {
    expect(normalizeSupplierOrderStatus('CANCELLED')).toBe('CANCELLED')
    expect(normalizeSupplierOrderStatus('CANCELED')).toBe('CANCELLED')
    expect(supplierOrderStatusMeta('CANCELED').label).toBe('已取消')
  })

  it('keeps supplier action buckets aligned with the order state machine', () => {
    expect(supplierOrderBucket('SUBMITTED')).toBe('pending')
    expect(supplierOrderBucket('CONFIRMED')).toBe('to_ship')
    expect(supplierOrderBucket('DELIVERING')).toBe('shipping')
    expect(supplierOrderBucket('PENDING_CONFIRM')).toBe('shipping')
    expect(supplierOrderBucket('RECEIVED')).toBe('completed')
  })

  it('distinguishes order and delivery labels', () => {
    expect(supplierOrderStatusMeta('CONFIRMED').detailLabel).toContain('实发')
    expect(supplierDeliveryStatusMeta('SHIPPED').label).toBe('已发货')
  })

  it('explains arrival differences without promising a second payable deduction', () => {
    const shortage = supplierLossClaimKindMeta('ARRIVAL_SHORTAGE')
    expect(shortage.label).toBe('到货短缺')
    expect(supplierLossClaimSettlementHint('NET_AT_RECEIPT')).toContain('不会再次扣款')
    expect(supplierLossClaimSettlementHint('GROSS_PENDING_CLAIM')).toContain('当前应付中扣除')
    expect(supplierLossClaimKindMeta('UNKNOWN').label).toBe('历史待核')
    expect(supplierLossClaimResponsibility('REJECTED')).toBe('待总厨仲裁')
  })
})
