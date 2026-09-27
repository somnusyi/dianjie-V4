import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '@dianjie/db'
import { autoProcessAfterConfirm } from '../../src/services/paymentSchedule'
import { approveLossClaimAtomically } from '../../src/routes/lossClaims'
import { lossClaimRoutes } from '../../src/routes/lossClaims'
import { receiptRoutes } from '../../src/routes/receipts'

const suffix = `noon-finance-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
let tenantId = ''; let supplierId = ''; let storeId = ''; let userId = ''; let productId = ''
let app: ReturnType<typeof Fastify>
let fixtureSequence = 0
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
const yesterdayDate = new Date(`${yesterday.toISOString().slice(0, 10)}T00:00:00.000Z`)
function shanghaiTodayAt(hour: number, minute: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: string) => parts.find(part => part.type === type)!.value
  return new Date(`${value('year')}-${value('month')}-${value('day')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`)
}

async function fixture(amount: number, loss = 20, derive = true) {
  const label = `${amount}-${fixtureSequence++}`
  const order = await prisma.purchaseOrder.create({ data: {
    tenantId, no: `PO-${label}-${suffix}`, storeId, supplierId, expectedDate: yesterdayDate, totalAmount: amount,
    status: 'RECEIVED', createdById: userId, items: { create: { productId, quantity: amount / 10, unitPrice: 10, amount } },
  } })
  const receipt = await prisma.receipt.create({ data: {
    tenantId, no: `RK-${label}-${suffix}`, storeId, supplierId, purchaseOrderId: order.id,
    deliveryDate: yesterdayDate, totalAmount: amount, status: 'CONFIRMED', confirmedAt: new Date(), createdById: userId,
    items: { create: { productId, quantity: amount / 10, unitPrice: 10, amount } },
  } })
  const claim = await prisma.lossClaim.create({ data: {
    tenantId, no: `LC-${label}-${suffix}`, purchaseOrderId: order.id, receiptId: receipt.id, storeId, supplierId,
    kind: 'ARRIVAL_DAMAGE', payableBasis: 'NET_AT_RECEIPT', totalLossAmount: loss, description: '逾期到货异常', evidenceImages: [],
    status: 'PENDING', createdById: userId, createdAt: new Date(),
    items: { create: { productId, orderedQty: amount / 10, receivedQty: amount / 10, lossQty: loss / 10, unitPrice: 10, lossAmount: loss } },
  } })
  const supplier = await prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } })
  if (derive) await autoProcessAfterConfirm({ tenantId, receipt: { ...receipt, confirmedAt: receipt.confirmedAt! }, supplier })
  return { receipt, claim, supplier }
}

describe('noon receipt finance (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: suffix, slug: suffix } }); tenantId = tenant.id
    const [store, supplier] = await Promise.all([
      prisma.store.create({ data: { tenantId, no: `S-${suffix}`, name: '中午账期门店' } }),
      prisma.supplier.create({ data: { tenantId, no: `SUP-${suffix}`, name: '中午账期供应商' } }),
    ]); storeId = store.id; supplierId = supplier.id
    const user = await prisma.user.create({ data: { tenantId, storeId, storeIds: [storeId], name: '测试员', email: `${suffix}@test`, password: 'test', role: 'ADMIN' } }); userId = user.id
    const product = await prisma.product.create({ data: {
      tenantId, supplierId, code: `P-${suffix}`, name: '测试品', unit: '件', price: 10,
      purchaseUnit: '件', inventoryUnit: '件', orderUnit: '件', costUnit: '件',
      inventoryUnitsPerPurchaseUnit: 1, inventoryUnitsPerOrderUnit: 1,
      inventoryUnitsPerCostUnit: 1, unitConversionStatus: 'VERIFIED',
    } }); productId = product.id
    app = Fastify()
    app.decorate('authenticate', async (request: any) => {
      request.user = { tenantId, storeId, storeIds: [storeId], userId, role: 'ADMIN' }
    })
    await app.register(receiptRoutes, { prefix: '/api/receipts' })
    await app.register(lossClaimRoutes, { prefix: '/api/loss-claims' })
    await app.ready()
  })
  afterAll(async () => {
    if (app) await app.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    if (!tenantId) return
    await prisma.invoicePayment.deleteMany({ where: { tenantId } })
    await prisma.lossClaimItem.deleteMany({ where: { lossClaim: { tenantId } } }); await prisma.lossClaim.deleteMany({ where: { tenantId } })
    await prisma.paymentSchedule.deleteMany({ where: { tenantId } }); await prisma.reconciliationItem.deleteMany({ where: { reconciliation: { tenantId } } }); await prisma.reconciliation.deleteMany({ where: { tenantId } })
    await prisma.voucherEntry.deleteMany({ where: { voucher: { tenantId } } }); await prisma.voucher.deleteMany({ where: { tenantId } })
    await prisma.receiptItem.deleteMany({ where: { receipt: { tenantId } } }); await prisma.receipt.deleteMany({ where: { tenantId } }); await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { tenantId } } }); await prisma.purchaseOrder.deleteMany({ where: { tenantId } })
    await prisma.notification.deleteMany({ where: { tenantId } }); await prisma.opLog.deleteMany({ where: { tenantId } }); await prisma.businessSequence.deleteMany({ where: { tenantId } })
    await prisma.product.deleteMany({ where: { tenantId } }); await prisma.user.deleteMany({ where: { tenantId } }); await prisma.store.deleteMany({ where: { tenantId } }); await prisma.supplier.deleteMany({ where: { tenantId } }); await prisma.tenant.delete({ where: { id: tenantId } })
  })
  it('creates ON_HOLD for late NET 80/20 and approves without duplicating the 80 payable', async () => {
    const { receipt, claim } = await fixture(80)
    expect((await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })).status).toBe('ON_HOLD')
    await approveLossClaimAtomically({ claimId: claim.id, tenantId, operatorId: userId, reason: '人工批准' })
    const schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })
    expect(Number(schedule.amount)).toBe(80); expect(schedule.status).toBe('PENDING')
  })
  it('restores a high-value late NET schedule to PENDING_APPROVAL', async () => {
    const { receipt, claim } = await fixture(2100, 20)
    await approveLossClaimAtomically({ claimId: claim.id, tenantId, operatorId: userId, reason: '人工批准' })
    const schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })
    expect(schedule.needApproval).toBe(true); expect(schedule.status).toBe('PENDING_APPROVAL')
  })
  it('serializes concurrent NET approval and receipt financial derivation without duplicate or permanent hold', async () => {
    const { receipt, claim, supplier } = await fixture(80, 20, false)
    await Promise.all([
      autoProcessAfterConfirm({ tenantId, receipt: { ...receipt, confirmedAt: receipt.confirmedAt! }, supplier }),
      approveLossClaimAtomically({ claimId: claim.id, tenantId, operatorId: userId, reason: '与派生并发的人工批准' }),
    ])
    const [schedule, currentClaim, reconciliationCount] = await Promise.all([
      prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } }),
      prisma.lossClaim.findUniqueOrThrow({ where: { id: claim.id } }),
      prisma.reconciliationItem.count({ where: { receiptId: receipt.id } }),
    ])
    expect(Number(schedule.amount)).toBe(80)
    expect(schedule.status).toBe('PENDING')
    expect(currentClaim.status).toBe('APPROVED')
    expect(reconciliationCount).toBe(1)
    await autoProcessAfterConfirm({ tenantId, receipt: { ...receipt, confirmedAt: receipt.confirmedAt! }, supplier })
    expect(await prisma.paymentSchedule.count({ where: { receiptId: receipt.id } })).toBe(1)
    expect(await prisma.reconciliationItem.count({ where: { receiptId: receipt.id } })).toBe(1)
  })
  it('serializes concurrent NET rejection and GROSS approval on one receipt to the correct 80 → 90 settlement', async () => {
    const { receipt, claim: netClaim } = await fixture(80, 20)
    const grossClaim = await prisma.lossClaim.create({ data: {
      tenantId, no: `LC-gross-${fixtureSequence++}-${suffix}`, purchaseOrderId: netClaim.purchaseOrderId,
      receiptId: receipt.id, storeId, supplierId, kind: 'ARRIVAL_DAMAGE', payableBasis: 'GROSS_PENDING_CLAIM',
      totalLossAmount: 10, description: '验收后补报', evidenceImages: ['evidence://gross'], status: 'PENDING', createdById: userId,
      items: { create: { productId, orderedQty: 8, receivedQty: 8, lossQty: 1, unitPrice: 10, lossAmount: 10 } },
    } })
    const [rejected, approved] = await Promise.all([
      app.inject({ method: 'PATCH', url: `/api/loss-claims/${netClaim.id}/handle`, payload: { action: 'reject', note: '并发异议' } }),
      app.inject({ method: 'PATCH', url: `/api/loss-claims/${grossClaim.id}/handle`, payload: { action: 'approve', note: '并发认可' } }),
    ])
    expect(rejected.statusCode).toBe(200)
    expect(approved.statusCode).toBe(200)
    const schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })
    expect(Number(schedule.amount)).toBe(90)
    expect(schedule.status).toBe('ON_HOLD')
  })
  it('raises the existing approval gate when a late NET rejection moves 1,950 to 2,050', async () => {
    const { receipt, claim } = await fixture(1950, 100)
    const reject = await app.inject({
      method: 'PATCH', url: `/api/loss-claims/${claim.id}/handle`, payload: { action: 'reject', note: '金额恢复' },
    })
    expect(reject.statusCode).toBe(200)
    let schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })
    expect(Number(schedule.amount)).toBe(2050)
    expect(schedule.needApproval).toBe(true)
    expect(schedule.status).toBe('ON_HOLD')
    const resolved = await app.inject({
      method: 'PATCH', url: `/api/loss-claims/${claim.id}/resolve`, payload: { finalDeductAmount: 0, note: '全额恢复待总部审批' },
    })
    expect(resolved.statusCode).toBe(200)
    schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })
    expect(schedule.status).toBe('PENDING_APPROVAL')
  })
  it('rejects then resolves a late NET 80/20 claim without changing received 80 or double-applying its deduction', async () => {
    const { receipt, claim } = await fixture(80)
    const reject = await app.inject({
      method: 'PATCH', url: `/api/loss-claims/${claim.id}/handle`, payload: { action: 'reject', note: '需仲裁' },
    })
    expect(reject.statusCode).toBe(200)
    let schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })
    expect(Number(schedule.amount)).toBe(100)
    expect(schedule.status).toBe('ON_HOLD')
    const resolve = await app.inject({
      method: 'PATCH', url: `/api/loss-claims/${claim.id}/resolve`, payload: { finalDeductAmount: 10, note: '折中处理' },
    })
    expect(resolve.statusCode).toBe(200)
    schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })
    expect(Number(schedule.amount)).toBe(90)
    expect(schedule.status).toBe('PENDING')
    expect(Number((await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).totalAmount)).toBe(80)
    const duplicate = await app.inject({
      method: 'PATCH', url: `/api/loss-claims/${claim.id}/resolve`, payload: { finalDeductAmount: 10, note: '重复提交' },
    })
    expect(duplicate.statusCode).toBe(200)
    expect(Number((await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })).amount)).toBe(90)
  })
  it('keeps a timely legacy confirm-with-loss claim approved and its schedule payable', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(shanghaiTodayAt(11, 59))
    try {
    const order = await prisma.purchaseOrder.create({ data: {
      tenantId, no: `PO-timely-${suffix}`, storeId, supplierId, expectedDate: new Date(), totalAmount: 100,
      status: 'RECEIVED', createdById: userId, items: { create: { productId, quantity: 10, unitPrice: 10, amount: 100 } },
    } })
    const receipt = await prisma.receipt.create({ data: {
      tenantId, no: `RK-timely-${suffix}`, storeId, supplierId, purchaseOrderId: order.id,
      deliveryDate: new Date(), totalAmount: 100, status: 'PENDING', createdById: userId,
      items: { create: { productId, quantity: 10, unitPrice: 10, amount: 100 } },
    } })
    const response = await app.inject({
      method: 'PATCH', url: `/api/receipts/${receipt.id}/confirm-with-loss`,
      payload: { description: '短量', evidenceImages: ['evidence://timely'], items: [{ productId, receivedQty: 8 }] },
    })
    expect(response.statusCode).toBe(200)
    const claim = await prisma.lossClaim.findFirstOrThrow({ where: { receiptId: receipt.id } })
    const schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })
    expect(claim.status).toBe('APPROVED')
    expect(Number(schedule.amount)).toBe(80)
    expect(schedule.status).toBe('PENDING')
    } finally {
      vi.useRealTimers()
    }
  })
  it('accepts a late confirm-with-loss report but freezes its 80 payable for manual approval', async () => {
    const order = await prisma.purchaseOrder.create({ data: {
      tenantId, no: `PO-late-${suffix}`, storeId, supplierId, expectedDate: yesterdayDate, totalAmount: 100,
      status: 'RECEIVED', createdById: userId, items: { create: { productId, quantity: 10, unitPrice: 10, amount: 100 } },
    } })
    const receipt = await prisma.receipt.create({ data: {
      tenantId, no: `RK-late-${suffix}`, storeId, supplierId, purchaseOrderId: order.id,
      deliveryDate: yesterdayDate, totalAmount: 100, status: 'PENDING', createdById: userId,
      items: { create: { productId, quantity: 10, unitPrice: 10, amount: 100 } },
    } })
    const response = await app.inject({
      method: 'PATCH', url: `/api/receipts/${receipt.id}/confirm-with-loss`,
      payload: { description: '短量', evidenceImages: ['evidence://late'], items: [{ productId, receivedQty: 8 }] },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().lateReport).toMatchObject({ overdue: true, requiresManualApproval: true })
    const claim = await prisma.lossClaim.findFirstOrThrow({ where: { receiptId: receipt.id } })
    const schedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })
    expect(claim.status).toBe('PENDING')
    expect(Number(claim.totalLossAmount)).toBe(20)
    expect(Number(schedule.amount)).toBe(80)
    expect(schedule.status).toBe('ON_HOLD')
    await approveLossClaimAtomically({ claimId: claim.id, tenantId, operatorId: userId, reason: '人工批准' })
    expect((await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: receipt.id } })).status).toBe('PENDING')
  })
})
