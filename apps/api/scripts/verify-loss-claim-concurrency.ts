import 'dotenv/config'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { prisma } from '@dianjie/db'
import { approveLossClaimAtomically } from '../src/routes/lossClaims'

const API_BASE = process.env.TEST_API_BASE || 'http://localhost:4444'
const TENANT_SLUG = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
const PASSWORD = 'loss-local-123'

function assertLocalOnly() {
  const url = process.env.DATABASE_URL || ''
  if (process.env.PREVIEW_MODE !== 'true' || process.env.NODE_ENV === 'production' || !url.includes('dianjie_v4_local')) {
    throw new Error('安全护栏：报损并发验证仅允许本地 PREVIEW_MODE 隔离库')
  }
}

async function api(path: string, token: string | null, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

async function login(identifier: string) {
  const result = await api('/api/auth/login', null, {
    method: 'POST', body: JSON.stringify({ identifier, password: PASSWORD, tenantSlug: TENANT_SLUG }),
  })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  return result.body.token as string
}

async function main() {
  assertLocalOnly()
  const suffix = Date.now().toString(36)
  const startedAt = new Date()
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: TENANT_SLUG } })
  const store = await prisma.store.findFirstOrThrow({ where: { tenantId: tenant.id } })
  const manager = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, storeId: store.id, role: 'MANAGER' } })
  const supplierIds: string[] = []
  const userIds: string[] = []
  const productIds: string[] = []
  const orderIds: string[] = []
  const receiptIds: string[] = []
  const claimIds: string[] = []
  const claimNos: string[] = []

  try {
    const [supplierA, supplierB] = await Promise.all([
      prisma.supplier.create({ data: { tenantId: tenant.id, no: `LCA-${suffix}`, name: `报损并发供应商甲-${suffix}` } }),
      prisma.supplier.create({ data: { tenantId: tenant.id, no: `LCB-${suffix}`, name: `报损并发供应商乙-${suffix}` } }),
    ])
    supplierIds.push(supplierA.id, supplierB.id)
    const password = await bcrypt.hash(PASSWORD, 10)
    const [userA, userB, unboundSupplierUser] = await Promise.all([
      prisma.user.create({
        data: { tenantId: tenant.id, name: '报损验证供应商甲', email: `loss-a-${suffix}@local.test`, password, role: 'SUPPLIER_OWNER', supplierId: supplierA.id },
      }),
      prisma.user.create({
        data: { tenantId: tenant.id, name: '报损验证供应商乙', email: `loss-b-${suffix}@local.test`, password, role: 'SUPPLIER_OWNER', supplierId: supplierB.id },
      }),
      prisma.user.create({
        data: { tenantId: tenant.id, name: '未绑定供应商验证账号', email: `loss-unbound-${suffix}@local.test`, password, role: 'SUPPLIER_OWNER' },
      }),
    ])
    userIds.push(userA.id, userB.id, unboundSupplierUser.id)
    const [tokenA, tokenB, unboundToken] = await Promise.all([login(userA.email), login(userB.email), login(unboundSupplierUser.email)])

    async function createScenario(index: number) {
      const product = await prisma.product.create({
        data: {
          tenantId: tenant.id, supplierId: supplierA.id,
          code: `LOSS-${suffix}-${index}`, name: `报损并发商品-${index}`, unit: 'kg', price: 5, stock: 95,
        },
      })
      productIds.push(product.id)
      const order = await prisma.purchaseOrder.create({
        data: {
          tenantId: tenant.id, no: `PO-LOSS-${suffix}-${index}`,
          storeId: store.id, supplierId: supplierA.id, expectedDate: new Date('2026-07-16T00:00:00.000Z'),
          totalAmount: 25, originalTotalAmount: 25, currentOrderAmount: 25,
          status: 'RECEIVED', createdById: manager.id,
          items: {
            create: {
              productId: product.id, quantity: 5, originalQuantity: 5, shippedQty: 5,
              receivedQty: 3, unitPrice: 5, originalUnitPrice: 5, amount: 25, originalAmount: 25,
            },
          },
        },
      })
      orderIds.push(order.id)
      const receipt = await prisma.receipt.create({
        data: {
          tenantId: tenant.id, no: `RK-LOSS-${suffix}-${index}`,
          storeId: store.id, supplierId: supplierA.id, purchaseOrderId: order.id,
          deliveryDate: new Date('2026-07-16T00:00:00.000Z'), totalAmount: 15,
          status: 'ACCOUNTED', confirmedAt: new Date(), createdById: manager.id,
          items: { create: { productId: product.id, quantity: 3, unitPrice: 5, amount: 15 } },
        },
      })
      receiptIds.push(receipt.id)
      await prisma.purchaseOrder.update({ where: { id: order.id }, data: { receiptId: receipt.id } })
      await prisma.paymentSchedule.create({
        data: {
          tenantId: tenant.id, receiptId: receipt.id, supplierId: supplierA.id, storeId: store.id,
          amount: 15, creditDays: 30, confirmedAt: new Date(), dueAt: new Date('2026-08-15T00:00:00.000Z'), status: 'PENDING',
        },
      })
      const claim = await prisma.lossClaim.create({
        data: {
          tenantId: tenant.id, no: `LC-VERIFY-${suffix}-${index}`,
          purchaseOrderId: order.id, storeId: store.id, supplierId: supplierA.id,
          totalLossAmount: 10, description: '并发短量验证', evidenceImages: [], status: 'PENDING', createdById: manager.id,
          items: { create: { productId: product.id, orderedQty: 5, receivedQty: 3, lossQty: 2, unitPrice: 5, lossAmount: 10 } },
        },
      })
      claimIds.push(claim.id)
      claimNos.push(claim.no)
      return { product, order, receipt, claim }
    }

    const approveScenario = await createScenario(1)
    const unboundList = await api('/api/loss-claims?page=1&pageSize=20', unboundToken)
    assert.equal(unboundList.status, 200)
    assert.equal(unboundList.body.total, 0, '未绑定 supplierId 的供应商账号不能看到租户全部报损')
    assert.equal((await api(`/api/loss-claims/${approveScenario.claim.id}/handle`, unboundToken, {
      method: 'PATCH', body: JSON.stringify({ action: 'approve' }),
    })).status, 400, '未绑定 supplierId 的供应商账号不能处理任意报损')
    assert.equal((await api(`/api/loss-claims/${approveScenario.claim.id}/handle`, tokenB, {
      method: 'PATCH', body: JSON.stringify({ action: 'approve' }),
    })).status, 400, '供应商不能处理其他供应商的报损')
    const [approveA, approveB] = await Promise.all([
      api(`/api/loss-claims/${approveScenario.claim.id}/handle`, tokenA, { method: 'PATCH', body: JSON.stringify({ action: 'approve' }) }),
      api(`/api/loss-claims/${approveScenario.claim.id}/handle`, tokenA, { method: 'PATCH', body: JSON.stringify({ action: 'approve' }) }),
    ])
    assert.deepEqual([approveA.status, approveB.status], [200, 200])
    assert.equal([approveA.body.duplicated, approveB.body.duplicated].filter(Boolean).length, 1, '并发同意必须一主一幂等')
    assert.equal((await prisma.lossClaim.findUniqueOrThrow({ where: { id: approveScenario.claim.id } })).status, 'APPROVED')
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: approveScenario.product.id } })).stock), 97)
    assert.equal(await prisma.supplierStockMovement.count({
      where: { sourceType: 'LossClaim', sourceId: approveScenario.claim.id, productId: approveScenario.product.id },
    }), 1)
    assert.equal(Number((await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: approveScenario.receipt.id } })).amount), 15)

    const rejectScenario = await createScenario(2)
    const [rejectA, rejectB] = await Promise.all([
      api(`/api/loss-claims/${rejectScenario.claim.id}/handle`, tokenA, { method: 'PATCH', body: JSON.stringify({ action: 'reject', note: '数量无误' }) }),
      api(`/api/loss-claims/${rejectScenario.claim.id}/handle`, tokenA, { method: 'PATCH', body: JSON.stringify({ action: 'reject', note: '重复提交' }) }),
    ])
    assert.deepEqual([rejectA.status, rejectB.status], [200, 200])
    assert.equal([rejectA.body.duplicated, rejectB.body.duplicated].filter(Boolean).length, 1, '并发拒绝必须一主一幂等')
    assert.equal((await prisma.lossClaim.findUniqueOrThrow({ where: { id: rejectScenario.claim.id } })).status, 'REJECTED')
    const rejectSchedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: rejectScenario.receipt.id } })
    assert.equal(Number(rejectSchedule.amount), 25, '拒绝报损只允许把损失金额加回一次')
    assert.equal(rejectSchedule.status, 'ON_HOLD')
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: rejectScenario.product.id } })).stock), 95)
    assert.equal(await prisma.supplierStockMovement.count({ where: { sourceId: rejectScenario.claim.id } }), 0)

    const raceScenario = await createScenario(3)
    const [automatic, supplierReject] = await Promise.all([
      approveLossClaimAtomically({
        claimId: raceScenario.claim.id, tenantId: tenant.id, operatorId: manager.id,
        reason: '自动同意与供应商拒绝竞争', automatic: true,
      }),
      api(`/api/loss-claims/${raceScenario.claim.id}/handle`, tokenA, {
        method: 'PATCH', body: JSON.stringify({ action: 'reject', note: '并发拒绝' }),
      }),
    ])
    assert.equal(supplierReject.status, 200)
    const raceClaim = await prisma.lossClaim.findUniqueOrThrow({ where: { id: raceScenario.claim.id } })
    const raceStock = Number((await prisma.product.findUniqueOrThrow({ where: { id: raceScenario.product.id } })).stock)
    const raceSchedule = await prisma.paymentSchedule.findUniqueOrThrow({ where: { receiptId: raceScenario.receipt.id } })
    if (raceClaim.status === 'AUTO_APPROVED') {
      assert.equal(automatic.transitioned, true)
      assert.equal(raceStock, 97)
      assert.equal(Number(raceSchedule.amount), 15)
      assert.equal(await prisma.supplierStockMovement.count({ where: { sourceId: raceScenario.claim.id } }), 1)
    } else {
      assert.equal(raceClaim.status, 'REJECTED')
      assert.equal(automatic.transitioned, false)
      assert.equal(raceStock, 95)
      assert.equal(Number(raceSchedule.amount), 25)
      assert.equal(raceSchedule.status, 'ON_HOLD')
      assert.equal(await prisma.supplierStockMovement.count({ where: { sourceId: raceScenario.claim.id } }), 0)
    }

    console.log(JSON.stringify({
      ok: true,
      supplierIsolation: true,
      approveIdempotent: true,
      rejectIdempotent: true,
      schedulerSupplierRaceConsistent: true,
      raceWinner: raceClaim.status,
    }))
  } finally {
    await new Promise(resolve => setTimeout(resolve, 200))
    const voucherIds = (await prisma.voucher.findMany({
      where: { tenantId: tenant.id, sourceType: 'LossClaim', sourceId: { in: claimIds } }, select: { id: true },
    })).map(item => item.id)
    await prisma.$transaction(async tx => {
      for (const no of claimNos) {
        await tx.notification.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: startedAt }, body: { contains: no } } })
      }
      await tx.notificationLog.deleteMany({ where: { tenantId: tenant.id, createdAt: { gte: startedAt }, eventKey: { contains: 'LOSS:' } } })
      await tx.voucherEntry.deleteMany({ where: { voucherId: { in: voucherIds } } })
      await tx.voucher.deleteMany({ where: { id: { in: voucherIds } } })
      await tx.voucherGenerationFailure.deleteMany({ where: { tenantId: tenant.id, sourceType: 'LossClaim', sourceId: { in: claimIds } } })
      await tx.opLog.deleteMany({ where: { tenantId: tenant.id, OR: [{ targetId: { in: claimIds } }, { userId: { in: userIds }, createdAt: { gte: startedAt } }] } })
      await tx.supplierStockMovement.deleteMany({ where: { sourceType: 'LossClaim', sourceId: { in: claimIds } } })
      await tx.lossClaimItem.deleteMany({ where: { lossClaimId: { in: claimIds } } })
      await tx.lossClaim.deleteMany({ where: { id: { in: claimIds } } })
      await tx.paymentSchedule.deleteMany({ where: { receiptId: { in: receiptIds } } })
      await tx.receiptItem.deleteMany({ where: { receiptId: { in: receiptIds } } })
      await tx.purchaseOrder.updateMany({ where: { id: { in: orderIds } }, data: { receiptId: null } })
      await tx.receipt.deleteMany({ where: { id: { in: receiptIds } } })
      await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: { in: orderIds } } })
      await tx.purchaseOrder.deleteMany({ where: { id: { in: orderIds } } })
      await tx.product.deleteMany({ where: { id: { in: productIds } } })
      await tx.user.deleteMany({ where: { id: { in: userIds } } })
      await tx.supplier.deleteMany({ where: { id: { in: supplierIds } } })
    })
  }
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
