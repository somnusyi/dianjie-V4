import { expect, test, type Page } from 'playwright/test'
import { api, apiOk, capture, fixture, login } from './helpers'

async function createReadyOrder(
  supplyPage: Page,
  suffix: string,
  quantity: number,
  options: { acceptWith?: Page } = {},
) {
  const data = fixture()
  const contract = await apiOk<any>(supplyPage, '/api/upstream/contracts', {
    method: 'POST',
    body: JSON.stringify({
      supplierId: data.supplierId,
      contractNo: `AUTO-${suffix}-${data.stamp}`.slice(0, 80),
      title: `自动验收 ${suffix} ${data.stamp}`,
      startsAt: new Date().toISOString(),
      settlementCycle: 'MONTHLY',
      settlementDays: 0,
      taxInclusive: true,
      currency: 'CNY',
      lines: [{
        upstreamSourceId: data.sourceId,
        unitPrice: 100,
        packageMultiple: 1,
        shortTolerancePct: 0,
        overTolerancePct: 0,
      }],
    }),
  })
  await apiOk(supplyPage, `/api/upstream/contracts/${contract.id}/activate`, { method: 'POST' })
  const orderPayload = {
    supplierId: data.supplierId,
    warehouseId: data.warehouseId,
    contractId: contract.id,
    expectedArrivalAt: new Date().toISOString(),
    origin: 'MANUAL',
    idempotencyKey: `visual-order-${suffix}-${data.stamp}`.slice(0, 160),
    lines: [{ contractLineId: contract.lines[0].id, quantity }],
  }
  const order = await apiOk<any>(supplyPage, '/api/upstream/purchase-orders', {
    method: 'POST', body: JSON.stringify(orderPayload),
  })
  const replay = await apiOk<any>(supplyPage, '/api/upstream/purchase-orders', {
    method: 'POST', body: JSON.stringify(orderPayload),
  })
  expect(replay.id, '采购单幂等重放必须返回同一单据').toBe(order.id)
  await apiOk(supplyPage, `/api/upstream/purchase-orders/${order.id}/submit-for-approval`, { method: 'POST' })
  await apiOk(supplyPage, `/api/upstream/purchase-orders/${order.id}/approve-and-send`, { method: 'POST' })
  if (options.acceptWith) {
    await apiOk(options.acceptWith, `/api/upstream/purchase-orders/${order.id}/accept`, { method: 'POST' })
  }
  return { contract, order }
}

test('E2E-02：供应商改单，采购方接受后只生效一个版本', async ({ browser }, testInfo) => {
  testInfo.setTimeout(100_000)
  const data = fixture()
  const supplyContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const supplierContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
  const supplyPage = await supplyContext.newPage()
  const supplierPage = await supplierContext.newPage()
  await login(supplyPage, data.accounts.supplyChain)
  await login(supplierPage, data.accounts.supplierOwner)
  const { order } = await createReadyOrder(supplyPage, 'CHANGE', 4)

  await supplierPage.goto('/v2/supplier/upstream')
  let orderCard = supplierPage.locator('article').filter({ hasText: order.no })
  await orderCard.getByRole('button', { name: '申请改单' }).click()
  await supplierPage.getByPlaceholder('说明缺货、规格或到货期变化').fill('本批次可供数量调整为 3 箱')
  const productRow = supplierPage.getByRole('row').filter({ hasText: data.productName })
  await productRow.locator('input[type="number"]').fill('3')
  await supplierPage.getByRole('button', { name: '提交改单申请' }).click()
  await expect(supplierPage.getByText('改单申请已提交，等待采购方审核')).toBeVisible()
  await capture(supplierPage, testInfo, '20-supplier-change-proposed')

  await supplyPage.goto('/v2/supply-chain/procurement')
  orderCard = supplyPage.locator('article').filter({ hasText: order.no })
  await expect(orderCard.getByText('供应商改单待审核')).toBeVisible()
  await capture(supplyPage, testInfo, '21-buyer-change-review')
  await orderCard.getByRole('button', { name: '接受改单' }).click()
  await expect(supplyPage.getByText('改单已接受')).toBeVisible()

  const { prisma } = await import('@dianjie/db')
  const saved = await prisma.upstreamPurchaseOrder.findUniqueOrThrow({
    where: { id: order.id },
    include: { lines: true, revisions: true },
  })
  expect(saved.status).toBe('SUPPLIER_ACCEPTED')
  expect(Number(saved.lines[0].orderedQty)).toBe(3)
  expect(saved.revisions).toHaveLength(1)
  expect(saved.revisions[0].status).toBe('ACCEPTED')
  await supplyContext.close()
  await supplierContext.close()
  await prisma.$disconnect()
})

