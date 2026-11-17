import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import {storeTransferRoutes} from '../src/routes/storeTransfers'
import {beforeEach,afterEach,afterAll,it,expect,vi} from 'vitest'
import {Prisma,prisma} from '@dianjie/db'
import {randomUUID} from 'node:crypto'
import {postStoreTransfer, transferPosition} from '../src/services/storeTransferPosting'
import {estimatedStoreInventory} from '../src/services/storeInventory'
import {revalueStoreConsumptionCosts} from '../src/services/inventoryCosting'
import {loadInventoryReport,reportQuerySchema} from '../src/services/inventoryReports'
const url=new URL(process.env.DATABASE_URL!);if(url.hostname!=='127.0.0.1'||url.port!=='15449'||url.pathname!=='/dianjie_four_gap_test')throw new Error('Dedicated synthetic database required')
const db:any=prisma;let tenantId='',supplierId='',productId='',storeA='',storeB='',actorId=''
async function txpost(id:string,action:any,key:string,items?:any[]){for(let a=0;a<4;a++){try{return await db.$transaction((tx:any)=>postStoreTransfer(tx,{tenantId,transferId:id,actorId,action,requestKey:key,items,note:'合成验收'}),{isolationLevel:'Serializable'})}catch(e:any){if(e.code==='P2034'&&a<3)continue;throw e}}}
async function transfer(quantity=10){return db.storeTransfer.create({data:{tenantId,no:'DB-'+randomUUID(),fromStoreId:storeA,toStoreId:storeB,transferDate:new Date('2026-10-28Z'),createdById:actorId,requestKey:randomUUID(),items:{create:[{productId,name:'商品',code:'P',unit:'kg',quantity,cost:0,settlement:0,outAmount:0,inAmount:0}]}},include:{items:true}})}
beforeEach(async()=>{tenantId='';tenantId=(await db.tenant.create({data:{name:'临时调拨验收',slug:'p02-'+randomUUID()}})).id;if(!await db.warehouse.findFirst({where:{tenantId,isDefault:true}}))await db.warehouse.create({data:{tenantId,code:'W',name:'默认仓',isDefault:true}});supplierId=(await db.supplier.create({data:{tenantId,no:'S',name:'供应商'}})).id;productId=(await db.product.create({data:{tenantId,supplierId,code:'P',name:'商品',unit:'kg',price:100,inventoryUnit:'kg',purchaseUnit:'kg',orderUnit:'kg',costUnit:'kg',inventoryUnitsPerOrderUnit:1,inventoryUnitsPerPurchaseUnit:1,inventoryUnitsPerCostUnit:1,unitConversionStatus:'VERIFIED'}})).id;actorId=(await db.user.create({data:{tenantId,email:'p02-'+randomUUID()+'@local.invalid',name:'供应链',password:'synthetic-not-login',role:'SUPPLY_CHAIN'}})).id;storeA=(await db.store.create({data:{tenantId,no:'A',name:'甲店'}})).id;storeB=(await db.store.create({data:{tenantId,no:'B',name:'乙店'}})).id;for(const [storeId,quantity]of[[storeA,20],[storeB,5]]as const)await db.inventorySnapshot.create({data:{tenantId,storeId,snapshotDate:new Date('2026-01-01Z'),totalValue:quantity*100,itemCount:1,nonzeroCount:1,zeroCount:0,matchedCount:1,items:{create:[{productId,rawName:'商品',unit:'kg',quantity,unitPrice:100,amount:quantity*100,normalizedQuantity:quantity,normalizedUnit:'kg',normalizationStatus:'EXACT',sortOrder:0}]}}})})
afterEach(async()=>{vi.useRealTimers();if(tenantId){await db.stockConsumption.deleteMany({where:{tenantId}});await db.storeTransferMovement.deleteMany({where:{tenantId}});await db.storeTransferItem.deleteMany({where:{transfer:{tenantId}}});await db.storeTransfer.deleteMany({where:{tenantId}});await db.inventorySnapshot.deleteMany({where:{tenantId}});await db.product.deleteMany({where:{tenantId}});await db.store.deleteMany({where:{tenantId}});await db.user.deleteMany({where:{tenantId}});await db.supplier.deleteMany({where:{tenantId}});await db.warehouse.deleteMany({where:{tenantId}});await db.tenant.delete({where:{id:tenantId}})}await db.$disconnect()})
it('posts source-store cost, exact actual receipt and return, with idempotent replay in PostgreSQL',async()=>{const tr=await transfer();await txpost(tr.id,'SHIP','ship');await txpost(tr.id,'RECEIVE','receive',[{itemId:tr.items[0].id,quantity:9}]);await txpost(tr.id,'RETURN','return',[{itemId:tr.items[0].id,quantity:1}]);await txpost(tr.id,'RETURN','return',[{itemId:tr.items[0].id,quantity:1}]);expect(await db.storeTransferMovement.count({where:{tenantId,transferId:tr.id}})).toBe(3);const [a,b]=await db.$transaction(async(tx:any)=>[await transferPosition(tx,tenantId,storeA,productId),await transferPosition(tx,tenantId,storeB,productId)]);expect(a.quantity.toString()).toBe('11');expect(a.value.toString()).toBe('1100');expect(b.quantity.toString()).toBe('14');expect(b.value.toString()).toBe('1400')})
it('rolls back status, cumulative quantity and all ledger rows when an operation fails midway',async()=>{const tr=await transfer(1);const before=await db.storeTransferMovement.count({where:{tenantId}});await expect(db.$transaction(async(tx:any)=>{await postStoreTransfer(tx,{tenantId,transferId:tr.id,actorId,action:'SHIP',requestKey:'rollback'});throw new Error('injected rollback')})).rejects.toThrow('injected rollback');expect((await db.storeTransfer.findUnique({where:{id:tr.id}})).status).toBe('PENDING');expect(await db.storeTransferMovement.count({where:{tenantId}})).toBe(before)})
it('serializes concurrent different transfers and prevents overselling remaining source inventory',async()=>{const [x,y]=await Promise.all([transfer(12),transfer(12)]);const results=await Promise.allSettled([txpost(x.id,'SHIP','x'),txpost(y.id,'SHIP','y')]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);const a=await db.$transaction((tx:any)=>transferPosition(tx,tenantId,storeA,productId));expect(a.quantity.toString()).toBe('8');expect(await db.storeTransferMovement.count({where:{tenantId,transferId:{in:[x.id,y.id]}}})).toBe(1)})

