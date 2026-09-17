/**
 * 本地隔离库的上游采购真实闭环验收。
 *
 * 运行前提：
 *   1. API 已在本机启动，并显式开启两个 UPSTREAM 开关；
 *   2. apps/api/.env 的 DATABASE_URL 必须指向 localhost 且库名包含 local/test/ci；
 *   3. UPSTREAM_E2E_ALLOW_LOCAL=true。
 *
 * 脚本会创建带 E2E 前缀的合同、采购单、发货、收货、差异和对账数据，
 * 以及一个绑定本地验证供应商的临时负责人账号。绝不允许连接生产库。
 */
import 'dotenv/config'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { prisma } from '@dianjie/db'
import { issueAccessToken } from '../src/services/authTokens'

const apiBase = process.env.UPSTREAM_E2E_API_BASE || 'http://127.0.0.1:4444'

function assertSafeTarget() {
  if (process.env.UPSTREAM_E2E_ALLOW_LOCAL !== 'true') {
    throw new Error('安全护栏：必须显式设置 UPSTREAM_E2E_ALLOW_LOCAL=true')
  }
  const databaseUrl = new URL(process.env.DATABASE_URL || '')
  const localHost = ['127.0.0.1', 'localhost'].includes(databaseUrl.hostname)
  const safeDb = /(local|test|ci)/i.test(databaseUrl.pathname)
  const localApi = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(apiBase)
  if (!localHost || !safeDb || !localApi) {
    throw new Error('安全护栏：该验收脚本只允许本机 API 与 local/test/ci 数据库')
  }
}

