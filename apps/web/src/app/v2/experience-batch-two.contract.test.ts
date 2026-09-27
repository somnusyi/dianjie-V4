import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

const procurement = source('./supply-chain/procurement/page.tsx')
const inventory = source('./supply-chain/inventory/page.tsx')
const docs = source('./supply-chain/docs/page.tsx')
const invoices = source('./supplier/invoices/page.tsx')

describe('2026-09-28 成功后引导与空态入口', () => {
  it('opens the newly generated receipt directly in inspection', () => {
    expect(procurement).toContain("receipt.status === 'DRAFT'")
    expect(procurement).toContain("/start-inspection`, { method: 'POST' }")
    expect(procurement).toContain('receiptReviewActionForStatus(receipt.status)')
    expect(procurement).toContain('await openReceiptDetail(receipt, nextAction)')
  })

  it('keeps difference source documents in overlay detail instead of forced tab switches', () => {
    expect(procurement).toContain('onClick={() => void openOrderDetail(claim.purchaseOrder)}')
    expect(procurement).toContain('onClick={() => void openReceiptDetail(claim.receipt)}')
    expect(procurement).toContain("if (!preserveTab && tab !== 'claims') setTab('orders')")
    expect(procurement).toContain("if (!preserveTab && tab !== 'claims') setTab('receipts')")
  })

  it('reloads complete contract/order details and unwraps the return response before showing actions', () => {
    expect(procurement).toContain("apiFetch<Contract[]>('/api/upstream/contracts')")
    expect(procurement).toContain('await openOrderDetail(created)')
    expect(procurement).toContain('type PurchaseReturnCreateResult = { replayed: boolean; purchaseReturn: PurchaseReturn }')
    expect(procurement).toContain('const row = result.purchaseReturn')
    expect(procurement).toContain('setViewingPurchaseReturn(row)')
    expect(procurement).toContain('loadCreatedRecord(created.id')
    expect(procurement).toContain("setNoticeAction({ label: '启用合同'")
    expect(procurement).toContain("setNoticeAction({ label: '查看采购单'")
    expect(procurement).toContain('setNoticeAction({ label: `查看退货单 ${row.no}`')
    expect(procurement).toContain("setNoticeAction({ label: '查看对账单'")
  })

  it('links manual and batch inbound success to the exact warehouse document', () => {
    expect(inventory.match(/setNoticeDocId\(result\.doc\.id\)/g)).toHaveLength(2)
    expect(inventory).toContain("setNoticeDocId(result.doc.id)\n      setGateWarnings(result.gateWarnings || [])\n      setNotice(result.replayed")
    expect(inventory).toContain('/v2/supply-chain/docs?doc=${encodeURIComponent(noticeDocId)}')
    expect(inventory).toContain('查看单据')
  })

  it('adds an upstream step to procurement, document, and invoice empty states', () => {
    for (const text of ['还没有上游采购单', '暂无待验收单据', '暂无采购退货单', '暂无到货差异', '暂无对账单', '暂无合同']) {
      expect(procurement).toContain(`'${text}':`)
    }
    expect(docs).toContain('去总仓库存制单')
    expect(invoices).toContain('返回账期与对账')
    expect(invoices).toContain('先确认待开票账期')
  })
})