it('keeps already posted same-day consumption unavailable for source shipment',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-20T10:00:00Z'))
 await db.stockConsumption.create({data:{tenantId,storeId:storeA,productId,date:new Date('2026-10-20Z'),quantity:5,inventoryQuantity:5,unitSnapshot:'kg',inventoryUnitSnapshot:'kg',unitCostSnapshot:100,costAmountSnapshot:500,createdById:actorId}})
 const tr=await transfer(16)
 await expect(txpost(tr.id,'SHIP','same-day-overstock')).rejects.toThrow('可用库存不足')
 expect((await db.storeTransfer.findUniqueOrThrow({where:{id:tr.id}})).status).toBe('PENDING')
 expect(await db.storeTransferMovement.count({where:{tenantId,transferId:tr.id}})).toBe(0)
})

it('routes enforce role/tenant scope, preserve create replay after frozen costs, and process actual receipt/damage',async()=>{
 const app=Fastify();await app.register(jwt,{secret:'p02-isolated-synthetic-jwt-secret'})
 app.decorate('authenticate',async(req:any)=>{await req.jwtVerify()});await app.register(storeTransferRoutes,{prefix:'/api/store-transfers'});await app.ready()
 const headers=(role='SUPPLY_CHAIN',tenant=tenantId)=>({authorization:'Bearer '+app.jwt.sign({userId:actorId,tenantId:tenant,role})})
 const key=randomUUID();const payload={fromStoreId:storeA,toStoreId:storeB,transferDate:'2026-10-28',requestKey:key,items:[{productId,quantity:1,cost:0,settlement:0}]}
 try {
 const denied=await app.inject({method:'POST',url:'/api/store-transfers',headers:headers('FINANCE'),payload});expect(denied.statusCode).toBe(403)
 const created=await app.inject({method:'POST',url:'/api/store-transfers',headers:headers(),payload});expect(created.statusCode,created.body).toBe(201);const row=created.json()
 const foreign=await app.inject({method:'PATCH',url:`/api/store-transfers/${row.id}/status`,headers:headers('SUPPLY_CHAIN','foreign-'+randomUUID()),payload:{status:'SHIPPED'}});expect(foreign.statusCode,foreign.body).toBe(404)
 const ship=await app.inject({method:'PATCH',url:`/api/store-transfers/${row.id}/status`,headers:headers(),payload:{status:'SHIPPED'}});expect(ship.statusCode,ship.body).toBe(200)
 const replay=await app.inject({method:'POST',url:'/api/store-transfers',headers:headers(),payload});expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().id).toBe(row.id)
 const itemId=row.items[0].id
 const receive=await app.inject({method:'POST',url:`/api/store-transfers/${row.id}/receive`,headers:headers(),payload:{requestKey:randomUUID(),items:[{itemId,quantity:0.5}]}});expect(receive.statusCode,receive.body).toBe(200);expect(receive.json().status).toBe('PARTIALLY_RECEIVED')
 const overshoot=await app.inject({method:'POST',url:`/api/store-transfers/${row.id}/resolve-difference`,headers:headers(),payload:{requestKey:randomUUID(),action:'RETURN',items:[{itemId,quantity:1}]}});expect(overshoot.statusCode,overshoot.body).toBe(422)
 const damage=await app.inject({method:'POST',url:`/api/store-transfers/${row.id}/resolve-difference`,headers:headers(),payload:{requestKey:randomUUID(),action:'DAMAGE',items:[{itemId,quantity:0.5}],note:'验收破损'}});expect(damage.statusCode,damage.body).toBe(200);expect(damage.json().status).toBe('RECEIVED')
 expect(await db.storeTransferMovement.count({where:{tenantId,transferId:row.id}})).toBe(3)
 const [a,b]=await db.$transaction(async(tx:any)=>[await transferPosition(tx,tenantId,storeA,productId),await transferPosition(tx,tenantId,storeB,productId)])
 expect(a.quantity.toString()).toBe('19');expect(a.value.toString()).toBe('1900')
 expect(b.quantity.toString()).toBe('5.5');expect(b.value.toString()).toBe('550')
 const loss=await db.storeTransferMovement.findFirstOrThrow({where:{tenantId,transferId:row.id,kind:'DAMAGE'}})
 expect(loss.quantity.toString()).toBe('0.5');expect(loss.amount.toString()).toBe('50');expect(loss.quantityDelta.toString()).toBe('0');expect(loss.valueDelta.toString()).toBe('0')
 const closed=await db.storeTransferItem.findUniqueOrThrow({where:{id:itemId}})
 expect(closed.outAmount.toString()).toBe('100');expect(closed.inAmount.toString()).toBe('50');expect(closed.damagedQuantity.toString()).toBe('0.5')

 } finally {await app.close()}
})