async function request<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })
  const body = await response.json().catch(() => ({})) as any
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${path} → ${response.status}: ${body.error || body.message || '请求失败'}`)
  return body as T
}

async function main() {
  assertSafeTarget()
  const health = await request<{ status: string; db: string }>('/health')
  if (health.status !== 'ok' || health.db !== 'ok') throw new Error('本地 API 或数据库健康检查未通过')

  const tenantSlug = process.env.PREVIEW_TENANT_SLUG || 'yaohai-test'
  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } })
  if (!tenant) throw new Error(`未找到本地测试租户 ${tenantSlug}`)
  const internalUser = await prisma.user.findFirst({
    where: { tenantId: tenant.id, role: { in: ['SUPPLY_CHAIN', 'ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  })
  if (!internalUser) throw new Error('本地测试租户没有供应链/管理员账号')
  const financeUser = await prisma.user.findFirst({
    where: { tenantId: tenant.id, role: 'FINANCE', status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  })
  if (!financeUser) throw new Error('本地测试租户没有财务账号')

  const signer = Fastify()
  await signer.register(jwt, { secret: process.env.JWT_SECRET || 'local-development-only-jwt-secret' })
  await signer.ready()
  const internalToken = issueAccessToken(signer.jwt, internalUser)
  const financeToken = issueAccessToken(signer.jwt, financeUser)
  const stamp = Date.now().toString().slice(-10)

  const flags = await request<{ procurement: boolean; receiptPosting: boolean }>('/api/upstream/feature-status', internalToken)
  if (!flags.procurement || !flags.receiptPosting) throw new Error('上游采购或收货入账开关未开启')

  const setup = await request<any>('/api/upstream/setup-options', internalToken)
  const supplier = setup.suppliers.find((item: any) => item.no === 'LOCAL-UPSTREAM-VERIFY') || setup.suppliers[0]
  const warehouse = setup.warehouses[0]
  if (!supplier || !warehouse) throw new Error('缺少启用的上游供应商或总仓')
  const sourceSetup = await request<any>(`/api/upstream/setup-options?supplierId=${encodeURIComponent(supplier.id)}`, internalToken)
  const source = sourceSetup.sources[0]
  if (!source) throw new Error(`供应商 ${supplier.name} 尚未绑定采购商品`)

  const contract = await request<any>('/api/upstream/contracts', internalToken, {
    method: 'POST',
    body: JSON.stringify({
      supplierId: supplier.id,
      contractNo: `E2E-${stamp}`,
      title: `本地闭环验收 ${stamp}`,
      startsAt: new Date().toISOString(),
      settlementCycle: 'MONTHLY',
      settlementDays: 0,
      taxInclusive: true,
      currency: 'CNY',
      lines: [{
        upstreamSourceId: source.id,
        unitPrice: Number(source.quotedUnitPrice || 12.34),
        packageMultiple: 1,
        shortTolerancePct: 0,
        overTolerancePct: 0,
      }],
    }),
  })
  await request(`/api/upstream/contracts/${contract.id}/activate`, internalToken, { method: 'POST' })

  const quantity = Math.max(1, Math.ceil(Number(source.minOrderQty || 1)))
  const order = await request<any>('/api/upstream/purchase-orders', internalToken, {
    method: 'POST',
    body: JSON.stringify({
      supplierId: supplier.id,
      warehouseId: warehouse.id,
      contractId: contract.id,
      expectedArrivalAt: new Date().toISOString(),
      origin: 'MANUAL',
      idempotencyKey: `e2e-order-${stamp}`,
      lines: [{ contractLineId: contract.lines[0].id, quantity }],
    }),
  })
  await request(`/api/upstream/purchase-orders/${order.id}/submit-for-approval`, internalToken, { method: 'POST' })
  await request(`/api/upstream/purchase-orders/${order.id}/approve-and-send`, internalToken, { method: 'POST' })

  const invite = await request<any>(`/api/upstream/suppliers/${supplier.id}/invites`, internalToken, {
    method: 'POST',
    body: JSON.stringify({ role: 'SUPPLIER_OWNER', note: `E2E ${stamp}`, expiresHours: 1 }),
  })
  const phone = `139${stamp.slice(-8)}`
  await request(`/api/invite-accept/${invite.token}/accept`, undefined, {
    method: 'POST',
    body: JSON.stringify({ name: '上游闭环验收员', phone, password: `E2e!${stamp}` }),
  })
  const supplierUser = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, phone, supplierId: supplier.id } })
  const supplierToken = issueAccessToken(signer.jwt, supplierUser)

  await request(`/api/upstream/purchase-orders/${order.id}/accept`, supplierToken, { method: 'POST' })
  const orderDetail = await request<any>(`/api/upstream/purchase-orders/${order.id}`, supplierToken)
  const shipment = await request<any>(`/api/upstream/purchase-orders/${order.id}/shipments`, supplierToken, {
    method: 'POST',
    body: JSON.stringify({
      supplierShipmentNo: `E2E-SHIP-${stamp}`,
      carrierName: '本地闭环验证',
      expectedArrivalAt: new Date().toISOString(),
      idempotencyKey: `e2e-shipment-${stamp}`,
      lines: orderDetail.lines.map((line: any) => ({ purchaseOrderLineId: line.id, shippedQty: Number(line.orderedQty) })),
    }),
  })
  await request(`/api/upstream/shipments/${shipment.id}/dispatch`, supplierToken, { method: 'POST' })

  const receipt = await request<any>(`/api/upstream/shipments/${shipment.id}/receipts`, internalToken, {
    method: 'POST',
    body: JSON.stringify({
      finalForShipment: true,
      idempotencyKey: `e2e-receipt-${stamp}`,
      evidence: [{ kind: 'E2E', note: '本地闭环验收' }],
      lines: shipment.lines.map((line: any) => ({
        shipmentLineId: line.id,
        arrivedQty: Number(line.shippedQty),
        acceptedQty: Number(line.shippedQty),
        damagedQty: 0,
        rejectedQty: 0,
      })),
    }),
  })
  await request(`/api/upstream/receipts/${receipt.id}/start-inspection`, internalToken, { method: 'POST' })
  const posting = await request<any>(`/api/upstream/receipts/${receipt.id}/confirm`, internalToken, { method: 'POST' })
  if (posting.pendingReview) throw new Error('E2E 小额普通收货不应进入第二人复核')

  const affectedQty = Math.max(0.000001, Number((quantity * 0.1).toFixed(6)))
  const claimPayload = {
    idempotencyKey: `e2e-claim-${stamp}`,
    description: '本地闭环：拆包后发现少量品质异常',
    evidence: [{ kind: 'E2E', note: '模拟拆包异常证据' }],
    lines: [{ receiptLineId: receipt.lines[0].id, affectedQty }],
  }
  const claim = await request<any>(`/api/upstream/receipts/${receipt.id}/post-receipt-claims`, internalToken, {
    method: 'POST',
    body: JSON.stringify(claimPayload),
  })
  const replayedClaim = await request<any>(`/api/upstream/receipts/${receipt.id}/post-receipt-claims`, internalToken, {
    method: 'POST', body: JSON.stringify(claimPayload),
  })
  if (replayedClaim.id !== claim.id) throw new Error('补报重试生成了重复差异单')
  await request(`/api/upstream/arrival-claims/${claim.id}/respond`, supplierToken, {
    method: 'POST', body: JSON.stringify({ decision: 'ACCEPT', response: '本地闭环确认承担' }),
  })
  await request(`/api/upstream/arrival-claims/${claim.id}/resolve`, internalToken, {
    method: 'POST',
    body: JSON.stringify({ responsibility: 'SUPPLIER', resolution: 'DEDUCTION', resolvedAmount: Number(claim.claimedAmount), note: 'E2E 办结' }),
  })

  const now = new Date()
  const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  const end = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()).padStart(2, '0')}`
  const statement = await request<any>('/api/upstream/settlement-statements/generate', internalToken, {
    method: 'POST', body: JSON.stringify({ supplierId: supplier.id, periodStart: start, periodEnd: end, note: `E2E ${stamp}` }),
  })
  await request(`/api/upstream/settlement-statements/${statement.id}/send`, internalToken, { method: 'POST' })
  await request(`/api/upstream/settlement-statements/${statement.id}/confirm`, supplierToken, { method: 'POST' })
  let internalLockDenied = false
  try {
    await request(`/api/upstream/settlement-statements/${statement.id}/lock`, internalToken, { method: 'POST' })
  } catch (error) {
    internalLockDenied = error instanceof Error && error.message.includes('→ 403')
  }
  if (!internalLockDenied) throw new Error('供应链账号不应拥有财务锁账权限')
  const locked = await request<any>(`/api/upstream/settlement-statements/${statement.id}/lock`, financeToken, { method: 'POST' })

  const [postedReceipt, resolvedClaim, ledgerMovements] = await Promise.all([
    prisma.upstreamReceipt.findUnique({ where: { id: receipt.id }, select: { status: true, postedAt: true } }),
    prisma.upstreamArrivalClaim.findUnique({ where: { id: claim.id }, select: { status: true, resolvedAmount: true } }),
    prisma.warehouseLedgerMovement.findMany({
      where: { tenantId: tenant.id, sourceId: { in: [receipt.id, claim.id] } },
      select: { type: true, sourceId: true, physicalDelta: true, valueDelta: true },
      orderBy: { recordedAt: 'asc' },
    }),
  ])
  if (postedReceipt?.status !== 'POSTED' || resolvedClaim?.status !== 'RESOLVED' || locked.status !== 'LOCKED') {
    throw new Error('闭环最终状态不符合预期')
  }
  if (!ledgerMovements.some(item => item.type === 'UPSTREAM_RECEIPT' && item.sourceId === receipt.id)) {
    throw new Error('收货没有生成 UPSTREAM_RECEIPT 库存流水')
  }
  if (!ledgerMovements.some(item => item.type === 'LOSS' && item.sourceId === claim.id)) {
    throw new Error('收货后报损没有生成 LOSS 库存流水')
  }

  console.log(JSON.stringify({
    ok: true,
    supplier: supplier.name,
    contract: contract.contractNo,
    purchaseOrder: order.no,
    shipment: shipment.no,
    receipt: receipt.no,
    claim: claim.no,
    settlement: locked.no,
    settlementStatus: locked.status,
    ledgerMovementTypes: ledgerMovements.map(item => item.type),
  }, null, 2))
  await signer.close()
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