test('E2E-03/04：分批发货、异常验收、不同人员复核与差异仲裁', async ({ browser }, testInfo) => {
  testInfo.setTimeout(180_000)
  const data = fixture()
  const supplyContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const supplierContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
  const reviewerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const supplyPage = await supplyContext.newPage()
  const supplierPage = await supplierContext.newPage()
  const reviewerPage = await reviewerContext.newPage()
  const { prisma } = await import('@dianjie/db')

  await prisma.supplier.update({ where: { id: data.supplierId }, data: { upstreamReceiptReviewThreshold: 5_000 } })
  try {
    await login(supplyPage, data.accounts.supplyChain)
    await login(supplierPage, data.accounts.supplierOwner)
    await login(reviewerPage, data.accounts.reviewer)
    const { order } = await createReadyOrder(supplyPage, 'PARTIAL', 120, { acceptWith: supplierPage })
    const detail = await apiOk<any>(supplierPage, `/api/upstream/purchase-orders/${order.id}`)
    const shipmentPayload = {
      carrierName: 'E2E 分批冷链',
      idempotencyKey: `visual-shipment-a-${data.stamp}`,
      lines: [{ purchaseOrderLineId: detail.lines[0].id, shippedQty: 60 }],
    }
    const firstShipment = await apiOk<any>(supplierPage, `/api/upstream/purchase-orders/${order.id}/shipments`, {
      method: 'POST', body: JSON.stringify(shipmentPayload),
    })
    const shipmentReplay = await apiOk<any>(supplierPage, `/api/upstream/purchase-orders/${order.id}/shipments`, {
      method: 'POST', body: JSON.stringify(shipmentPayload),
    })
    expect(shipmentReplay.id).toBe(firstShipment.id)
    await apiOk(supplierPage, `/api/upstream/shipments/${firstShipment.id}/dispatch`, { method: 'POST' })

    await supplyPage.goto('/v2/supply-chain/procurement')
    const firstShipmentRow = supplyPage.locator('div').filter({ hasText: firstShipment.no }).filter({ has: supplyPage.getByRole('button', { name: '登记到货' }) }).last()
    await firstShipmentRow.getByRole('button', { name: '登记到货' }).click()
    const receiptPanel = supplyPage.getByRole('heading', { name: `登记到货 · ${firstShipment.no}` }).locator('..').locator('..')
    const receiptProductRow = receiptPanel.getByRole('row').filter({ hasText: data.productName })
    const quantities = receiptProductRow.locator('input[type="number"]')
    await quantities.nth(0).fill('59')
    await quantities.nth(1).fill('57')
    await quantities.nth(2).fill('1')
    await quantities.nth(3).fill('1')
    await receiptPanel.getByRole('button', { name: '生成收货单' }).click()
    await expect(supplyPage.getByText('收货单已生成，请开始验收并确认入库')).toBeVisible()
    const receipts = await apiOk<any[]>(supplyPage, '/api/upstream/receipts')
    const firstReceipt = receipts.find(item => item.shipment.id === firstShipment.id && item.status === 'DRAFT')
    expect(firstReceipt).toBeTruthy()
    let receiptCard = supplyPage.locator('article').filter({ hasText: firstReceipt.no })
    await receiptCard.getByRole('button', { name: '开始验收' }).click()
    receiptCard = supplyPage.locator('article').filter({ hasText: firstReceipt.no })
    supplyPage.once('dialog', dialog => dialog.accept())
    await receiptCard.getByRole('button', { name: '确认验收' }).click()
    receiptCard = supplyPage.locator('article').filter({ hasText: firstReceipt.no })
    await expect(receiptCard.getByText('待复核')).toBeVisible()
    await capture(supplyPage, testInfo, '30-high-risk-receipt-pending-review')

    const sameUserReview = await api(supplyPage, `/api/upstream/receipts/${firstReceipt.id}/review-and-post`, { method: 'POST' })
    expect(sameUserReview.status).toBe(409)
    expect(sameUserReview.body.error).toContain('与验收人不同')

    await reviewerPage.goto('/v2/supply-chain/procurement')
    await reviewerPage.getByRole('button', { name: '到货验收', exact: true }).click()
    const reviewerCard = reviewerPage.locator('article').filter({ hasText: firstReceipt.no })
    reviewerPage.once('dialog', dialog => dialog.accept())
    await reviewerCard.getByRole('button', { name: '第二人复核入库' }).click()
    await expect(reviewerPage.getByText('复核通过，库存已入账')).toBeVisible()
    await capture(reviewerPage, testInfo, '31-independent-review-posted')

    await supplierPage.goto('/v2/supplier/upstream')
    const partialOrderCard = supplierPage.locator('article').filter({ hasText: order.no })
    await expect(partialOrderCard.getByText('部分收货')).toBeVisible()
    await partialOrderCard.getByRole('button', { name: '新建发货单' }).click()
    const secondShipRow = supplierPage.getByRole('row').filter({ hasText: data.productName })
    await secondShipRow.locator('input[type="number"]').fill('60')
    await supplierPage.getByLabel('承运/配送方').fill('E2E 第二批冷链')
    await supplierPage.getByRole('button', { name: '保存发货单草稿' }).click()
    await expect(supplierPage.getByText('发货单草稿已生成，请核对后点击发车')).toBeVisible()
    const shipmentRows = await apiOk<any[]>(supplierPage, '/api/upstream/shipments')
    const secondShipment = shipmentRows.find(item => item.purchaseOrder.id === order.id && item.status === 'DRAFT')
    expect(secondShipment).toBeTruthy()
    const secondShipmentCard = supplierPage.locator('article').filter({ hasText: secondShipment.no })
    supplierPage.once('dialog', dialog => dialog.accept())
    await secondShipmentCard.getByRole('button', { name: '确认发车' }).click()
    await capture(supplierPage, testInfo, '32-partial-order-second-shipment')

    const secondShipmentDetail = (await apiOk<any[]>(supplierPage, '/api/upstream/shipments')).find(item => item.id === secondShipment.id)
    const secondReceipt = await apiOk<any>(supplyPage, `/api/upstream/shipments/${secondShipment.id}/receipts`, {
      method: 'POST',
      body: JSON.stringify({
        finalForShipment: true,
        idempotencyKey: `visual-receipt-b-${data.stamp}`,
        lines: secondShipmentDetail.lines.map((line: any) => ({
          shipmentLineId: line.id,
          arrivedQty: Number(line.shippedQty),
          acceptedQty: Number(line.shippedQty),
          damagedQty: 0,
          rejectedQty: 0,
        })),
      }),
    })
    await apiOk(supplyPage, `/api/upstream/receipts/${secondReceipt.id}/start-inspection`, { method: 'POST' })
    const secondPosting = await apiOk<any>(supplyPage, `/api/upstream/receipts/${secondReceipt.id}/confirm`, { method: 'POST' })
    expect(secondPosting.pendingReview).toBe(true)
    await apiOk(reviewerPage, `/api/upstream/receipts/${secondReceipt.id}/review-and-post`, { method: 'POST' })

    const orderAfter = await prisma.upstreamPurchaseOrder.findUniqueOrThrow({ where: { id: order.id }, include: { lines: true } })
    expect(orderAfter.status).toBe('RECEIVED')
    expect(Number(orderAfter.lines[0].shippedQty)).toBe(120)
    expect(Number(orderAfter.lines[0].receivedQty)).toBe(117)

    const firstReceiptClaims = await prisma.upstreamArrivalClaim.findMany({
      where: { receiptId: firstReceipt.id },
      select: { type: true },
    })
    expect(firstReceiptClaims.map(item => item.type).sort()).toEqual(['DAMAGE', 'QUALITY', 'SHORTAGE'])

    const claim = await prisma.upstreamArrivalClaim.findFirstOrThrow({
      where: { receiptId: firstReceipt.id, type: 'DAMAGE' },
    })
    await supplierPage.reload()
    await supplierPage.getByRole('button', { name: '到货差异' }).click()
    const claimCard = supplierPage.locator('article').filter({ hasText: claim.no })
    await claimCard.getByRole('button', { name: '立即核对' }).click()
    await supplierPage.getByPlaceholder('填写核对结果、接受说明或异议理由').fill('对现场破损数量有异议，请采购方复核')
    await supplierPage.getByRole('button', { name: '提出异议' }).click()

    await supplyPage.reload()
    await supplyPage.getByRole('button', { name: '到货差异' }).click()
    const rejectedClaimCard = supplyPage.locator('article').filter({ hasText: claim.no })
    await rejectedClaimCard.getByRole('button', { name: '转仲裁' }).click()
    supplyPage.once('dialog', dialog => dialog.accept())
    await rejectedClaimCard.getByRole('button', { name: '确认责任并扣款' }).click()
    await expect(supplyPage.getByText('差异已办结并进入对账')).toBeVisible()
    await capture(supplyPage, testInfo, '33-claim-arbitrated-and-resolved')
  } finally {
    await prisma.supplier.update({ where: { id: data.supplierId }, data: { upstreamReceiptReviewThreshold: 10_000 } })
    await Promise.all([supplyContext.close(), supplierContext.close(), reviewerContext.close()])
    await prisma.$disconnect()
  }
})