afterAll(async()=>{await db.$disconnect()})

it.each(['MISSING_SNAPSHOT','ZERO_COST','PENDING_UNIT']as const)('rejects unsafe store basis %s in PostgreSQL without posting or changing the draft',async(kind)=>{
 const snapshot=await db.inventorySnapshot.findFirstOrThrow({where:{tenantId,storeId:storeA},include:{items:true}})
 if(kind==='MISSING_SNAPSHOT')await db.inventorySnapshot.delete({where:{id:snapshot.id}})
 if(kind==='ZERO_COST')await db.inventorySnapshotItem.update({where:{id:snapshot.items[0].id},data:{amount:0,unitPrice:0}})
 if(kind==='PENDING_UNIT')await db.inventorySnapshotItem.update({where:{id:snapshot.items[0].id},data:{normalizationStatus:'PENDING',normalizedQuantity:null}})
 const tr=await transfer(1)
 await expect(txpost(tr.id,'SHIP','bad-basis')).rejects.toThrow(kind==='MISSING_SNAPSHOT'?'可信盘点':kind==='ZERO_COST'?'可靠账面成本':'单位待核定')
 expect(await db.storeTransferMovement.count({where:{tenantId,transferId:tr.id}})).toBe(0)
 const untouched=await db.storeTransfer.findUniqueOrThrow({where:{id:tr.id},include:{items:true}})
 expect(untouched.status).toBe('PENDING');expect(untouched.items[0].cost.toString()).toBe('0');expect(untouched.items[0].receivedQuantity.toString()).toBe('0')
})
it('uses the new closed-day count as baseline without deducting the historical shipment again, while later receipt and return still post',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-10T10:00:00Z'))
 const tr=await transfer(10);await txpost(tr.id,'SHIP','before-count')
 const originalSnapshot=await db.inventorySnapshot.findFirstOrThrow({where:{tenantId,storeId:storeA},include:{items:true}})
 for(const [storeId,quantity]of [[storeA,9],[storeB,5]]as const)await db.inventorySnapshot.create({data:{tenantId,storeId,snapshotDate:new Date('2026-10-10Z'),sourceFilename:'闭店盘点.xlsx',totalValue:quantity*100,itemCount:1,nonzeroCount:1,zeroCount:0,matchedCount:1,items:{create:{productId,rawName:'商品',unit:'kg',quantity,unitPrice:100,amount:quantity*100,normalizedQuantity:quantity,normalizedUnit:'kg',normalizationStatus:'EXACT',sortOrder:0}}}})
 vi.setSystemTime(new Date('2026-10-11T10:00:00Z'))
 let a=await db.$transaction((tx:any)=>transferPosition(tx,tenantId,storeA,productId));expect(a.quantity.toString()).toBe('9');expect(a.value.toString()).toBe('900')
 await txpost(tr.id,'RECEIVE','after-count-receive',[{itemId:tr.items[0].id,quantity:9}]);await txpost(tr.id,'RETURN','after-count-return',[{itemId:tr.items[0].id,quantity:1}])
 const positions=await db.$transaction(async(tx:any)=>[await transferPosition(tx,tenantId,storeA,productId),await transferPosition(tx,tenantId,storeB,productId)])
 expect(positions.map((p:any)=>[p.quantity.toString(),p.value.toString()])).toEqual([['10','1000'],['14','1400']])
 const estimates=await Promise.all([estimatedStoreInventory(tenantId,storeA,'2026-10-11'),estimatedStoreInventory(tenantId,storeB,'2026-10-11')])
 expect(estimates[0].summary.totalValue).toBe(1000);expect(estimates[1].summary.totalValue).toBe(1400)
 expect(estimates[0].items.find((i:any)=>i.id===productId).stock).toBe(10);expect(estimates[1].items.find((i:any)=>i.id===productId).stock).toBe(14)
 expect((await db.inventorySnapshot.findUniqueOrThrow({where:{id:originalSnapshot.id},include:{items:true}})).items[0].amount.toString()).toBe('2000')
 expect(await db.storeTransferMovement.count({where:{tenantId,transferId:tr.id,kind:'SHIP'}})).toBe(1)
 expect((await db.storeTransfer.findUniqueOrThrow({where:{id:tr.id}})).status).toBe('RECEIVED')
})
it('does not auto-post a historical shipped document without shipment evidence',async()=>{
 const tr=await transfer(1);await db.storeTransfer.update({where:{id:tr.id},data:{status:'SHIPPED',shippedAt:new Date('2026-01-02Z')}})
 await expect(txpost(tr.id,'RECEIVE','legacy-receive',[{itemId:tr.items[0].id,quantity:1}])).rejects.toThrow('历史调拨')
 await expect(txpost(tr.id,'SHIP','legacy-ship')).rejects.toThrow('调拨状态已变化')
 expect(await db.storeTransferMovement.count({where:{tenantId,transferId:tr.id}})).toBe(0)
 const a=await db.$transaction((tx:any)=>transferPosition(tx,tenantId,storeA,productId));expect(a.quantity.toString()).toBe('20');expect(a.value.toString()).toBe('2000')
 expect((await db.storeTransfer.findUniqueOrThrow({where:{id:tr.id}})).status).toBe('SHIPPED')
})
it('allocates the exact last transfer amount over receive, return and transit damage on PostgreSQL',async()=>{
 const snapshot=await db.inventorySnapshot.findFirstOrThrow({where:{tenantId,storeId:storeA},include:{items:true}})
 await db.inventorySnapshotItem.update({where:{id:snapshot.items[0].id},data:{quantity:3,normalizedQuantity:3,unitPrice:'0.333333',amount:1}})
 const tr=await transfer(3);await txpost(tr.id,'SHIP','ship')
 for(const [action,key]of [['RECEIVE','r1'],['RETURN','r2'],['DAMAGE','r3']]as const)await txpost(tr.id,action,key,[{itemId:tr.items[0].id,quantity:1}])
 await txpost(tr.id,'DAMAGE','r3',[{itemId:tr.items[0].id,quantity:1}])
 const movements=await db.storeTransferMovement.findMany({where:{tenantId,transferId:tr.id},orderBy:{createdAt:'asc'}})
 expect(movements.map((m:any)=>m.amount.toString())).toEqual(['1','0.3333','0.3333','0.3334'])
 expect(movements[3].quantityDelta.toString()).toBe('0');expect(movements[3].valueDelta.toString()).toBe('0')
 const [a,b]=await db.$transaction(async(tx:any)=>[await transferPosition(tx,tenantId,storeA,productId),await transferPosition(tx,tenantId,storeB,productId)])
 expect(a.quantity.toString()).toBe('1');expect(a.value.toString()).toBe('0.3333');expect(b.quantity.toString()).toBe('6');expect(b.value.toString()).toBe('500.3333')
 const line=await db.storeTransferItem.findUniqueOrThrow({where:{id:tr.items[0].id}});expect(line.outAmount.toString()).toBe('1');expect(line.inAmount.toString()).toBe('0.3333')
})
it('rolls back partial actual receipt counters, amount, destination position and status when the transaction fails',async()=>{
 const tr=await transfer(1);await txpost(tr.id,'SHIP','ship')
 await expect(db.$transaction(async(tx:any)=>{await postStoreTransfer(tx,{tenantId,transferId:tr.id,actorId,action:'RECEIVE',requestKey:'receive-failed',items:[{itemId:tr.items[0].id,quantity:0.5}],note:'事务回滚验证'});throw new Error('injected receive rollback')})).rejects.toThrow('injected receive rollback')
 const row=await db.storeTransfer.findUniqueOrThrow({where:{id:tr.id},include:{items:true}});expect(row.status).toBe('SHIPPED');expect(row.items[0].receivedQuantity.toString()).toBe('0');expect(row.items[0].inAmount.toString()).toBe('0')
 expect(await db.storeTransferMovement.count({where:{tenantId,transferId:tr.id}})).toBe(1)
 const b=await db.$transaction((tx:any)=>transferPosition(tx,tenantId,storeB,productId));expect(b.quantity.toString()).toBe('5');expect(b.value.toString()).toBe('500')
})


