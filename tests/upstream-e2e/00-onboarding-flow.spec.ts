import { expect, test } from 'playwright/test'
import { apiOk, capture, fixture, login } from './helpers'

test('E2E-00：新供应商入总仓、总仓履约门店并完成验收与财务锁账', async ({ browser }, testInfo) => {
  testInfo.setTimeout(240_000)
  const data = fixture()
  const supplierNo = `E2E-NEW-${data.stamp}`.slice(0, 40)
  const supplierName = `E2E 新建供应商 ${data.stamp}`
  const ownerPhone = `139${String(Date.now()).slice(-8)}`
  const contractNo = `ONBOARD-${data.stamp}`.slice(0, 80)
  const contractTitle = `新供应商首单合同 ${data.stamp}`

  const supplyContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const supplyPage = await supplyContext.newPage()
  const supplierContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
  const supplierPage = await supplierContext.newPage()
  const financeContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const financePage = await financeContext.newPage()
  const storeContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
  const storePage = await storeContext.newPage()

  await login(supplyPage, data.accounts.supplyChain)
  await expect(supplyPage.getByRole('heading', { name: '统一供应链工作台' })).toBeVisible()
  await supplyPage.getByRole('button', { name: '下一步' }).click()
  await expect(supplyPage.getByRole('heading', { name: '跨店数据边界' })).toBeVisible()
  await supplyPage.getByRole('button', { name: '开始使用' }).click()

  // 1. 供应链从页面建立一份全新的上游供应商档案。
  await supplyPage.goto('/v2/supply-chain/suppliers')
  await expect(supplyPage.getByRole('heading', { name: '上游供应商管理' })).toBeVisible()
  await supplyPage.getByRole('button', { name: '新增上游供应商' }).click()
  await expect(supplyPage.getByRole('heading', { name: '新增上游供应商' })).toBeVisible()
  const supplierDrawer = supplyPage.getByRole('heading', { name: '新增上游供应商' }).locator('xpath=../..')
  await supplierDrawer.getByPlaceholder('如 SUP001').fill(supplierNo)
  await supplierDrawer.getByPlaceholder('供应商全称').fill(supplierName)
  await supplierDrawer.getByPlaceholder('姓名').fill('首次准入负责人')
  await supplierDrawer.getByPlaceholder('电话').fill(ownerPhone)
  await supplierDrawer.getByPlaceholder('如 蔬菜、水产').fill('E2E 首次准入')
  await supplierDrawer.locator('select').selectOption('FIXED_DAYS')
  await supplierDrawer.getByPlaceholder('0–365').fill('30')
  const createSupplierResponse = supplyPage.waitForResponse(response =>
    response.url().includes('/api/suppliers')
    && response.request().method() === 'POST',
  )
  await supplyPage.getByRole('button', { name: '保存', exact: true }).click()
  const createdSupplierResponse = await createSupplierResponse
  expect(createdSupplierResponse.status()).toBe(201)
  const supplier = await createdSupplierResponse.json()
  await expect(supplyPage.getByText('上游供应商新增成功')).toBeVisible()
  await expect(supplyPage.getByRole('row').filter({ hasText: supplierNo })).toContainText(supplierName)
  await capture(supplyPage, testInfo, '00-01-new-supplier-created')

  // 2. 页面生成负责人邀请；供应商在手机视口完成激活和首次登录。
  const inviteResponsePromise = supplyPage.waitForResponse(response =>
    response.url().includes(`/api/upstream/suppliers/${supplier.id}/invites`)
    && response.request().method() === 'POST',
  )
  await supplyPage.getByRole('button', { name: '生成负责人邀请链接' }).click()
  const inviteResponse = await inviteResponsePromise
  expect(inviteResponse.status()).toBe(201)
  const invite = await inviteResponse.json()
  await expect(supplyPage.getByText(/供应商负责人邀请已生成/)).toBeVisible()
  await expect(supplyPage.getByText(new RegExp(`/v2/invite/${invite.token}`))).toBeVisible()
  await capture(supplyPage, testInfo, '00-02-owner-invite-created')

  await supplierPage.goto(`/v2/invite/${invite.token}`)
  await expect(supplierPage.getByText('供应商负责人', { exact: true })).toBeVisible()
  await expect(supplierPage.getByText(`供应商: ${supplierName}`)).toBeVisible()
  await supplierPage.getByLabel('姓名').fill('E2E 新供应商负责人')
  await supplierPage.getByLabel('手机号 (登录账号)').fill(ownerPhone)
  await supplierPage.getByLabel('设置密码 (≥6 位)').fill(data.password)
  await supplierPage.getByLabel('再次输入').fill(data.password)
  await supplierPage.getByRole('button', { name: '激活账号' }).click()
  await expect(supplierPage.getByText('账号激活成功')).toBeVisible()
  await capture(supplierPage, testInfo, '00-03-owner-account-activated')

  await supplierPage.getByRole('link', { name: '去登录' }).click()
  await expect(supplierPage).toHaveURL(new RegExp(`/v2/login\\?tenant=${data.tenantSlug}`))
  await supplierPage.waitForLoadState('networkidle')
  const supplierLoginIdentifier = supplierPage.getByLabel('手机号 / 邮箱')
  const supplierLoginPassword = supplierPage.getByLabel('密码')
  await supplierLoginIdentifier.fill(ownerPhone)
  await supplierLoginPassword.fill(data.password)
  await expect(supplierLoginIdentifier).toHaveValue(ownerPhone)
  await expect(supplierLoginPassword).toHaveValue(data.password)
  const supplierLoginButton = supplierPage.getByRole('button', { name: '登录', exact: true })
  await expect(supplierLoginButton).toBeEnabled()
  await supplierLoginButton.click()
  await supplierPage.waitForURL(url => !url.pathname.endsWith('/login'), { timeout: 20_000 })
  await expect(supplierPage.getByRole('heading', { name: '总仓采购订单' })).toBeVisible()
  await supplierPage.getByRole('button', { name: '下一步' }).click()
  await expect(supplierPage.getByRole('heading', { name: '到货差异与月结' })).toBeVisible()
  await supplierPage.getByRole('button', { name: '开始使用' }).click()
  await supplierPage.goto('/v2/supplier/upstream')
  await expect(supplierPage.getByRole('heading', { name: '总仓采购' })).toBeVisible()
  await capture(supplierPage, testInfo, '00-04-owner-first-login')

  // 3. 供应链从供应商档案页面绑定真实商品、采购单位、换算和报价。
  await supplyPage.getByRole('link', { name: '管理供货商品 →' }).click()
  await expect(supplyPage.getByRole('heading', { name: `供货商品 · ${supplierName}` })).toBeVisible()
  await supplyPage.getByRole('button', { name: /添加商品/ }).click()
  await supplyPage.getByLabel('关键字').fill(data.productName)
  const productRow = supplyPage.getByRole('row').filter({ hasText: data.productName })
  await productRow.getByLabel(`选择 ${data.productName}`).check()
  await productRow.getByLabel('采购单位').fill('箱')
  await productRow.getByLabel('换算比').fill('10')
  await productRow.getByLabel('协议价').fill('120')
  await supplyPage.getByRole('button', { name: '确认绑定 1 个商品' }).click()
  await expect(supplyPage.getByRole('paragraph').filter({ hasText: '已绑定 1 个商品' })).toBeVisible()
  await capture(supplyPage, testInfo, '00-05-product-source-bound')

  // 4. 从页面建立合同和采购单，并发送给刚激活的供应商。
  await supplyPage.goto('/v2/supply-chain/procurement')
  await expect(supplyPage.getByRole('heading', { name: '上游采购与供应商协同' })).toBeVisible()
  await supplyPage.getByRole('button', { name: '合同与价格' }).click()
  await supplyPage.getByRole('button', { name: '新建合同' }).click()
  await supplyPage.getByRole('combobox', { name: '供应商', exact: true }).selectOption({ label: supplierName })
  await expect(supplyPage.getByText(data.productName)).toBeVisible()
  await supplyPage.getByLabel('合同编号').fill(contractNo)
  await supplyPage.getByLabel('合同名称').fill(contractTitle)
  const contractProductRow = supplyPage.getByRole('row').filter({ hasText: data.productName })
  await contractProductRow.locator('input[type="number"]').fill('120')
  await supplyPage.getByRole('button', { name: '保存合同草稿' }).click()
  await expect(supplyPage.getByText('合同草稿已创建，请确认后启用')).toBeVisible()
  const contracts = await apiOk<any[]>(supplyPage, '/api/upstream/contracts')
  const contract = contracts.find(item => item.contractNo === contractNo)
  expect(contract).toBeTruthy()
  const contractCard = supplyPage.locator('article').filter({ hasText: contractNo })
  supplyPage.once('dialog', dialog => dialog.accept())
  await contractCard.getByRole('button', { name: '启用合同' }).click()
  await expect(contractCard.getByText('生效中')).toBeVisible()

  await supplyPage.getByRole('button', { name: '采购单', exact: true }).click()
  await supplyPage.getByRole('button', { name: '新建采购单' }).click()
  await supplyPage.getByLabel('已生效合同').selectOption({ label: `${supplierName} · ${contractTitle}` })
  await supplyPage.getByLabel('收货总仓').selectOption(data.warehouseId)
  const orderProductRow = supplyPage.getByRole('row').filter({ hasText: data.productName })
  await orderProductRow.locator('input[type="number"]').fill('2')
  await supplyPage.getByRole('button', { name: '保存采购单草稿' }).click()
  await expect(supplyPage.getByText('采购单草稿已创建')).toBeVisible()
  const orders = await apiOk<any[]>(supplyPage, '/api/upstream/purchase-orders')
  const order = orders.find(item => item.contractId === contract.id && item.status === 'DRAFT')
  expect(order).toBeTruthy()
  let orderCard = supplyPage.locator('article').filter({ hasText: order.no })
  await orderCard.getByRole('button', { name: '提交审核' }).click()
  await expect(supplyPage.getByText('采购单已提交内部审核')).toBeVisible()
  orderCard = supplyPage.locator('article').filter({ hasText: order.no })
  supplyPage.once('dialog', dialog => dialog.accept())
  await orderCard.getByRole('button', { name: '审核并发送' }).click()
  await expect(supplyPage.getByText('采购单已发送供应商')).toBeVisible()
  await capture(supplyPage, testInfo, '00-06-first-order-sent')

  // 5. 新供应商本人接单、建立发货单并确认发车。
  await supplierPage.goto('/v2/supplier/home')
  await expect(supplierPage.getByRole('heading', { name: '总仓采购待办' })).toBeVisible()
  await expect(supplierPage.getByText('有总仓采购需要处理')).toBeVisible()
  await supplierPage.getByRole('link', { name: /有总仓采购需要处理/ }).click()
  await expect(supplierPage.getByRole('heading', { name: '总仓采购' })).toBeVisible()
  let supplierOrderCard = supplierPage.locator('article').filter({ hasText: order.no })
  supplierPage.once('dialog', dialog => dialog.accept())
  await supplierOrderCard.getByRole('button', { name: '确认接单' }).click()
  await expect(supplierPage.getByText('采购单已接单')).toBeVisible()
  supplierOrderCard = supplierPage.locator('article').filter({ hasText: order.no })
  await supplierOrderCard.getByRole('button', { name: '新建发货单' }).click()
  await supplierPage.getByLabel('承运/配送方').fill('E2E 新供应商自配')
  await supplierPage.getByLabel('运单号').fill(`NEW-${data.stamp}`)
  const shipmentProductRow = supplierPage.getByRole('row').filter({ hasText: data.productName })
  await shipmentProductRow.locator('input[type="number"]').fill('2')
  await supplierPage.getByRole('button', { name: '保存发货单草稿' }).click()
  await expect(supplierPage.getByText('发货单草稿已生成，请核对后点击发车')).toBeVisible()
  const shipments = await apiOk<any[]>(supplierPage, '/api/upstream/shipments')
  const shipment = shipments.find(item => item.purchaseOrder.id === order.id && item.status === 'DRAFT')
  expect(shipment).toBeTruthy()
  const shipmentCard = supplierPage.locator('article').filter({ hasText: shipment.no })
  supplierPage.once('dialog', dialog => dialog.accept())
  await shipmentCard.getByRole('button', { name: '确认发车' }).click()
  await expect(supplierPage.getByText('已确认发车，等待总仓收货')).toBeVisible()
  await capture(supplierPage, testInfo, '00-07-first-shipment-dispatched')

  // 6. 总仓通过页面收货入库，并同时核对余额、价值、批次与不可变流水。
  const { prisma } = await import('@dianjie/db')
  const balanceBefore = await prisma.warehouseLedgerBalance.findUnique({
    where: { tenantId_warehouseId_productId: { tenantId: data.tenantId, warehouseId: data.warehouseId, productId: data.productId } },
  })
  await supplyPage.goto('/v2/supply-chain/home')
  await expect(supplyPage.getByText('上游供应商协同待处理')).toBeVisible()
  await supplyPage.getByText('上游供应商协同待处理').locator('xpath=../..').getByRole('button', { name: '去处理' }).click()
  await expect(supplyPage.getByRole('heading', { name: '上游采购与供应商协同' })).toBeVisible()
  const shipmentRow = supplyPage.locator('div').filter({ hasText: shipment.no })
    .filter({ has: supplyPage.getByRole('button', { name: '登记到货' }) }).last()
  await shipmentRow.getByRole('button', { name: '登记到货' }).click()
  await expect(supplyPage.getByText(`登记到货 · ${shipment.no}`)).toBeVisible()
  await supplyPage.getByRole('button', { name: '生成收货单' }).click()
  await expect(supplyPage.getByText('收货单已生成，请开始验收并确认入库')).toBeVisible()
  const receipts = await apiOk<any[]>(supplyPage, '/api/upstream/receipts')
  const receipt = receipts.find(item => item.shipment.id === shipment.id && item.status === 'DRAFT')
  expect(receipt).toBeTruthy()
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
  await capture(supplyPage, testInfo, '00-08-first-receipt-posted')

  const [balanceAfter, savedSupplier, owner, source, receiptMovements] = await Promise.all([
    prisma.warehouseLedgerBalance.findUniqueOrThrow({
      where: { tenantId_warehouseId_productId: { tenantId: data.tenantId, warehouseId: data.warehouseId, productId: data.productId } },
    }),
    prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } }),
    prisma.user.findFirstOrThrow({ where: { tenantId: data.tenantId, phone: ownerPhone } }),
    prisma.productUpstreamSource.findUniqueOrThrow({
      where: { tenantId_productId_supplierId: { tenantId: data.tenantId, productId: data.productId, supplierId: supplier.id } },
    }),
    prisma.warehouseLedgerMovement.findMany({
      where: { tenantId: data.tenantId, sourceType: 'UpstreamReceipt', sourceId: receipt.id },
    }),
  ])
  const receiptLots = await prisma.warehouseLedgerLot.findMany({
    where: {
      tenantId: data.tenantId,
      sourceMovementId: { in: receiptMovements.map(movement => movement.id) },
    },
  })
  expect(savedSupplier.businessScopes).toContain('WAREHOUSE_UPSTREAM')
  expect(owner.supplierId).toBe(supplier.id)
  expect(owner.role).toBe('SUPPLIER_OWNER')
  expect(source.purchaseUnit).toBe('箱')
  expect(Number(source.inventoryUnitsPerPurchaseUnit)).toBe(10)
  expect(Number(source.quotedUnitPrice)).toBe(120)
  expect(Number(balanceAfter.physicalQty) - Number(balanceBefore?.physicalQty || 0)).toBeCloseTo(20, 6)
  expect(Number(balanceAfter.inventoryValue) - Number(balanceBefore?.inventoryValue || 0)).toBeCloseTo(240, 4)
  expect(receiptMovements).toHaveLength(1)
  expect(receiptLots).toHaveLength(1)

  // 7. 同一个新供应商继续完成首次月结和财务锁定。
  await supplyPage.getByRole('button', { name: '月度对账' }).click()
  await supplyPage.getByLabel('供应商').selectOption(supplier.id)
  await supplyPage.getByRole('button', { name: '生成对账单' }).click()
  await expect(supplyPage.getByText('对账单已生成')).toBeVisible()
  const statements = await apiOk<any[]>(supplyPage, '/api/upstream/settlement-statements')
  const statement = statements.find(item => item.supplierId === supplier.id && item.status === 'DRAFT')
  expect(statement).toBeTruthy()
  const statementCard = supplyPage.locator('article').filter({ hasText: statement.no })
  await statementCard.getByRole('button', { name: '发送供应商' }).click()
  await expect(supplyPage.getByText('对账单已发送供应商')).toBeVisible()

  await supplierPage.reload()
  await supplierPage.getByRole('button', { name: '月度对账' }).click()
  const supplierStatementCard = supplierPage.locator('article').filter({ hasText: statement.no })
  supplierPage.once('dialog', dialog => dialog.accept())
  await supplierStatementCard.getByRole('button', { name: '确认对账' }).click()
  await expect(supplierPage.getByText('月度对账已确认')).toBeVisible()

  await login(financePage, data.accounts.finance, { finance: true })
  await financePage.goto('/v2/finance-pc/upstream-settlements')
  const financeStatementRow = financePage.getByRole('row').filter({ hasText: statement.no })
  financePage.once('dialog', dialog => dialog.accept())
  await financeStatementRow.getByRole('button', { name: '复核并锁定' }).click()
  await expect(financePage.getByText(`${statement.no} 已由财务锁定`)).toBeVisible()
  await capture(financePage, testInfo, '00-09-first-statement-locked')

  const lockedStatement = await prisma.upstreamSettlementStatement.findUniqueOrThrow({
    where: { id: statement.id }, include: { lines: true },
  })
  expect(lockedStatement.status).toBe('LOCKED')
  expect(Number(lockedStatement.receiptAmount)).toBeCloseTo(240, 4)
  expect(Number(lockedStatement.payableAmount)).toBeCloseTo(240, 4)
  expect(lockedStatement.lines.some(line => line.sourceType === 'RECEIPT' && line.sourceNo === receipt.no)).toBe(true)

  // 8. 门店只能看到可履约供应商，并从同一笔上游入库形成的总仓真实库存下单。
  await login(storePage, data.accounts.kitchenLead)
  const [storeInventoryBefore, storeSuppliers, storeCatalog, warehouseBeforeStoreOrder] = await Promise.all([
    apiOk<any[]>(storePage, '/api/inventory'),
    apiOk<any[]>(storePage, '/api/suppliers'),
    apiOk<any[]>(storePage, '/api/products'),
    prisma.warehouseLedgerBalance.findUniqueOrThrow({
      where: { tenantId_warehouseId_productId: { tenantId: data.tenantId, warehouseId: data.warehouseId, productId: data.productId } },
    }),
  ])
  expect(storeSuppliers.some(item => item.id === data.fulfillmentSupplierId)).toBe(true)
  expect(storeSuppliers.some(item => item.id === supplier.id)).toBe(false)
  const storeCatalogProduct = storeCatalog.find(item => item.id === data.productId)
  expect(storeCatalogProduct).toBeTruthy()
  expect(Number(storeCatalogProduct.physicalStock)).toBeCloseTo(Number(warehouseBeforeStoreOrder.physicalQty), 6)
  expect(Number(storeCatalogProduct.reservedStock)).toBeCloseTo(Number(warehouseBeforeStoreOrder.reservedQty), 6)
  const storeStockBefore = Number(storeInventoryBefore.find(item => item.id === data.productId)?.stock || 0)

  await storePage.addInitScript(() => localStorage.removeItem('dj:po-new:draft:v1'))
  await storePage.goto('/v2/chef/purchase/new')
  await expect(storePage.getByRole('heading', { name: '发起采购单' })).toBeVisible()
  const supplierSelect = storePage.locator('form select').first()
  await expect(supplierSelect.locator(`option[value="${data.fulfillmentSupplierId}"]`)).toHaveCount(1)
  await expect(supplierSelect.locator(`option[value="${supplier.id}"]`)).toHaveCount(0)
  await supplierSelect.selectOption(data.fulfillmentSupplierId)
  await storePage.getByRole('button', { name: '+ 添加商品' }).click()
  await storePage.getByPlaceholder(/搜索 名称/).fill(data.productName)
  const pickerRow = storePage.locator('li').filter({ hasText: data.productName })
  await expect(pickerRow).toContainText('可用')
  await expect(pickerRow).not.toContainText('供应商断货')
  await pickerRow.getByRole('button', { name: '+ 加入' }).click()
  await storePage.getByRole('button', { name: '完成', exact: true }).click()
  const selectedProductRow = storePage.locator('form li').filter({ hasText: data.productName })
  await selectedProductRow.getByRole('spinbutton').fill('2')
  const createStoreOrderResponsePromise = storePage.waitForResponse(response =>
    response.url().endsWith('/api/orders') && response.request().method() === 'POST',
  )
  await storePage.getByRole('button', { name: /提交采购单/ }).click()
  const createStoreOrderResponse = await createStoreOrderResponsePromise
  expect(createStoreOrderResponse.status()).toBeLessThan(300)
  const storeOrder = await createStoreOrderResponse.json()
  await storePage.waitForURL(new RegExp(`/v2/chef/purchase/po-success/${storeOrder.id}`))
  await expect(storePage.getByText(storeOrder.no)).toBeVisible()
  await capture(storePage, testInfo, '00-10-store-order-submitted')

  // 9. 供应链订单中心按真实按钮完成接单、预占、出库和送达。
  await supplyPage.goto('/v2/supply-chain/fulfillment')
  await expect(supplyPage.getByRole('heading', { name: '订单中心' })).toBeVisible()
  await supplyPage.getByPlaceholder(/订单号/).fill(storeOrder.no)
  await expect(supplyPage.getByText(`#${storeOrder.no}`)).toBeVisible()
  await supplyPage.goto(`/v2/supply-chain/fulfillment/${storeOrder.id}`)
  await expect(supplyPage.getByText(storeOrder.no)).toBeVisible()

  const acceptResponsePromise = supplyPage.waitForResponse(response =>
    response.url().endsWith(`/api/orders/${storeOrder.id}/confirm`) && response.request().method() === 'PATCH',
  )
  await supplyPage.getByRole('button', { name: '接单', exact: true }).click()
  await supplyPage.getByText(`接单 ${storeOrder.no}?`).locator('xpath=..').getByRole('button', { name: '接单', exact: true }).click()
  expect((await acceptResponsePromise).status()).toBeLessThan(300)
  await expect(supplyPage.getByRole('button', { name: '确认发货 (出发)' })).toBeVisible()

  const shipResponsePromise = supplyPage.waitForResponse(response =>
    response.url().endsWith(`/api/orders/${storeOrder.id}/ship`) && response.request().method() === 'PATCH',
  )
  await supplyPage.getByRole('button', { name: '确认发货 (出发)' }).click()
  await supplyPage.getByText(`确认发货 ${storeOrder.no}?`).locator('xpath=..').getByRole('button', { name: '确认发货', exact: true }).click()
  expect((await shipResponsePromise).status()).toBeLessThan(300)
  await expect(supplyPage.getByRole('button', { name: /确认送达/ })).toBeVisible()

  const deliverResponsePromise = supplyPage.waitForResponse(response =>
    response.url().endsWith(`/api/orders/${storeOrder.id}/deliver`) && response.request().method() === 'PATCH',
  )
  await supplyPage.getByRole('button', { name: /确认送达/ }).click()
  await supplyPage.getByText('客户还没发验收单, 仍要送达?').locator('xpath=..').getByRole('button', { name: '强制送达' }).click()
  expect((await deliverResponsePromise).status()).toBeLessThan(300)
  await expect(supplyPage.getByText('已送达，待门店确认收货', { exact: true })).toBeVisible()
  await capture(supplyPage, testInfo, '00-11-warehouse-order-delivered')

  // 10. 厨师长验收后，门店预计库存增加；内部调拨不重复生成外部应付。
  await storePage.goto(`/v2/chef/purchase/${storeOrder.id}/receive`)
  await expect(storePage.getByRole('heading', { name: '验收' })).toBeVisible()
  await expect(storePage.getByText(data.productName)).toBeVisible()
  const receiveResponsePromise = storePage.waitForResponse(response =>
    response.url().endsWith(`/api/orders/${storeOrder.id}/receive`) && response.request().method() === 'PATCH',
  )
  await storePage.getByRole('button', { name: '确认收货 · ¥7.00' }).click()
  expect((await receiveResponsePromise).status()).toBeLessThan(300)
  await storePage.waitForURL(new RegExp(`/v2/chef/purchase/po-success/${storeOrder.id}`))
  await expect(storePage.getByText('已完成', { exact: false }).first()).toBeVisible()
  await capture(storePage, testInfo, '00-12-store-receipt-completed')

  const [completedStoreOrder, storeReceipt, warehouseAfterStoreReceipt, reservation, reserveMovements, outboundMovements, storeInventoryAfter] = await Promise.all([
    prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: storeOrder.id },
      include: { items: true, deliveries: { include: { items: true } } },
    }),
    prisma.receipt.findFirstOrThrow({
      where: { tenantId: data.tenantId, purchaseOrderId: storeOrder.id },
      include: { items: true },
    }),
    prisma.warehouseLedgerBalance.findUniqueOrThrow({
      where: { tenantId_warehouseId_productId: { tenantId: data.tenantId, warehouseId: data.warehouseId, productId: data.productId } },
    }),
    prisma.warehouseLedgerReservation.findFirstOrThrow({
      where: { tenantId: data.tenantId, purchaseOrderId: storeOrder.id, productId: data.productId },
    }),
    prisma.warehouseLedgerMovement.findMany({
      where: { tenantId: data.tenantId, type: 'ORDER_RESERVED', sourceType: 'PurchaseOrder', sourceId: storeOrder.id },
    }),
    prisma.warehouseLedgerMovement.findMany({
      where: { tenantId: data.tenantId, type: 'ORDER_OUTBOUND', sourceType: 'DeliveryOrder', sourceId: { in: (await prisma.deliveryOrder.findMany({ where: { purchaseOrderId: storeOrder.id }, select: { id: true } })).map(item => item.id) } },
    }),
    apiOk<any[]>(storePage, '/api/inventory'),
  ])
  const storeStockAfter = Number(storeInventoryAfter.find(item => item.id === data.productId)?.stock || 0)
  const internalPaymentSchedule = await prisma.paymentSchedule.findUnique({ where: { receiptId: storeReceipt.id } })
  expect(completedStoreOrder.status).toBe('COMPLETED')
  expect(completedStoreOrder.deliveries).toHaveLength(1)
  expect(completedStoreOrder.deliveries[0].status).toBe('RECEIVED')
  expect(storeReceipt.status).toBe('CONFIRMED')
  expect(Number(storeReceipt.totalAmount)).toBeCloseTo(7, 2)
  expect(Number(storeReceipt.items[0].inventoryQuantity)).toBeCloseTo(2, 6)
  expect(Number(warehouseAfterStoreReceipt.physicalQty) - Number(warehouseBeforeStoreOrder.physicalQty)).toBeCloseTo(-2, 6)
  expect(Number(warehouseAfterStoreReceipt.reservedQty) - Number(warehouseBeforeStoreOrder.reservedQty)).toBeCloseTo(0, 6)
  expect(reservation.status).toBe('CONSUMED')
  expect(Number(reservation.fulfilledInventoryQty)).toBeCloseTo(2, 6)
  expect(reserveMovements).toHaveLength(1)
  expect(outboundMovements).toHaveLength(1)
  expect(storeStockAfter - storeStockBefore).toBeCloseTo(2, 6)
  expect(internalPaymentSchedule).toBeNull()

  await testInfo.attach('onboarding-invariants.json', {
    body: Buffer.from(JSON.stringify({
      supplier: { id: supplier.id, no: supplierNo, name: supplierName },
      owner: { id: owner.id, phone: owner.phone, role: owner.role, supplierId: owner.supplierId },
      source: {
        productId: source.productId,
        purchaseUnit: source.purchaseUnit,
        inventoryUnitsPerPurchaseUnit: String(source.inventoryUnitsPerPurchaseUnit),
        quotedUnitPrice: String(source.quotedUnitPrice),
      },
      order: order.no,
      shipment: shipment.no,
      receipt: receipt.no,
      statement: statement.no,
      physicalDelta: Number(balanceAfter.physicalQty) - Number(balanceBefore?.physicalQty || 0),
      valueDelta: Number(balanceAfter.inventoryValue) - Number(balanceBefore?.inventoryValue || 0),
      receiptMovementCount: receiptMovements.length,
      receiptLotCount: receiptLots.length,
      statementStatus: lockedStatement.status,
      downstream: {
        fulfillmentSupplierId: data.fulfillmentSupplierId,
        storeId: data.storeId,
        order: storeOrder.no,
        receipt: storeReceipt.no,
        warehousePhysicalDelta: Number(warehouseAfterStoreReceipt.physicalQty) - Number(warehouseBeforeStoreOrder.physicalQty),
        warehouseReservedDelta: Number(warehouseAfterStoreReceipt.reservedQty) - Number(warehouseBeforeStoreOrder.reservedQty),
        storeStockDelta: storeStockAfter - storeStockBefore,
        reservationStatus: reservation.status,
        reserveMovementCount: reserveMovements.length,
        outboundMovementCount: outboundMovements.length,
        externalPaymentScheduleCreated: Boolean(internalPaymentSchedule),
      },
    }, null, 2)),
    contentType: 'application/json',
  })

  await Promise.all([supplyContext.close(), supplierContext.close(), financeContext.close(), storeContext.close()])
  await prisma.$disconnect()
})
