import { Prisma } from '@dianjie/db'
import { createHash } from 'node:crypto'
import { orderNetCostLedger } from './inventoryNetCostRead'
const D = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v)
const reject = (message: string, statusCode = 422): never => { throw Object.assign(new Error(message), { statusCode }) }
export type NetBasisInput = {
  tenantId: string; movementId: string; userId: string; requestKey: string; expectedVersion: number
  netValueDelta?: Prisma.Decimal | string | number | null; poolNetValueAfter?: Prisma.Decimal | string | number | null; expectedPostingSequence?: number; evidenceRefs: string[]
  basisType: 'TAX_RATE' | 'NET_DOCUMENT' | 'ALREADY_NET' | 'POOL_DOCUMENT'; taxRate?: Prisma.Decimal | string | number | null; note?: string
}
export function validateNetBasis(input: NetBasisInput, movement: { physicalDelta: Prisma.Decimal; valueDelta: Prisma.Decimal; physicalAfter?: Prisma.Decimal; valueAfter?: Prisma.Decimal }) {
  const gross = D(movement.valueDelta), quantity = D(movement.physicalDelta)
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) reject('核定版本无效', 400)
  const refs = [...new Set(input.evidenceRefs.map(r => String(r).trim()))].sort()
  if (!refs.length || refs.length > 20 || refs.some(r => !/^(attachment|document|receipt|import|archive):[A-Za-z0-9._/:\-]{1,220}$/.test(r))) reject('请提供已有附件或来源单据的材料引用，不上传原件或填写密钥', 400)
  if (input.basisType === 'POOL_DOCUMENT') {
    if (input.poolNetValueAfter == null || input.netValueDelta != null || input.taxRate != null || !Number.isSafeInteger(input.expectedPostingSequence) || input.expectedPostingSequence! < 0) reject('当前库存池核定需填写净余额和当前过账序列，不能同时填写单笔金额或税率', 400)
    const pool = D(input.poolNetValueAfter!)
    if (!pool.isFinite() || pool.decimalPlaces() > 4 || pool.lte(0) || !movement.physicalAfter?.gt(0) || !movement.valueAfter?.gt(0) || pool.gt(movement.valueAfter)) reject('库存池净成本需大于0、不超过已补齐的账面总成本，且当前库存数量必须大于0')
    return { net: null, pool, rate: null, refs }
  }
  if (input.netValueDelta == null || input.poolNetValueAfter != null || input.expectedPostingSequence != null) reject('单笔核定需填写净金额，不应填写库存池核定字段', 400)
  const net = D(input.netValueDelta!)
  if (!net.isFinite() || net.decimalPlaces() > 4 || net.abs().gte('10000000000000000')) reject('核定净金额需为有效四位小数金额')
  if (!['TAX_RATE','NET_DOCUMENT','ALREADY_NET'].includes(input.basisType)) reject('请选择净额材料口径', 400)
  if ((gross.gt(0) && net.lte(0)) || (gross.lt(0) && net.gte(0)) || (gross.eq(0) && !net.eq(0)) || net.abs().gt(gross.abs())) reject('净金额符号或金额上限与原账面金额不一致')
  if (gross.eq(0) && !quantity.eq(0)) reject('原库存缺少账面成本，请先通过原成本补价入口补齐账面金额')
  let rate: Prisma.Decimal | null = null
  if (input.basisType === 'ALREADY_NET' && !net.equals(gross)) reject('按原金额核定时，成本应等于原账面金额')
  if (input.basisType === 'TAX_RATE' || input.taxRate != null) reject('此材料核定方式已停用，请直接填写成本金额', 400)
  return { net, pool: null, rate, refs }
}