it('uses received quantities for transfer report averages, including partial receipt, damage and mixed completed quantities',async()=>{
 const tr=await transfer(3)
 await txpost(tr.id,'SHIP','average-ship')
 const query=reportQuerySchema.parse({start:'2026-10-28',end:'2026-10-28'})
 const report=()=>db.$transaction((tx:any)=>loadInventoryReport(tx,tenantId,'transfer-summary',query))
 let result=await report()
 expect(result.rows[0]).toMatchObject({transferQty:3,receivedQty:0,inAmount:0,inPrice:null})
 await txpost(tr.id,'RECEIVE','average-receive',[{itemId:tr.items[0].id,quantity:1}])
 result=await report()
 expect(result.rows[0]).toMatchObject({transferQty:3,receivedQty:1,outAmount:300,inAmount:100,inPrice:100})
 await txpost(tr.id,'RETURN','average-return',[{itemId:tr.items[0].id,quantity:1}])
 await txpost(tr.id,'DAMAGE','average-damage',[{itemId:tr.items[0].id,quantity:1}])
 const second=await transfer(2)
 await txpost(second.id,'SHIP','average-second-ship')
 await txpost(second.id,'RECEIVE','average-second-receive',[{itemId:second.items[0].id,quantity:2}])
 result=await report()
 expect(result.rows[0]).toMatchObject({transferQty:5,receivedQty:3,outAmount:500,inAmount:300,inPrice:100})
})


