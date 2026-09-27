import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appRoot = resolve(process.cwd(), 'src/app/v2')
const read = (path: string) => readFileSync(resolve(appRoot, path), 'utf8')

describe('操作体验批次六契约', () => {
  it('对账和合同只保留单号入口，不再重复显示同义按钮', () => {
    const source = read('supply-chain/procurement/page.tsx')
    expect(source).not.toContain('查看来源明细')
    expect(source).not.toContain('查看合同内容')
    expect(source).toContain('onClick={() => void openStatementDetail(statement)}')
    expect(source).toContain('onClick={() => setViewingContract(contract)}')
  })

  it('库存、发票和采购单提供明确的临期或逾期提示', () => {
    const stock = read('supply-chain/inventory/[id]/page.tsx')
    const invoices = read('supplier/invoices/page.tsx')
    const procurement = read('supply-chain/procurement/page.tsx')
    expect(stock).toContain('已过期')
    expect(stock).toContain('临期')
    expect(invoices).toContain("schedule.status === 'OVERDUE'")
    expect(invoices).toContain("activeStatuses.includes(schedule.status)")
    expect(invoices).not.toContain("schedule.status !== 'PAID'")
    expect(invoices).toContain('已逾期')
    expect(procurement).toContain('purchaseOrderOverdueText(order)')
    expect(procurement).toContain("'SETTLEMENT_PENDING', 'CLOSED'")
    expect(stock).toContain('Number(batch.remainingQty) > 0 ? expiryState(batch.expiryDate) : null')
  })

  it('单据文案按权限区分，退回标记可见，收货行可以展开商品明细', () => {
    const docs = read('supply-chain/docs/page.tsx')
    const receipts = read('supply-chain/receipts/page.tsx')
    const supplierOrders = read('supplier/orders/page.tsx')
    expect(docs).toContain("doc.status === 'POSTED' && canEdit ? '改单' : '查看'")
    expect(docs).toContain('被会计退回')
    expect(receipts).toContain('aria-expanded={expandedId === receipt.id}')
    expect(receipts).toContain('收货商品明细')
    const orderList = supplierOrders.slice(
      supplierOrders.indexOf("{documentView === 'orders' && ("),
      supplierOrders.indexOf("{documentView === 'deliveries' && (")
    )
    expect(orderList).toContain('打印送货单')
    expect(orderList).toContain('${orderBase}/${o.id}/delivery-note')
  })
})