test('E2E-06：未消耗收货可整单冲销，库存流水净变化归零', async ({ browser }, testInfo) => {
  testInfo.setTimeout(120_000)
  const data = fixture()
  const supplyContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const supplierContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
  const supplyPage = await supplyContext.newPage()
  const supplierPage = await supplierContext.newPage()
  await login(supplyPage, data.accounts.supplyChain)
  await login(supplierPage, data.accounts.supplierOwner)
  const { order } = await createReadyOrder(supplyPage, 'REVERSAL', 1, { acceptWith: supplierPage })
  const detail = await apiOk<any>(supplierPage, `/api/upstream/purchase-orders/${order.id}`)
  const shipment = await apiOk<any>(supplierPage, `/api/upstream/purchase-orders/${order.id}/shipments`, {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: `visual-reversal-shipment-${data.stamp}`,
      lines: [{ purchaseOrderLineId: detail.lines[0].id, shippedQty: 1 }],
    }),
  })
  await apiOk(supplierPage, `/api/upstream/shipments/${shipment.id}/dispatch`, { method: 'POST' })
  const receiptPayload = {
    finalForShipment: true,
    idempotencyKey: `visual-reversal-receipt-${data.stamp}`,
    lines: shipment.lines.map((line: any) => ({
      shipmentLineId: line.id,
      arrivedQty: Number(line.shippedQty),
      acceptedQty: Number(line.shippedQty),
      damagedQty: 0,
      rejectedQty: 0,
    })),
  }
  const receipt = await apiOk<any>(supplyPage, `/api/upstream/shipments/${shipment.id}/receipts`, {
    method: 'POST',
    body: JSON.stringify(receiptPayload),
  })
  const receiptReplay = await apiOk<any>(supplyPage, `/api/upstream/shipments/${shipment.id}/receipts`, {
    method: 'POST',
    body: JSON.stringify(receiptPayload),
  })
  expect(receiptReplay.id).toBe(receipt.id)
  await apiOk(supplyPage, `/api/upstream/receipts/${receipt.id}/start-inspection`, { method: 'POST' })
  const concurrentPostings = await Promise.all([
    api(supplyPage, `/api/upstream/receipts/${receipt.id}/confirm`, { method: 'POST' }),
    api(supplyPage, `/api/upstream/receipts/${receipt.id}/confirm`, { method: 'POST' }),
  ])
  expect(concurrentPostings.map(result => result.status).sort()).toEqual([200, 409])

  await supplyPage.goto('/v2/supply-chain/procurement')
  await supplyPage.getByRole('button', { name: '到货验收', exact: true }).click()
  const receiptCard = supplyPage.locator('article').filter({ hasText: receipt.no })
  const dialogs: string[] = []
  supplyPage.on('dialog', async dialog => {
    dialogs.push(dialog.type())
    if (dialog.type() === 'prompt') await dialog.accept('重复登记，执行整单冲销')
    else await dialog.accept()
  })
  await receiptCard.getByRole('button', { name: '冲销收货' }).click()
  await expect(supplyPage.getByText('收货单已冲销，库存与采购进度已恢复')).toBeVisible()
  await expect(receiptCard.getByText('已冲销')).toBeVisible()
  expect(dialogs).toEqual(['prompt', 'confirm'])
  await capture(supplyPage, testInfo, '40-receipt-reversed')

  const replay = await apiOk<any>(supplyPage, `/api/upstream/receipts/${receipt.id}/reverse`, {
    method: 'POST',
    body: JSON.stringify({ reason: '重复登记，执行整单冲销', idempotencyKey: `visual-replay-${data.stamp}` }),
  })
  expect(replay.replayed).toBe(true)

  const { prisma } = await import('@dianjie/db')
  const movements = await prisma.warehouseLedgerMovement.findMany({
    where: {
      tenantId: data.tenantId,
      OR: [
        { sourceType: 'UpstreamReceipt', sourceId: receipt.id },
        { sourceType: 'UpstreamReceiptReversal', sourceId: receipt.id },
      ],
    },
    include: { createdLot: true },
  })
  expect(movements).toHaveLength(2)
  expect(movements.reduce((sum, item) => sum + Number(item.physicalDelta), 0)).toBeCloseTo(0, 6)
  expect(movements.reduce((sum, item) => sum + Number(item.valueDelta), 0)).toBeCloseTo(0, 4)
  const inbound = movements.find(item => item.type === 'UPSTREAM_RECEIPT')
  expect(Number(inbound?.createdLot?.remainingQty)).toBe(0)
  const savedReceipt = await prisma.upstreamReceipt.findUniqueOrThrow({ where: { id: receipt.id } })
  expect(savedReceipt.status).toBe('REVERSED')
  await testInfo.attach('reversal-invariants.json', {
    body: Buffer.from(JSON.stringify({
      receipt: receipt.no,
      movementTypes: movements.map(item => item.type),
      netPhysical: movements.reduce((sum, item) => sum + Number(item.physicalDelta), 0),
      netValue: movements.reduce((sum, item) => sum + Number(item.valueDelta), 0),
    }, null, 2)),
    contentType: 'application/json',
  })
  await supplyContext.close()
  await supplierContext.close()
  await prisma.$disconnect()
})