it('revalues consumption using actual partial transfer receipt, preserves frozen movements and replays without drift',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-20T10:00:00Z'))
 const opening=await db.inventorySnapshot.findFirstOrThrow({where:{tenantId,storeId:storeB},include:{items:true}})
 await db.inventorySnapshotItem.update({where:{id:opening.items[0].id},data:{amount:1000,unitPrice:200}})
 const tr=await transfer(5)
 await txpost(tr.id,'SHIP','cost-ship')
 await txpost(tr.id,'RECEIVE','cost-receive',[{itemId:tr.items[0].id,quantity:3}])
 await txpost(tr.id,'RETURN','cost-return',[{itemId:tr.items[0].id,quantity:1}])
 await txpost(tr.id,'DAMAGE','cost-damage',[{itemId:tr.items[0].id,quantity:1}])
 const consumption=await db.stockConsumption.create({data:{tenantId,storeId:storeB,productId,date:new Date('2026-10-21Z'),quantity:2,inventoryQuantity:2,unitSnapshot:'kg',inventoryUnitSnapshot:'kg',unitCostSnapshot:999,costAmountSnapshot:1998,createdById:actorId}})
 const voided=await db.stockConsumption.create({data:{tenantId,storeId:storeB,productId,date:new Date('2026-10-21Z'),quantity:1,inventoryQuantity:1,unitCostSnapshot:999,costAmountSnapshot:999,createdById:actorId,voidedAt:new Date()}})
 const before=await db.storeTransferMovement.findMany({where:{tenantId},orderBy:{id:'asc'}})
 // Destination: 5kg/1000 + actually received 3kg/300 = 8kg/1300.
 // Returned and damaged goods must not enter its consumption denominator.
 for(let repeat=0;repeat<2;repeat++){
  expect(await revalueStoreConsumptionCosts(tenantId,storeB)).toMatchObject({status:'OK',updated:1,totalCost:325})
  const row=await db.stockConsumption.findUniqueOrThrow({where:{id:consumption.id}})
  expect(row.unitCostSnapshot.toString()).toBe('162.5');expect(row.costAmountSnapshot.toString()).toBe('325')
 }
 expect((await db.stockConsumption.findUniqueOrThrow({where:{id:voided.id}})).costAmountSnapshot.toString()).toBe('999')
 expect(await db.storeTransferMovement.findMany({where:{tenantId},orderBy:{id:'asc'}})).toEqual(before)
 const estimates=await estimatedStoreInventory(tenantId,storeB,'2026-10-21')
 expect(estimates.items.find((i:any)=>i.id===productId).stock).toBe(6)
 expect(estimates.summary.totalValue).toBe(975)
})

