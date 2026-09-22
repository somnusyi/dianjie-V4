import { resolve } from 'node:path'
import { expect, test } from 'playwright/test'
import { api, apiOk, capture, fixture, login } from './helpers'

test('E2E-01/05/07：全角色正常闭环、补报、财务锁账与权限隔离', async ({ browser }, testInfo) => {
  testInfo.setTimeout(210_000)
  const data = fixture()
  const contractNo = `VIS-${data.stamp}`
  const contractTitle = `视觉闭环合同 ${data.stamp}`

  const supplyContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const supplyPage = await supplyContext.newPage()
  await login(supplyPage, data.accounts.supplyChain)
  await supplyPage.goto('/v2/supply-chain/procurement')
  await expect(supplyPage.getByRole('heading', { name: '上游采购与供应商协同' })).toBeVisible()
  await capture(supplyPage, testInfo, '01-supply-chain-workbench')

  await supplyPage.getByRole('button', { name: '合同与价格' }).click()
  await supplyPage.getByRole('button', { name: '新建合同' }).click()
  await supplyPage.getByRole('combobox', { name: '供应商', exact: true }).selectOption({ label: data.supplierName })
  await expect(supplyPage.getByText(data.productName)).toBeVisible()
  await supplyPage.getByLabel('合同编号').fill(contractNo)
  await supplyPage.getByLabel('合同名称').fill(contractTitle)
  const productRow = supplyPage.getByRole('row').filter({ hasText: data.productName })
  await productRow.locator('input[type="number"]').fill('100')
  await supplyPage.getByRole('button', { name: '保存合同草稿' }).click()
  await expect(supplyPage.getByText('合同草稿已创建，请确认后启用')).toBeVisible()
  const contractCard = supplyPage.locator('article').filter({ hasText: contractNo })
  supplyPage.once('dialog', dialog => dialog.accept())
  await contractCard.getByRole('button', { name: '启用合同' }).click()
  await expect(contractCard.getByText('生效中')).toBeVisible()
  await capture(supplyPage, testInfo, '02-contract-active')

  const contracts = await apiOk<any[]>(supplyPage, '/api/upstream/contracts')
  const contract = contracts.find(item => item.contractNo === contractNo)
  expect(contract, '浏览器新建的合同应能从 API 读取').toBeTruthy()

  await supplyPage.getByRole('button', { name: '采购单', exact: true }).click()
  await supplyPage.getByRole('button', { name: '新建采购单' }).click()
  await supplyPage.getByLabel('已生效合同').selectOption({ label: `${data.supplierName} · ${contractTitle}` })
  await supplyPage.getByLabel('收货总仓').selectOption(data.warehouseId)
  const orderProductRow = supplyPage.getByRole('row').filter({ hasText: data.productName })
  await orderProductRow.locator('input[type="number"]').fill('1')
  await supplyPage.getByRole('button', { name: '保存采购单草稿' }).click()
  await expect(supplyPage.getByText('采购单草稿已创建')).toBeVisible()
  const orders = await apiOk<any[]>(supplyPage, '/api/upstream/purchase-orders')
  const order = orders.find(item => item.contractId === contract.id && item.status === 'DRAFT')
  expect(order, '浏览器新建的采购单应存在').toBeTruthy()
  let orderCard = supplyPage.locator('article').filter({ hasText: order.no })
  await orderCard.getByRole('button', { name: '提交审核' }).click()
  await expect(supplyPage.getByText('采购单已提交内部审核')).toBeVisible()
  orderCard = supplyPage.locator('article').filter({ hasText: order.no })
  supplyPage.once('dialog', dialog => dialog.accept())
  await orderCard.getByRole('button', { name: '审核并发送' }).click()
  await expect(supplyPage.getByText('采购单已发送供应商')).toBeVisible()
  await capture(supplyPage, testInfo, '03-order-sent-to-supplier')

  const supplierContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
  const supplierPage = await supplierContext.newPage()
  await login(supplierPage, data.accounts.supplierOwner)
  await supplierPage.goto('/v2/supplier/upstream')
  await expect(supplierPage.getByRole('heading', { name: '总仓采购' })).toBeVisible()
  let supplierOrderCard = supplierPage.locator('article').filter({ hasText: order.no })
  supplierPage.once('dialog', dialog => dialog.accept())
  await supplierOrderCard.getByRole('button', { name: '确认接单' }).click()
  await expect(supplierPage.getByText('采购单已接单')).toBeVisible()
  supplierOrderCard = supplierPage.locator('article').filter({ hasText: order.no })
  await supplierOrderCard.getByRole('button', { name: '新建发货单' }).click()
  await supplierPage.getByLabel('承运/配送方').fill('E2E 冷链')
  await supplierPage.getByLabel('运单号').fill(`TRACK-${data.stamp}`)
  const shipProductRow = supplierPage.getByRole('row').filter({ hasText: data.productName })
  await shipProductRow.locator('input[type="number"]').fill('1')
  await supplierPage.getByRole('button', { name: '保存发货单草稿' }).click()
  await expect(supplierPage.getByText('发货单草稿已生成，请核对后点击发车')).toBeVisible()
  const shipments = await apiOk<any[]>(supplierPage, '/api/upstream/shipments')
  const shipment = shipments.find(item => item.purchaseOrder.id === order.id && item.status === 'DRAFT')
  expect(shipment, '供应商新建的发货单应存在').toBeTruthy()
  const shipmentCard = supplierPage.locator('article').filter({ hasText: shipment.no })
  supplierPage.once('dialog', dialog => dialog.accept())
  await shipmentCard.getByRole('button', { name: '确认发车' }).click()
  await expect(supplierPage.getByText('已确认发车，等待总仓收货')).toBeVisible()
  await capture(supplierPage, testInfo, '04-supplier-mobile-dispatched')

  await supplyPage.reload()
  await expect(supplyPage.getByRole('heading', { name: '上游采购与供应商协同' })).toBeVisible()
  const shipmentRow = supplyPage.locator('div').filter({ hasText: shipment.no }).filter({ has: supplyPage.getByRole('button', { name: '登记到货' }) }).last()
  await shipmentRow.getByRole('button', { name: '登记到货' }).click()
  await expect(supplyPage.getByText(`登记到货 · ${shipment.no}`)).toBeVisible()
  await supplyPage.getByRole('button', { name: '生成收货单' }).click()
  await expect(supplyPage.getByText('收货单已生成，请开始验收并确认入库')).toBeVisible()
  const receipts = await apiOk<any[]>(supplyPage, '/api/upstream/receipts')
  const receipt = receipts.find(item => item.shipment.id === shipment.id && item.status === 'DRAFT')
  expect(receipt, '总仓登记的收货单应存在').toBeTruthy()

  const { prisma } = await import('@dianjie/db')
  const balanceBefore = await prisma.warehouseLedgerBalance.findUnique({
    where: { tenantId_warehouseId_productId: { tenantId: data.tenantId, warehouseId: data.warehouseId, productId: data.productId } },
  })
  let receiptCard = supplyPage.locator('article').filter({ hasText: receipt.no })
  await receiptCard.getByRole('button', { name: '开始验收' }).click()
  await expect(supplyPage.getByText('已开始验收')).toBeVisible()
  receiptCard = supplyPage.locator('article').filter({ hasText: receipt.no })
  await receiptCard.getByRole('button', { name: '查看明细并验收' }).click()
  const receiptDetailPanel = supplyPage.getByRole('heading', { name: `收货单明细 · ${receipt.no}` }).locator('..').locator('..')
  await expect(receiptDetailPanel).toContainText(order.no)
  await expect(receiptDetailPanel).toContainText(data.productName)
  await receiptDetailPanel.getByRole('button', { name: '确认验收并提交' }).click()
  await expect(supplyPage.getByText('验收已确认')).toBeVisible()
  receiptCard = supplyPage.locator('article').filter({ hasText: receipt.no })
  await expect(receiptCard.getByText('已入库')).toBeVisible()
  await capture(supplyPage, testInfo, '05-warehouse-receipt-posted')

  const balanceAfterReceipt = await prisma.warehouseLedgerBalance.findUniqueOrThrow({
    where: { tenantId_warehouseId_productId: { tenantId: data.tenantId, warehouseId: data.warehouseId, productId: data.productId } },
  })
  expect(Number(balanceAfterReceipt.physicalQty) - Number(balanceBefore?.physicalQty || 0)).toBeCloseTo(10, 6)
  expect(Number(balanceAfterReceipt.inventoryValue) - Number(balanceBefore?.inventoryValue || 0)).toBeCloseTo(100, 4)

  await supplyPage.route('**/api/upload?category=loss-claims', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ url: `https://e2e.local/evidence/${data.stamp}.svg` }),
  }))
  await receiptCard.getByRole('button', { name: '收货后补报异常' }).click()
  await supplyPage.getByLabel('异常说明').fill('拆包后发现局部压伤，申请供应商承担')
  const claimPanel = supplyPage.getByRole('heading', { name: `收货后补报异常 · ${receipt.no}` }).locator('..').locator('..')
  await claimPanel.locator('input[type="number"]').fill('0.1')
  await claimPanel.locator('input[type="file"]').setInputFiles(resolve(process.cwd(), 'tests/upstream-e2e/fixtures/claim-evidence.svg'))
  await expect(claimPanel.getByText('claim-evidence.svg')).toBeVisible()
  await claimPanel.getByRole('button', { name: '提交补报' }).click()
  await expect(supplyPage.getByText('收货后异常已补报，等待供应商确认')).toBeVisible()
  const claims = await apiOk<any[]>(supplyPage, '/api/upstream/arrival-claims')
  const claim = claims.find(item => item.receipt.id === receipt.id && item.type === 'POST_RECEIPT_DAMAGE')
  expect(claim, '收货后补报应生成差异单').toBeTruthy()
  await capture(supplyPage, testInfo, '06-post-receipt-claim-created')

  await supplierPage.reload()
  await supplierPage.getByRole('button', { name: '到货差异' }).click()
  let supplierClaimCard = supplierPage.locator('article').filter({ hasText: claim.no })
  await supplierClaimCard.getByRole('button', { name: '立即核对' }).click()
  await supplierPage.getByPlaceholder('填写核对结果、接受说明或异议理由').fill('已核对现场证据，同意承担')
  await supplierPage.getByRole('button', { name: '接受差异' }).click()
  await expect(supplierPage.getByText('差异已接受，等待采购方办结')).toBeVisible()
  await capture(supplierPage, testInfo, '07-supplier-accepted-claim')

  await supplyPage.reload()
  await supplyPage.getByRole('button', { name: '到货差异' }).click()
  const internalClaimCard = supplyPage.locator('article').filter({ hasText: claim.no })
  supplyPage.once('dialog', dialog => dialog.accept())
  await internalClaimCard.getByRole('button', { name: '确认责任并扣款' }).click()
  await expect(supplyPage.getByText('差异已办结并进入对账')).toBeVisible()

  const balanceAfterClaim = await prisma.warehouseLedgerBalance.findUniqueOrThrow({
    where: { tenantId_warehouseId_productId: { tenantId: data.tenantId, warehouseId: data.warehouseId, productId: data.productId } },
  })
  expect(Number(balanceAfterClaim.physicalQty) - Number(balanceBefore?.physicalQty || 0)).toBeCloseTo(9, 6)

  await supplyPage.getByRole('button', { name: '月度对账' }).click()
  await supplyPage.getByLabel('供应商').selectOption(data.supplierId)
  await supplyPage.getByRole('button', { name: '生成对账单' }).click()
  await expect(supplyPage.getByText('对账单已生成')).toBeVisible()
  const statements = await apiOk<any[]>(supplyPage, '/api/upstream/settlement-statements')
  const statement = statements.find(item => item.supplierId === data.supplierId && item.status === 'DRAFT')
  expect(statement, '应生成草稿月度对账单').toBeTruthy()
  let statementCard = supplyPage.locator('article').filter({ hasText: statement.no })
  await statementCard.getByRole('button', { name: '发送供应商' }).click()
  await expect(supplyPage.getByText('对账单已发送供应商')).toBeVisible()
  await capture(supplyPage, testInfo, '08-statement-sent')

  await supplierPage.reload()
  await supplierPage.getByRole('button', { name: '月度对账' }).click()
  const supplierStatementCard = supplierPage.locator('article').filter({ hasText: statement.no })
  supplierPage.once('dialog', dialog => dialog.accept())
  await supplierStatementCard.getByRole('button', { name: '确认对账' }).click()
  await expect(supplierPage.getByText('月度对账已确认')).toBeVisible()
  await capture(supplierPage, testInfo, '09-supplier-confirmed-statement')

  const forbiddenLock = await api(supplyPage, `/api/upstream/settlement-statements/${statement.id}/lock`, { method: 'POST' })
  expect(forbiddenLock.status).toBe(403)
  expect(forbiddenLock.body.error).toContain('仅财务')

  const financeContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const financePage = await financeContext.newPage()
  await login(financePage, data.accounts.finance, { finance: true })
  await financePage.goto('/v2/finance-pc/upstream-settlements')
  await expect(financePage.getByRole('heading', { name: '上游采购对账' })).toBeVisible()
  let financeStatementRow = financePage.getByRole('row').filter({ hasText: statement.no })
  await capture(financePage, testInfo, '10-finance-pending-lock')
  financePage.once('dialog', dialog => dialog.accept())
  await financeStatementRow.getByRole('button', { name: '复核并锁定' }).click()
  await expect(financePage.getByText(`${statement.no} 已由财务锁定`)).toBeVisible()
  financeStatementRow = financePage.getByRole('row').filter({ hasText: statement.no })
  await expect(financeStatementRow.getByText('已锁定')).toBeVisible()
  await capture(financePage, testInfo, '11-finance-locked')

  const unauthorizedContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const unauthorizedPage = await unauthorizedContext.newPage()
  await login(unauthorizedPage, data.accounts.unauthorized)
  await unauthorizedPage.goto('/v2/supply-chain/procurement')
  await expect(unauthorizedPage).toHaveURL(/\/v2\/manager\/home/)
  const unauthorizedApi = await api(unauthorizedPage, '/api/upstream/purchase-orders')
  expect(unauthorizedApi.status).toBe(403)

  const otherSupplierContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
  const otherSupplierPage = await otherSupplierContext.newPage()
  await login(otherSupplierPage, data.accounts.otherSupplierOwner)
  const crossSupplier = await api(otherSupplierPage, `/api/upstream/purchase-orders/${order.id}`)
  expect(crossSupplier.status).toBe(404)

  const [savedReceipt, savedClaim, savedStatement, receiptMovements, claimMovements] = await Promise.all([
    prisma.upstreamReceipt.findUniqueOrThrow({ where: { id: receipt.id } }),
    prisma.upstreamArrivalClaim.findUniqueOrThrow({ where: { id: claim.id } }),
    prisma.upstreamSettlementStatement.findUniqueOrThrow({ where: { id: statement.id }, include: { lines: true } }),
    prisma.warehouseLedgerMovement.findMany({ where: { tenantId: data.tenantId, sourceType: 'UpstreamReceipt', sourceId: receipt.id } }),
    prisma.warehouseLedgerMovement.findMany({ where: { tenantId: data.tenantId, sourceType: 'UpstreamArrivalClaim', sourceId: claim.id } }),
  ])
  expect(savedReceipt.status).toBe('POSTED')
  expect(savedClaim.status).toBe('RESOLVED')
  expect(savedStatement.status).toBe('LOCKED')
  expect(savedStatement.lines.some(line => line.sourceType === 'RECEIPT' && line.sourceNo === receipt.no && Boolean(line.receiptLineId))).toBe(true)
  expect(savedStatement.lines.some(line => line.sourceType === 'CLAIM' && line.sourceId === claim.id && line.claimId === claim.id)).toBe(true)
  expect(Number(savedStatement.payableAmount)).toBeCloseTo(Number(savedStatement.receiptAmount) - Number(savedStatement.deductionAmount), 4)
  expect(receiptMovements).toHaveLength(1)
  expect(claimMovements).toHaveLength(1)

  await testInfo.attach('database-invariants.json', {
    body: Buffer.from(JSON.stringify({
      order: order.no,
      shipment: shipment.no,
      receipt: savedReceipt.no,
      claim: savedClaim.no,
      statement: savedStatement.no,
      statementStatus: savedStatement.status,
      receiptMovementCount: receiptMovements.length,
      claimMovementCount: claimMovements.length,
      physicalDeltaAfterReceipt: Number(balanceAfterReceipt.physicalQty) - Number(balanceBefore?.physicalQty || 0),
      physicalDeltaAfterClaim: Number(balanceAfterClaim.physicalQty) - Number(balanceBefore?.physicalQty || 0),
    }, null, 2)),
    contentType: 'application/json',
  })

  await Promise.all([
    supplyContext.close(),
    supplierContext.close(),
    financeContext.close(),
    unauthorizedContext.close(),
    otherSupplierContext.close(),
  ])
  await prisma.$disconnect()
})
