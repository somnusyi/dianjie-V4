import {contractCopyPayload,type ContractCopyOriginal,type ContractCopySource} from './upstream-contract-copy'
type CopyStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>
export type StoredCopyOriginal=ContractCopyOriginal&{version:number;supplier:{id:string;no:string;name:string}}
export type ContractCopyAttempt={key:string;body:string;original:StoredCopyOriginal}
export type ContractCopyRecovery={status:'empty'}|{status:'blocked';message:string}|{status:'pending';attempt:ContractCopyAttempt}
export function contractCopyScope(tenantId:unknown,userId:unknown):string|null{
 if(typeof tenantId!=='string'||typeof userId!=='string'||!tenantId.trim()||!userId.trim())return null
 return `dj:contract-copy:${encodeURIComponent(tenantId)}:${encodeURIComponent(userId)}`
}
export function copyRecoverySources(original:StoredCopyOriginal):ContractCopySource[]{
 return original.lines.map(line=>({id:line.upstreamSourceId||'',supplierId:original.supplierId,purchaseUnit:line.purchaseUnit,inventoryUnitsPerPurchaseUnit:line.inventoryUnitsPerPurchaseUnit,minOrderQty:line.minOrderQty,leadTimeDays:line.leadTimeDays,product:{id:line.productId,inventoryUnit:line.inventoryUnit,unit:line.inventoryUnit}}))
}
export function readContractCopyAttempt(storage:CopyStorage,scope:string):ContractCopyRecovery{
 try{
  const raw=storage.getItem(scope)
  if(raw===null)return {status:'empty'}
  if(raw.length>2*1024*1024)throw new Error('oversize')
  const value=JSON.parse(raw)
  if(value?.schema!==1||value.scope!==scope||typeof value.key!=='string'||value.key.length<8||value.key.length>160||typeof value.body!=='string'||value.body.length>1024*1024)throw new Error('invalid')
  const original=value.original as StoredCopyOriginal,payload=JSON.parse(value.body)
  if(!original||['id','supplierId','contractNo','title','startsAt'].some(key=>typeof (original as unknown as Record<string,unknown>)[key]!=='string'||!(original as unknown as Record<string,string>)[key].trim()))throw new Error('missing original identity')
  if(!original||!Number.isInteger(original.version)||!original.supplier||original.supplier.id!==original.supplierId||typeof original.supplier.no!=='string'||typeof original.supplier.name!=='string'||!Array.isArray(original.lines)||original.lines.length>500||!Array.isArray(payload.lines))throw new Error('invalid original')
  const prices=Object.fromEntries(payload.lines.map((line:{upstreamSourceId:string;unitPrice:number})=>[line.upstreamSourceId,String(line.unitPrice)]))
  if(JSON.stringify(contractCopyPayload(original,copyRecoverySources(original),prices,value.key))!==value.body)throw new Error('body mismatch')
  return {status:'pending',attempt:{key:value.key,body:value.body,original}}
 }catch{return {status:'blocked',message:'本浏览器的合同创建待核对记录无法读取，请先核对已有合同，勿重新创建'}}
}
/** Must complete and verify BEFORE POST. A storage failure must never create an unrecoverable request. */
export function persistContractCopyAttempt(storage:CopyStorage,scope:string,attempt:ContractCopyAttempt):void{
 const previous=readContractCopyAttempt(storage,scope)
 if(previous.status==='blocked'||previous.status==='pending'&&(previous.attempt.key!==attempt.key||previous.attempt.body!==attempt.body))throw new Error('请先核对原合同创建请求，不能覆盖待核对记录')
 const serialized=JSON.stringify({schema:1,scope,...attempt})
 if(serialized.length>2*1024*1024)throw new Error('合同恢复记录过大，未发送创建请求')
 try{
  storage.setItem(scope,serialized)
  const saved=readContractCopyAttempt(storage,scope)
  if(saved.status!=='pending'||saved.attempt.key!==attempt.key||saved.attempt.body!==attempt.body)throw new Error('verify')
 }catch{throw new Error('浏览器未能保存合同恢复记录，未发送创建请求；请允许本页浏览器存储后重试')}
}
export function clearContractCopyAttempt(storage:CopyStorage,scope:string,attempt:Pick<ContractCopyAttempt,'key'|'body'>):void{
 try{const current=readContractCopyAttempt(storage,scope);if(current.status==='pending'&&current.attempt.key===attempt.key&&current.attempt.body===attempt.body)storage.removeItem(scope)}catch{}
}