it('revalues same-day closing consumption after transfer receipt through the HTTP route',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-20T10:00:00Z'))
 const opening=await db.inventorySnapshot.findFirstOrThrow({where:{tenantId,storeId:storeB},include:{items:true}})
 await db.inventorySnapshotItem.update({where:{id:opening.items[0].id},data:{amount:1000,unitPrice:200}})
 const consumption=await db.stockConsumption.create({data:{tenantId,storeId:storeB,productId,date:new Date('2026-10-20Z'),quantity:2,inventoryQuantity:2,unitSnapshot:'kg',inventoryUnitSnapshot:'kg',unitCostSnapshot:200,costAmountSnapshot:400,createdById:actorId}})
 const tr=await transfer(3)
 const app=Fastify();await app.register(jwt,{secret:'p02-isolated-synthetic-jwt-secret'})
 app.decorate('authenticate',async(req:any)=>{await req.jwtVerify()});await app.register(storeTransferRoutes,{prefix:'/api/store-transfers'});await app.ready()
 const headers={authorization:'Bearer '+app.jwt.sign({userId:actorId,tenantId,role:'SUPPLY_CHAIN'})}
 try {
  const ship=await app.inject({method:'PATCH',url:`/api/store-transfers/${tr.id}/status`,headers,payload:{status:'SHIPPED'}})
  expect(ship.statusCode,ship.body).toBe(200)
  const receipt=await app.inject({method:'POST',url:`/api/store-transfers/${tr.id}/receive`,headers,payload:{requestKey:randomUUID(),items:[{itemId:tr.items[0].id,quantity:3}]}})
  expect(receipt.statusCode,receipt.body).toBe(200)
  const saved=await db.stockConsumption.findUniqueOrThrow({where:{id:consumption.id}})
  expect(saved.unitCostSnapshot.toString()).toBe('162.5')
  expect(saved.costAmountSnapshot.toString()).toBe('325')
  const estimated=await estimatedStoreInventory(tenantId,storeB,'2026-10-20')
  expect(estimated.items.find((item:any)=>item.id===productId).stock).toBe(6)
  expect(estimated.summary.totalValue).toBe(975)
 } finally {await app.close()}
})

