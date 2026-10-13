import crypto from 'node:crypto'
import { Prisma } from '@dianjie/db'
import { serializableWithRetry } from './warehouseLedger'
import { inventoryPolicySnapshot, resolveInventoryRule, STAGNANT_REMINDER_DAYS, type WarehouseInventoryPolicyWrite } from './warehouseInventoryPolicy'

export type PolicyAction = 'submit' | 'audit' | 'unconfirm' | 'review' | 'unreview' | 'revise'
const fail = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode })
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value))
const effectiveSnapshot = (policy: any) => policy ? { ...inventoryPolicySnapshot(policy), restoredLegacy: policy.restoredLegacy === true } : null
export function policyRevisionView(revision: any) {
  return revision ? { id: revision.id, status: revision.status, rowVersion: revision.rowVersion, payload: revision.payload, updatedAt: revision.updatedAt, cycleNumber:revision.cycleNumber, previousEffective:revision.previousEffective, baseEffectiveVersion:revision.baseEffectiveVersion, effectiveVersion:revision.effectiveVersion } : null
}

/** Draft and progress are separate from effective rules. Only review/unreview touch policy; never ledger. */
export async function changeInventoryPolicy(input: {
  tenantId: string; userId: string; productId: string; warehouseId: string;
  action: 'save' | PolicyAction; requestId: string; rowVersion: number; revisionId?:string; values?: WarehouseInventoryPolicyWrite
}) {
  if(input.action==='unreview')throw fail('复审后流程已结束，不支持取消复审')
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ ...input, userId: undefined })).digest('hex')
  return serializableWithRetry(async tx => {
    const actor = await tx.user.findFirst({ where: { tenantId: input.tenantId, id: input.userId }, select: { id: true, name: true, role: true } })
    if (!actor || !['SUPPLY_CHAIN', 'ADMIN', 'SUPER_ADMIN'].includes(actor.role)) throw fail('仅供应链可处理库存规则审批', 403)
    const replay = await tx.warehouseInventoryPolicyRevisionEvent.findUnique({ where: { tenantId_requestId: { tenantId: input.tenantId, requestId: input.requestId } } })
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw fail('同一请求编号不能用于不同审批内容')
      return { ...(replay.afterValue as any), replayed: true }
    }
    if (await tx.warehouseInventoryPolicyEvent.findUnique({where:{tenantId_requestId:{tenantId:input.tenantId,requestId:input.requestId}}})) throw fail('旧规则请求编号不能复用于新的审批请求')
    // Product lock serializes first draft creation and all transitions for its warehouses.
    await tx.$queryRaw`SELECT id FROM products WHERE id=${input.productId} AND "tenantId"=${input.tenantId} FOR UPDATE`
    const product = await tx.product.findFirst({ where: { tenantId: input.tenantId, id: input.productId } })
    const warehouse = await tx.warehouse.findFirst({ where: { tenantId: input.tenantId, id: input.warehouseId, isActive: true } })
    if (!product || !warehouse) throw fail('商品或仓库不存在、不属于当前租户或仓库已停用', 404)
    if (!['unconfirm','unreview'].includes(input.action) && (!product.inventoryUnit || product.unitConversionStatus !== 'VERIFIED')) throw fail('请先核验商品库存基准单位')
    const scope = { tenantId: input.tenantId, warehouseId: input.warehouseId, productId: input.productId }
    let revision = await tx.warehouseInventoryPolicyRevision.findFirst({ where: {...scope,isCurrent:true} })
    let policy = await tx.warehouseInventoryPolicy.findUnique({ where: { tenantId_warehouseId_productId: scope } })
    const before = { revision: policyRevisionView(revision), policy: effectiveSnapshot(policy) }
    const currentVersion = policy?.rowVersion ?? 0
    const legacyRule=resolveInventoryRule(product,null,product.inventoryUnit || product.unit)
    const previousEffective=before.policy ?? {inventoryUnitSnapshot:product.inventoryUnit || product.unit,minQty:legacyRule.minQty,maxQty:legacyRule.maxQty,stagnantDays:STAGNANT_REMINDER_DAYS,active:legacyRule.source==='legacy-fallback',rowVersion:0,restoredLegacy:true}
    if(revision && (input.action==='save'?input.values?.revisionId:input.revisionId)!==revision.id)throw fail('审批轮次已变化，请刷新核对；本页输入保留')
    if (input.action === 'save') {
      const v = input.values!
      if (revision && !['DRAFT', 'PENDING'].includes(revision.status)) throw fail('已审核规则不能直接修改；待复审可反审核，已复审请开始新修订')
      if (input.rowVersion !== (revision?.rowVersion ?? 0) || v.rowVersion !== currentVersion) throw fail('规则或草稿已被其他人修改，请刷新后重试')
      if (policy && policy.inventoryUnitSnapshot !== product.inventoryUnit && !v.confirmUnitChange) throw fail('库存单位已变更，请核对上下限并确认')
      const previousUnit=(revision?.payload as any)?.inventoryUnitSnapshot || policy?.inventoryUnitSnapshot
      if(v.inventoryUnitSnapshot && v.inventoryUnitSnapshot!==product.inventoryUnit)throw fail('商品库存单位已变化，请刷新并按新单位重新填写上下限')
      if(previousUnit && previousUnit!==product.inventoryUnit && (!v.confirmUnitChange || v.inventoryUnitSnapshot!==product.inventoryUnit))throw fail('旧拟值单位已变化，请明确新单位并重新填写上下限后保存')
      const payload = { inventoryUnitSnapshot: product.inventoryUnit, minQty: v.minQty, maxQty: v.maxQty, active: v.active, stagnantDays: STAGNANT_REMINDER_DAYS }
      revision = revision
        ? await tx.warehouseInventoryPolicyRevision.update({ where: { id: revision.id }, data: { payload, status: 'DRAFT', previousEffective: json(previousEffective), baseEffectiveVersion: currentVersion, effectiveVersion: null, rowVersion: { increment: 1 } } })
        : await tx.warehouseInventoryPolicyRevision.create({ data: { ...scope, createdById: actor.id, payload, previousEffective: json(previousEffective), baseEffectiveVersion: currentVersion } })
    } else {
      if (!revision) throw fail('请先保存规则草稿', 404)
      if (revision.rowVersion !== input.rowVersion) throw fail('审批状态已变化，请刷新后重试')
      if(input.action==='revise'){
        if(revision.status!=='REVIEWED'||revision.effectiveVersion!==currentVersion)throw fail('仅当前已复审的有效规则可以开始新修订')
        await tx.warehouseInventoryPolicyRevision.update({where:{id:revision.id},data:{isCurrent:false,rowVersion:{increment:1}}})
        const cycleNumber=revision.cycleNumber+1
        revision=await tx.warehouseInventoryPolicyRevision.create({data:{...scope,createdById:actor.id,cycleNumber,payload:json({inventoryUnitSnapshot:product.inventoryUnit,minQty:policy?.inventoryUnitSnapshot===product.inventoryUnit&&policy.minQty!==null?Number(policy.minQty):null,maxQty:policy?.inventoryUnitSnapshot===product.inventoryUnit&&policy.maxQty!==null?Number(policy.maxQty):null,active:policy?.active ?? true,stagnantDays:STAGNANT_REMINDER_DAYS}),previousEffective:json(previousEffective),baseEffectiveVersion:currentVersion}})
      }else{
      const transitions: Record<Exclude<PolicyAction,'revise'>, [string, string]> = {
        submit: ['DRAFT', 'PENDING'], audit: ['PENDING', 'AUDITED'],
        unconfirm: ['AUDITED', 'PENDING'], review: ['AUDITED', 'REVIEWED'], unreview: ['REVIEWED', 'AUDITED'],
      }
      const [from, to] = transitions[input.action]
      if (revision.status !== from) throw fail('当前状态不允许此操作；复审后流程已结束')
      const value = revision.payload as any
      if (!['unconfirm','unreview'].includes(input.action) && value.inventoryUnitSnapshot !== product.inventoryUnit) throw fail('商品单位已变化，请反审核后重新核对规则')
      if (['submit', 'audit', 'review'].includes(input.action) && currentVersion !== revision.baseEffectiveVersion) throw fail('当前有效规则已变化，请重新核对草稿')
      let baseEffectiveVersion = revision.baseEffectiveVersion, effectiveVersion = revision.effectiveVersion
      if (input.action === 'review' || input.action === 'unreview') {
        if (input.action === 'unreview' && currentVersion !== revision.effectiveVersion) throw fail('已有更新的有效规则，不能撤回旧版本')
        const restored = revision.previousEffective as any
        // A formerly absent policy must restore legacy fallback, not fabricate an inactive override.
        const data = input.action === 'review' ? { ...value, restoredLegacy: false }
          : restored ? { inventoryUnitSnapshot: restored.inventoryUnitSnapshot, minQty: restored.minQty, maxQty: restored.maxQty, active: restored.active, stagnantDays: STAGNANT_REMINDER_DAYS, restoredLegacy: restored.restoredLegacy === true }
          : { inventoryUnitSnapshot: product.inventoryUnit, minQty: null, maxQty: null, active: false, stagnantDays: STAGNANT_REMINDER_DAYS, restoredLegacy: true }
        const actorData = { updatedById: actor.id, updatedByName: actor.name, updatedByRole: actor.role }
        policy = policy
          ? await tx.warehouseInventoryPolicy.update({ where: { id: policy.id }, data: { ...data, ...actorData, rowVersion: { increment: 1 } } })
          : await tx.warehouseInventoryPolicy.create({ data: { ...scope, ...data, ...actorData, createdById: actor.id, createdByName: actor.name, createdByRole: actor.role } })
        if (input.action === 'review') effectiveVersion = policy.rowVersion
        else { baseEffectiveVersion = policy.rowVersion; effectiveVersion = null }
        await tx.warehouseInventoryPolicyEvent.create({ data: { tenantId: input.tenantId, policyId: policy.id, actorId: actor.id, actorName: actor.name, actorRole: actor.role, requestId: input.requestId, requestFingerprint: fingerprint, beforeValue: before.policy ?? Prisma.JsonNull, afterValue: json(effectiveSnapshot(policy)) } })
      }
      revision = await tx.warehouseInventoryPolicyRevision.update({ where: { id: revision.id }, data: { status: to, baseEffectiveVersion, effectiveVersion, rowVersion: { increment: 1 } } })
      }
    }
    const result = { revision: policyRevisionView(revision), policy: effectiveSnapshot(policy), replayed: false }
    await tx.warehouseInventoryPolicyRevisionEvent.create({ data: { tenantId: input.tenantId, revisionId: revision!.id, action: input.action, requestId: input.requestId, fingerprint, actorId: actor.id, actorName: actor.name, actorRole: actor.role, beforeValue: json(before), afterValue: json(result) } })
    return result
  })
}
