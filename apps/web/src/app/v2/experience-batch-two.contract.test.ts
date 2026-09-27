import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const procurement = source('./supply-chain/procurement/page.tsx')
const procurementNormalized = procurement.replace(/\s+/g, ' ').replaceAll('"', "'")
const inventory = source('./supply-chain/inventory/page.tsx')
const docs = source('./supply-chain/docs/page.tsx')
const invoices = source('./supplier/invoices/page.tsx')

describe('2026-09-28 成功后引导与空态入口', () => {
  it('opens the newly generated receipt directly in inspection', () => {
    expect(procurementNormalized).toContain("receipt.status === 'DRAFT'")
    expect(procurementNormalized).toContain('/start-inspection`')
    expect(procurementNormalized).toContain("method: 'POST'")
    expect(procurementNormalized).toContain('receiptReviewActionForStatus(receipt.status)')
    expect(procurementNormalized).toContain('await openReceiptDetail(receipt, nextAction)')
  })

  it('keeps difference source documents in overlay detail instead of forced tab switches', () => {
    expect(procurementNormalized).toContain('openOrderDetail(claim.purchaseOrder)')
    expect(procurementNormalized).toContain('openReceiptDetail(claim.receipt)')
    expect(procurementNormalized).toContain("!preserveTab && tab !== 'claims'")
    expect(procurementNormalized).toContain("setTab('orders')")
    expect(procurementNormalized).toContain("setTab('receipts')")
  })

  it('reloads complete contract/order details and unwraps the return response before showing actions', () => {
    expect(procurementNormalized).toContain("apiFetch<Contract[]>('/api/upstream/contracts')")
    expect(procurementNormalized).toContain('await openOrderDetail(created)')
    expect(procurementNormalized).toContain('PurchaseReturnCreateResult = { replayed: boolean; purchaseReturn: PurchaseReturn }')
    expect(procurementNormalized).toContain('const row = result.purchaseReturn')
    expect(procurementNormalized).toContain('setViewingPurchaseReturn(row)')
    expect(procurementNormalized).toContain('loadCreatedRecord(created.id')
    for (const label of ['启用合同', '查看采购单', '查看退货单', '查看对账单']) expect(procurementNormalized).toContain(label)
  })

  it('links manual and batch inbound success to the exact warehouse document', () => {
    expect(inventory.match(/setNoticeDocId\(result\.doc\.id\)/g)).toHaveLength(2)
    expect(inventory).toContain('setNoticeDocId(result.doc.id)\n      setGateWarnings(result.gateWarnings || [])\n      setNotice(result.replayed')
    expect(inventory).toContain('/v2/supply-chain/docs?doc=${encodeURIComponent(noticeDocId)}')
    expect(inventory).toContain('查看单据')
  })

  it('adds an upstream step to procurement, document, and invoice empty states', () => {
    for (const text of ['还没有上游采购单', '暂无待验收单据', '暂无采购退货单', '暂无到货差异', '暂无对账单', '暂无合同']) {
      expect(procurementNormalized).toContain(`${text}:`)
    }
    expect(docs).toContain('去总仓库存制单')
    expect(invoices).toContain('返回账期与对账')
    expect(invoices).toContain('先确认待开票账期')
  })
})