it('keeps a Shanghai next-day transfer out of the prior closing consumption and inventory',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-20T18:00:00Z'))
 const opening=await db.inventorySnapshot.findFirstOrThrow({where:{tenantId,storeId:storeB},include:{items:true}})
 await db.inventorySnapshotItem.update({where:{id:opening.items[0].id},data:{amount:1000,unitPrice:200}})
 const consumption=await db.stockConsumption.create({data:{tenantId,storeId:storeB,productId,date:new Date('2026-10-20Z'),quantity:2,inventoryQuantity:2,unitSnapshot:'kg',inventoryUnitSnapshot:'kg',unitCostSnapshot:200,costAmountSnapshot:400,createdById:actorId}})
 const tr=await transfer(3)
 const app=Fastify();await app.register(jwt,{secret:'p02-isolated-synthetic-jwt-secret'})
 app.decorate('authenticate',async(req:any)=>{await req.jwtVerify()});await app.register(storeTransferRoutes,{prefix:'/api/store-transfers'});await app.ready()
 const headers={authorization:'Bearer '+app.jwt.sign({userId:actorId,tenantId,role:'SUPPLY_CHAIN'})}
 try {
  expect((await app.inject({method:'PATCH',url:`/api/store-transfers/${tr.id}/status`,headers,payload:{status:'SHIPPED'}})).statusCode).toBe(200)
  expect((await app.inject({method:'POST',url:`/api/store-transfers/${tr.id}/receive`,headers,payload:{requestKey:randomUUID(),items:[{itemId:tr.items[0].id,quantity:3}]}})).statusCode).toBe(200)
  const saved=await db.stockConsumption.findUniqueOrThrow({where:{id:consumption.id}})
  expect(saved.unitCostSnapshot.toString()).toBe('200')
  expect(saved.costAmountSnapshot.toString()).toBe('400')
  const prior=await estimatedStoreInventory(tenantId,storeB,'2026-10-20')
  expect(prior.items.find((item:any)=>item.id===productId).stock).toBe(3)
  expect(prior.summary.totalValue).toBe(600)
  const next=await estimatedStoreInventory(tenantId,storeB,'2026-10-21')
  expect(next.items.find((item:any)=>item.id===productId).stock).toBe(6)
  expect(next.summary.totalValue).toBe(900)
 } finally {await app.close()}
})

it.each(['2026-10-20T10:00:00Z','2026-10-22T10:00:00Z'])('revalues only consumption after the latest count without replaying transfer receipts at %s',async(shippedAt)=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(shippedAt))
 const tr=await transfer(5);await txpost(tr.id,'SHIP','count-ship')
 await txpost(tr.id,'RECEIVE','count-receive',[{itemId:tr.items[0].id,quantity:5}])
 const old=await db.stockConsumption.create({data:{tenantId,storeId:storeB,productId,date:new Date('2026-10-21Z'),quantity:1,inventoryQuantity:1,unitCostSnapshot:100,costAmountSnapshot:100,createdById:actorId}})
 await db.inventorySnapshot.create({data:{tenantId,storeId:storeB,snapshotDate:new Date('2026-10-22Z'),totalValue:350,itemCount:1,nonzeroCount:1,zeroCount:0,matchedCount:1,items:{create:[{productId,rawName:'商品',unit:'kg',quantity:7,unitPrice:50,amount:350,normalizedQuantity:7,normalizedUnit:'kg',normalizationStatus:'EXACT',sortOrder:0}]}}})
 const current=await db.stockConsumption.create({data:{tenantId,storeId:storeB,productId,date:new Date('2026-10-23Z'),quantity:2,inventoryQuantity:2,createdById:actorId}})
 expect(await revalueStoreConsumptionCosts(tenantId,storeB)).toMatchObject({status:'OK',updated:1,totalCost:100})
 expect((await db.stockConsumption.findUniqueOrThrow({where:{id:old.id}})).costAmountSnapshot.toString()).toBe('100')
 const row=await db.stockConsumption.findUniqueOrThrow({where:{id:current.id}})
 expect(row.unitCostSnapshot.toString()).toBe('50');expect(row.costAmountSnapshot.toString()).toBe('100')
 const estimate=await estimatedStoreInventory(tenantId,storeB,'2026-10-23')
 expect(estimate.items.find((i:any)=>i.id===productId).stock).toBe(5);expect(estimate.summary.totalValue).toBe(250)
})
