import type {Product,WarehouseInventoryPolicy,WarehouseLedgerBalance,WarehouseInventoryPolicyRevision} from '@dianjie/db'
import {policyRevisionView} from './inventoryPolicyApproval'
import {resolveInventoryRule,inventoryAlertStatus,STAGNANT_REMINDER_DAYS} from './warehouseInventoryPolicy'

/** Shared read projection. This module never executes a policy mutation. */
export function inventoryPolicyRow(product:Product,policy:WarehouseInventoryPolicy|undefined|null,balance:WarehouseLedgerBalance|undefined|null,revision:WarehouseInventoryPolicyRevision|undefined|null){
 const inventoryUnit=balance?.inventoryUnit||product.inventoryUnit||product.unit
 const rule=resolveInventoryRule(product,policy,inventoryUnit),currentQty=balance?Number(balance.physicalQty):0
 return {
  productId:product.id,code:product.code,name:product.name,spec:product.spec,category:product.category,inventoryUnit,currentQty,
  effectiveMin:rule.minQty,effectiveMax:rule.maxQty,effectiveUnit:inventoryUnit,storedUnit:policy?.inventoryUnitSnapshot||inventoryUnit,draftUnit:product.inventoryUnit||inventoryUnit,
  minQty:policy?.restoredLegacy?rule.minQty:policy?.minQty==null?rule.minQty:Number(policy.minQty),
  maxQty:policy?.restoredLegacy?rule.maxQty:policy?.maxQty==null?rule.maxQty:Number(policy.maxQty),
  stagnantDays:STAGNANT_REMINDER_DAYS,source:policy&&!policy.restoredLegacy&&!policy.active?'disabled':rule.source,
  alertStatus:inventoryAlertStatus(currentQty,rule),active:policy?.restoredLegacy?rule.source==='legacy-fallback':policy?.active??rule.source==='legacy-fallback',rowVersion:policy?.rowVersion??0,
  hasPolicy:Boolean(policy&&!policy.restoredLegacy),revision:policyRevisionView(revision),
  unitChanged:Boolean(policy&&(policy.inventoryUnitSnapshot!==inventoryUnit||policy.inventoryUnitSnapshot!==product.inventoryUnit)||revision&&(revision.payload as any)?.inventoryUnitSnapshot!==product.inventoryUnit),
 }
}