export async function inventoryNetCostBasisContext(tx: any, tenantId: string, movementId: string) {
  const movement = await tx.warehouseLedgerMovement.findFirst({ where: { tenantId, id: movementId } })
  if (!movement) reject('原库存流水不存在', 404)
  const balance = await tx.warehouseLedgerBalance.findUnique({ where: { tenantId_warehouseId_productId: { tenantId, warehouseId: movement.warehouseId, productId: movement.productId } } })
  const latestVersion = await tx.warehouseNetCostBasisConfirmation.findFirst({ where: { tenantId, movementId }, orderBy: { version: 'desc' } })
  const newest = await tx.warehouseLedgerMovement.findFirst({ where: { tenantId, warehouseId: movement.warehouseId, productId: movement.productId, postingSequence: { not: null } }, orderBy: { postingSequence: 'desc' } })
  let latestMovement = newest
  if (!latestMovement) {
    const old = await tx.warehouseLedgerMovement.findMany({ where: { tenantId, warehouseId: movement.warehouseId, productId: movement.productId }, take: 50001 })
    if (old.length > 50000) reject('历史成本流水过多，请先定点核对历史基准')
    try { latestMovement = orderNetCostLedger(old).at(-1) } catch { reject('历史过账顺序无法唯一恢复，请先核对原流水') }
  }
  return { movement, balance, latestMovementId: latestMovement?.id ?? null, currentVersion: latestVersion?.version ?? 0, expectedPostingSequence: balance?.postingSequence ?? 0 }
}
/** Append-only confirmation; original quantity, value, batches and original source documents never change. */
export async function confirmInventoryNetCostBasis(tx: any, input: NetBasisInput) {
  const key = String(input.requestKey || '').trim()
  if (!key || key.length > 120) reject('核定请求编号无效', 400)
  const user = await tx.user.findFirst({ where: { id: input.userId, tenantId: input.tenantId, status: 'ACTIVE', role: { in: ['SUPPLY_CHAIN','ADMIN','SUPER_ADMIN'] } }, select: { id: true } })
  if (!user) reject('仅供应链或管理员可核定库存成本材料', 403)
  const initial = await tx.warehouseLedgerMovement.findFirst({ where: { id: input.movementId, tenantId: input.tenantId }, select: { warehouseId: true, productId: true } })
  if (!initial) reject('原库存流水不存在', 404)
  if (input.basisType === 'POOL_DOCUMENT') await tx.$queryRaw`SELECT id FROM warehouse_ledger_balances WHERE "tenantId"=${input.tenantId} AND "warehouseId"=${initial.warehouseId} AND "productId"=${initial.productId} FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM warehouse_ledger_movements WHERE id=${input.movementId} AND "tenantId"=${input.tenantId} FOR UPDATE`
  const movement = await tx.warehouseLedgerMovement.findFirst({ where: { id: input.movementId, tenantId: input.tenantId } })
  if (!movement) reject('原库存流水不存在', 404)
  const parsed = validateNetBasis(input, movement)
  const note = String(input.note || '').trim()
  if (note.length > 500) reject('核定说明过长', 400)
  const fingerprint = createHash('sha256').update(JSON.stringify({ movementId: movement.id, userId: user.id, net: parsed.net?.toFixed(4) ?? null, pool: parsed.pool?.toFixed(4) ?? null, expectedPostingSequence: input.expectedPostingSequence ?? null, basisType: input.basisType, rate: null, refs: parsed.refs, note, expectedVersion: input.expectedVersion })).digest('hex')
  const existing = await tx.warehouseNetCostBasisConfirmation.findUnique({ where: { tenantId_requestKey: { tenantId: input.tenantId, requestKey: key } } })
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) reject('同一核定请求编号不能用于不同内容', 409)
    return { replayed: true, confirmation: existing }
  }
  if (input.basisType === 'POOL_DOCUMENT') {
    const context = await inventoryNetCostBasisContext(tx, input.tenantId, movement.id)
    if (!context.balance || context.latestMovementId !== movement.id || context.expectedPostingSequence !== input.expectedPostingSequence || context.balance.inventoryUnit !== movement.inventoryUnit || !context.balance.physicalQty.equals(movement.physicalAfter) || !context.balance.inventoryValue.equals(movement.valueAfter)) reject('库存池已有新流水或余额变化，请刷新后使用最新成本材料核定', 409)
  }
  const prior = await tx.warehouseNetCostBasisConfirmation.findFirst({ where: { tenantId: input.tenantId, movementId: movement.id }, orderBy: { version: 'desc' } })
  if ((prior?.version ?? 0) !== input.expectedVersion) reject('成本材料已由其他人核定，请刷新后重试', 409)
  const confirmation = await tx.warehouseNetCostBasisConfirmation.create({ data: {
    tenantId: input.tenantId, warehouseId: movement.warehouseId, productId: movement.productId, movementId: movement.id,
    netValueDelta: parsed.net, poolNetValueAfter: parsed.pool, physicalAfterSnapshot: movement.physicalAfter, grossValueAfterSnapshot: movement.valueAfter, postingSequenceSnapshot: input.expectedPostingSequence ?? null, grossValueDeltaSnapshot: movement.valueDelta, physicalDeltaSnapshot: movement.physicalDelta,
    inventoryUnitSnapshot: movement.inventoryUnit, basisType: input.basisType, taxRate: parsed.rate, evidenceRefs: parsed.refs,
    confirmedById: user.id, requestKey: key, requestFingerprint: fingerprint, version: input.expectedVersion + 1,
    supersedesId: prior?.id ?? null, note,
  } })
  return { replayed: false, confirmation }
}
