import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd(), 'src')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('操作体验批次七打印与导出契约', () => {
  it('上游采购的收货、差异、对账、合同和退货都有打印或保存 PDF 入口', () => {
    const source = read('app/v2/supply-chain/procurement/page.tsx')
    const printHelper = read('app/v2/supply-chain/procurement/print-sheet.ts')
    expect(source).toContain('printId={`receipt-${viewingReceipt.id}`}')
    expect(source).toContain('printId={`purchase-return-${viewingPurchaseReturn.id}`}')
    expect(source).toContain('printId={`statement-${viewingStatement.id}`}')
    expect(source).toContain('printId={`contract-${viewingContract.id}`}')
    expect(source).toContain('<PrintButton printId={`arrival-claim-${claim.id}`} />')
    expect(source).toContain('打印 / 保存 PDF')
    expect(printHelper).toContain("window.addEventListener('afterprint', clear")
    expect(printHelper).toContain('data-print-clone')
  })

  it('收货、配送、入库记录和单据审核均可导出当前筛选', () => {
    const receipts = read('app/v2/supply-chain/receipts/page.tsx')
    const deliveries = read('app/v2/supply-chain/deliveries/page.tsx')
    const inbound = read('app/v2/supply-chain/inbound/page.tsx')
    const docs = read('app/v2/supply-chain/docs/page.tsx')
    expect(receipts).toContain('/api/receipts/export.xlsx')
    expect(deliveries).toContain('/api/deliveries/export.xlsx')
    expect(inbound).toContain('exportRecords')
    expect(inbound).toContain('导出当前筛选')
    expect(docs).toContain('exportDocs')
    expect(docs).toContain('导出当前筛选')
  })

  it('账务三个页签支持 CSV，厨师长从自己的角色路径进入送货单打印页', () => {
    const billing = read('app/v2/supply-chain/billing/page.tsx')
    const chef = read('app/v2/chef/purchase/po-success/[id]/page.tsx')
    const chefPrint = read('app/v2/chef/purchase/po-success/[id]/delivery-note/page.tsx')
    expect(billing).toContain("downloadBillingCsv('schedule'")
    expect(billing).toContain("downloadBillingCsv('reconciliation'")
    expect(billing).toContain("downloadBillingCsv('invoice'")
    expect(chef).toContain('/v2/chef/purchase/po-success/${po.id}/delivery-note')
    expect(chefPrint).toContain("@/app/v2/supplier/orders/[id]/delivery-note/page")
  })

  it('管理工作台打印的是当前已应用筛选结果', () => {
    const workspace = read('components/v2/management-workspace.tsx')
    expect(workspace).toContain('function printCurrentResults()')
    expect(workspace).toContain('if (loading || printing || !result?.sourceAvailable) return')
    expect(workspace).toContain('&print=1')
    expect(workspace).toContain('printResult.rows.map')
    expect(workspace).toContain('打印当前筛选结果')
  })
})
