import {describe,it,expect,vi} from 'vitest'
import {Prisma} from '@dianjie/db'
import {validateNetBasis,confirmInventoryNetCostBasis} from '../../src/services/inventoryNetCostBasis'
import {orderNetCostLedger,netEventsFromLedger,readInventoryNetCosts,readInventoryNetCostHistory} from '../../src/services/inventoryNetCostRead'
import {projectInventoryNetCost} from '../../src/services/inventoryNetCost'
const d=(v:any)=>new Prisma.Decimal(v)
const input:any={tenantId:'t',movementId:'m',userId:'u',requestKey:'r',expectedVersion:0,netValueDelta:100,evidenceRefs:['receipt:RK1'],basisType:'NET_DOCUMENT'}
function row(id:string,q:any,v:any,qa:any,va:any,net:any=null,seq:any=null):any{return {id,tenantId:'t',warehouseId:'w',productId:'p',inventoryUnit:'kg',physicalDelta:d(q),valueDelta:d(v),physicalAfter:d(qa),valueAfter:d(va),recordedAt:new Date('2026-10-28Z'),effectiveAt:new Date('2026-10-28Z'),type:d(q).lt(0)?'ORDER_OUTBOUND':'MANUAL_INBOUND',sourceType:'manual',sourceId:'doc',postingSequence:seq,upstreamReceiptLine:null,reversalOfId:null,netCostBasisConfirmations:net==null?[]:[{tenantId:'t',movementId:id,netValueDelta:d(net),grossValueDeltaSnapshot:d(v),physicalDeltaSnapshot:d(q),inventoryUnitSnapshot:'kg',version:1}]}}
describe('net basis confirmation and posting history',()=>{
 it('validates documented signed cost evidence and refuses zero-cost stock masquerading as known',()=>{
  expect(validateNetBasis(input,{physicalDelta:d(10),valueDelta:d(113)}).net.toString()).toBe('100')
  expect(()=>validateNetBasis({...input,netValueDelta:114},{physicalDelta:d(10),valueDelta:d(113)})).toThrow('符号或金额上限')
  expect(()=>validateNetBasis({...input,netValueDelta:-100},{physicalDelta:d(10),valueDelta:d(113)})).toThrow('符号或金额上限')
  expect(()=>validateNetBasis({...input,netValueDelta:0},{physicalDelta:d(10),valueDelta:d(0)})).toThrow('补齐账面金额')
  expect(()=>validateNetBasis({...input,evidenceRefs:['https://private/path?token=bad']},{physicalDelta:d(10),valueDelta:d(113)})).toThrow('材料引用')
  expect(()=>validateNetBasis({...input,basisType:'ALREADY_NET',netValueDelta:101},{physicalDelta:d(10),valueDelta:d(113)})).toThrow('原账面金额')
 })
 it('recovers a unique legacy balance chain even when same-time random ids order outbound first',()=>{
  const incoming=row('z',10,113,10,113,100),out=row('a',-5,-56.5,5,56.5)
  const sorted=orderNetCostLedger([out,incoming]);expect(sorted.map(m=>m.id)).toEqual(['z','a'])
  expect(projectInventoryNetCost(netEventsFromLedger(sorted)).netAmount?.toString()).toBe('50')
 })
 it('uses a sequence for new mixed-rate receipt and depletion instead of business dates',()=>{
  const rows=[row('c',-5,-54.75,15,164.25,null,3n),row('b',10,106,20,219,100,2n),row('a',10,113,10,113,100,1n)]
  const sorted=orderNetCostLedger(rows);expect(sorted.map(m=>m.id)).toEqual(['a','b','c']);expect(projectInventoryNetCost(netEventsFromLedger(sorted)).netAmount?.toString()).toBe('150')
 })
 it('rejects ambiguous old chains, incomplete sequences and mismatched confirmation snapshots',()=>{
  expect(()=>orderNetCostLedger([row('a',1,1,1,1),row('b',2,2,2,2)])).toThrow('AMBIGUOUS')
  expect(()=>orderNetCostLedger([row('b',2,2,3,3,null,2n)])).toThrow('INCOMPLETE')
  const m=row('a',10,113,10,113,100);m.netCostBasisConfirmations[0].grossValueDeltaSnapshot=d(112)
  expect(()=>netEventsFromLedger([m])).toThrow('does not match')
 })
 it('does not label a residual gross balance on zero physical inventory as known zero net',()=>{
  const p=projectInventoryNetCost([{id:'adjust',quantityDelta:0,valueDelta:113,netValueDelta:100}]);expect(p.status).toBe('PENDING_COST');expect(p.netAmount).toBeNull()
 })
 it('shares complete per-movement net values and only accepts a reconciled current balance',async()=>{
  const rows=[row('z',10,113,10,113,100),row('a',-5,-56.5,5,56.5)]
  const tx:any={warehouseLedgerMovement:{findMany:vi.fn(async()=>rows)}}
  const keys=[{warehouseId:'w',productId:'p',inventoryUnit:'kg'}]
  const history=await readInventoryNetCostHistory(tx,'t',keys);expect(history.get('w/p/kg')?.movements.map(m=>m.netValueDelta?.toString())).toEqual(['100','-50'])
  const valid=await readInventoryNetCosts(tx,'t',[{...keys[0],physicalQty:d(5),inventoryValue:d(56.5)}]);expect(valid.get('w/p/kg')?.netAmount?.toString()).toBe('50')
  const bad=await readInventoryNetCosts(tx,'t',[{...keys[0],physicalQty:d(5),inventoryValue:d(60)}]);expect(bad.size).toBe(0)
 })
 it('appends immutable confirmations, replays identically, rejects changed replay and stale versions',async()=>{
  const confirmations:any[]=[];const movement=row('m',10,113,10,113)
  const tx:any={$queryRaw:async()=>[],user:{findFirst:async()=>({id:'u'})},warehouseLedgerMovement:{findFirst:async()=>movement},warehouseNetCostBasisConfirmation:{findUnique:async({where}:any)=>confirmations.find(x=>x.requestKey===where.tenantId_requestKey.requestKey),findFirst:async()=>confirmations.at(-1),create:async({data}:any)=>{const result={id:'basis'+confirmations.length,...data};confirmations.push(result);return result}}}
  expect((await confirmInventoryNetCostBasis(tx,input)).replayed).toBe(false);expect((await confirmInventoryNetCostBasis(tx,input)).replayed).toBe(true)
  await expect(confirmInventoryNetCostBasis(tx,{...input,note:'changed'})).rejects.toThrow('同一核定请求')
  await expect(confirmInventoryNetCostBasis(tx,{...input,requestKey:'other'})).rejects.toThrow('其他人核定')
  const next=await confirmInventoryNetCostBasis(tx,{...input,requestKey:'second',expectedVersion:1,basisType:'NET_DOCUMENT',taxRate:null,netValueDelta:99})
  expect(next.confirmation.supersedesId).toBe('basis0');expect(confirmations).toHaveLength(2);expect(confirmations[0].netValueDelta.toString()).toBe('100')
 })
 it('restores a costless historical pool only at a verified correction anchor, keeping earlier history unknown',()=>{
  const old=row('old',10,0,10,0,null,null),anchor=row('anchor',0,113,10,113,null,1)
  anchor.type='ADJUSTMENT';anchor.netCostBasisConfirmations=[{tenantId:'t',movementId:'anchor',netValueDelta:null,poolNetValueAfter:d(100),grossValueDeltaSnapshot:d(113),physicalDeltaSnapshot:d(0),physicalAfterSnapshot:d(10),grossValueAfterSnapshot:d(113),postingSequenceSnapshot:1,inventoryUnitSnapshot:'kg',version:1}]
  const out=row('out',-5,-56.5,5,56.5,null,2)
  const r=projectInventoryNetCost(netEventsFromLedger(orderNetCostLedger([out,old,anchor])))
  expect(r.movements[0].netValueAfter).toBeNull();expect(r.movements[1].netValueAfter?.toString()).toBe('100');expect(r.movements[1].netValueDelta).toBeNull();expect(r.netAmount?.toString()).toBe('50');expect(r.status).toBe('KNOWN')
 })
 it('refuses a pool based on zero gross value or a net value above current gross cost',()=>{
  const pool={...input,basisType:'POOL_DOCUMENT',netValueDelta:undefined,taxRate:undefined,poolNetValueAfter:100,expectedPostingSequence:1}
  expect(()=>validateNetBasis(pool,{physicalDelta:d(0),valueDelta:d(0),physicalAfter:d(10),valueAfter:d(0)})).toThrow('已补齐的账面总成本')
  expect(()=>validateNetBasis({...pool,poolNetValueAfter:114},{physicalDelta:d(0),valueDelta:d(113),physicalAfter:d(10),valueAfter:d(113)})).toThrow('已补齐的账面总成本')
 })
 it('rejects stale pool anchors or sequences but replays a previously successful unchanged request',async()=>{
  const m=row('m',0,113,10,113,null,2), confirmations:any[]=[]
  const balance:any={inventoryUnit:'kg',physicalQty:d(10),inventoryValue:d(113),postingSequence:2};let newest=m
  const tx:any={$queryRaw:async()=>[],user:{findFirst:async()=>({id:'u'})},warehouseLedgerMovement:{findFirst:async({where}:any)=>where.postingSequence ? newest : m},warehouseLedgerBalance:{findUnique:async()=>balance},warehouseNetCostBasisConfirmation:{findUnique:async({where}:any)=>confirmations.find(x=>x.requestKey===where.tenantId_requestKey.requestKey),findFirst:async()=>confirmations.at(-1),create:async({data}:any)=>{const c={id:'pool',...data};confirmations.push(c);return c}}}
  const pool:any={...input,basisType:'POOL_DOCUMENT',netValueDelta:undefined,taxRate:undefined,poolNetValueAfter:100,expectedPostingSequence:1}
  await expect(confirmInventoryNetCostBasis(tx,pool)).rejects.toThrow('已有新流水')
  pool.expectedPostingSequence=2;expect((await confirmInventoryNetCostBasis(tx,pool)).replayed).toBe(false)
  balance.postingSequence=3;newest=row('later',1,1,11,114,null,3)
  expect((await confirmInventoryNetCostBasis(tx,pool)).replayed).toBe(true)
  await expect(confirmInventoryNetCostBasis(tx,{...pool,requestKey:'new',expectedVersion:1})).rejects.toThrow('已有新流水')
 })

 it('uses a documented latest pool checkpoint when old history has an ambiguous or missing cost chain',async()=>{
  const a=row('a',1,1,1,1),b=row('b',2,2,2,2),anchor=row('anchor',0,110,10,113,null,1)
  anchor.type='ADJUSTMENT';anchor.netCostBasisConfirmations=[{tenantId:'t',movementId:'anchor',netValueDelta:null,poolNetValueAfter:d(100),grossValueDeltaSnapshot:d(110),physicalDeltaSnapshot:d(0),physicalAfterSnapshot:d(10),grossValueAfterSnapshot:d(113),postingSequenceSnapshot:1,inventoryUnitSnapshot:'kg',version:1}]
  const out=row('out',-5,-56.5,5,56.5,null,2),tx:any={warehouseLedgerMovement:{findMany:async()=>[out,a,b,anchor]}}
  const keys=[{warehouseId:'w',productId:'p',inventoryUnit:'kg'}],history=await readInventoryNetCostHistory(tx,'t',keys),h=history.get('w/p/kg')!
  expect(h.status).toBe('KNOWN');expect(h.reason).toContain('UNKNOWN_BEFORE');expect(h.movements.find(m=>m.id==='a')?.netValueAfter).toBeNull();expect(h.movements.find(m=>m.id==='anchor')?.netValueDelta).toBeNull();expect(h.netAmount?.toString()).toBe('50')
  expect((await readInventoryNetCosts(tx,'t',[{...keys[0],physicalQty:d(5),inventoryValue:d(56.5)}])).get('w/p/kg')?.netAmount?.toString()).toBe('50')
 })

})

it('refuses the removed tax-rate confirmation mode',()=>{expect(()=>validateNetBasis({...input,basisType:'TAX_RATE',taxRate:0.13},{physicalDelta:d(10),valueDelta:d(113)})).toThrow('已停用')})
