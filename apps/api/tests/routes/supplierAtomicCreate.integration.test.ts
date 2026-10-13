import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { supplierRoutes } from '../../src/routes/suppliers'
const db = new URL(process.env.DATABASE_URL || '')
if(db.hostname !== '127.0.0.1' || db.port !== '15439' || db.pathname !== '/dianjie_mouse_test') throw Error('Dedicated isolated cluster required')
let tenantId: string, userId: string, otherUserId: string
const products: Array<{id:string}> = []; let sequence=0
async function appFor(role='SUPPLY_CHAIN',actor=userId){const app=Fastify();app.decorate('authenticate',async(req:any)=>{req.user={tenantId,userId:actor,role}});await app.register(supplierRoutes,{prefix:'/api/suppliers'});return app}
function payload(){const stamp=++sequence;return {requestKey:`atomic-${stamp}`,supplier:{no:`QA-${stamp}`,name:'原子验收'},items:products.map(p=>({productId:p.id,purchaseUnit:'箱',inventoryUnitsPerPurchaseUnit:10,quotedUnitPrice:30,isPrimary:false}))}}
async function post(app:any,body:any){return app.inject({method:'POST',url:'/api/suppliers/create-with-products',payload:body})}
beforeAll(async()=>{tenantId=(await prisma.tenant.create({data:{slug:`qa-atomic-${Date.now()}`,name:'隔离用例'}})).id;userId=(await prisma.user.create({data:{tenantId,email:'qa@invalid.test',name:'用例',password:'disabled-synthetic',role:'SUPPLY_CHAIN'}})).id;otherUserId=(await prisma.user.create({data:{tenantId,email:'other@invalid.test',name:'另一账号',password:'disabled-synthetic',role:'SUPPLY_CHAIN'}})).id;for(let i=0;i<2;i++)products.push(await prisma.product.create({data:{tenantId,code:`QA-P${i}`,name:`商品${i}`,price:30}}))})
afterAll(async()=>{await prisma.$disconnect()})
describe('DJ-005 PostgreSQL atomic creation',()=>{
 it('空选、重复、缺换算、无权限不创建',async()=>{const app=await appFor(),body=payload();for(const items of [[],[body.items[0],body.items[0]],[{...body.items[0],inventoryUnitsPerPurchaseUnit:0}]])expect((await post(app,{...body,items})).statusCode).toBe(400);expect(await prisma.supplier.count({where:{tenantId,no:body.supplier.no}})).toBe(0);await app.close();const finance=await appFor('FINANCE');expect((await post(finance,body)).statusCode).toBe(403);await finance.close()})
 it('两关系、安全返回、重放、异内容与异账号冲突',async()=>{const app=await appFor(),body=payload(),created=await post(app,body);expect(created.statusCode).toBe(201);expect(created.json()).not.toHaveProperty('bankAccount');const id=created.json().id;expect(await prisma.productUpstreamSource.count({where:{tenantId,supplierId:id}})).toBe(2);expect(await prisma.opLog.count({where:{tenantId,targetId:id,entityType:'Supplier'}})).toBe(1);const replay=await post(app,{...body,items:[...body.items].reverse()});expect(replay.statusCode).toBe(200);expect(replay.json().id).toBe(id);expect((await post(app,{...body,supplier:{...body.supplier,name:'变化'}})).statusCode).toBe(409);const other=await appFor('SUPPLY_CHAIN',otherUserId);expect((await post(other,body)).statusCode).toBe(409);await other.close();await app.close()})
 it('20次并发只有一份档案和成功记录，无Redis仍重放',async()=>{const app=await appFor(),body=payload();const results=await Promise.all(Array.from({length:20},()=>post(app,body)));expect(results.every(r=>[200,201].includes(r.statusCode))).toBe(true);expect(new Set(results.map(r=>r.json().id)).size).toBe(1);expect(await prisma.supplier.count({where:{tenantId,no:body.supplier.no}})).toBe(1);expect(await prisma.supplierCreateRequest.count({where:{tenantId,requestKey:body.requestKey}})).toBe(1);await app.close()})
 it('第二绑定故障整单回滚，恢复后原请求成功',async()=>{const app=await appFor(),body=payload();const target=[...products].sort((a,b)=>a.id.localeCompare(b.id))[1].id;await prisma.$executeRawUnsafe(`CREATE FUNCTION qa_supplier_atomic_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."tenantId" = '${tenantId}' AND NEW."productId" = '${target}' THEN RAISE EXCEPTION 'synthetic binding failure'; END IF; RETURN NEW; END $$`);await prisma.$executeRawUnsafe('CREATE TRIGGER qa_supplier_atomic_failure BEFORE INSERT ON product_upstream_sources FOR EACH ROW EXECUTE FUNCTION qa_supplier_atomic_failure()');const before=await prisma.opLog.count({where:{tenantId}});try{expect((await post(app,body)).statusCode).toBe(500);expect(await prisma.supplier.count({where:{tenantId,no:body.supplier.no}})).toBe(0);expect(await prisma.supplierCreateRequest.count({where:{tenantId,requestKey:body.requestKey}})).toBe(0);expect(await prisma.opLog.count({where:{tenantId}})).toBe(before)}finally{await prisma.$executeRawUnsafe('DROP TRIGGER qa_supplier_atomic_failure ON product_upstream_sources');await prisma.$executeRawUnsafe('DROP FUNCTION qa_supplier_atomic_failure()')}expect((await post(app,body)).statusCode).toBe(201);await app.close()})
 it('不可用商品、停用商品与编号冲突无成功请求残留',async()=>{const app=await appFor(),body=payload();expect((await post(app,{...body,items:[{...body.items[0],productId:'foreign-or-missing'}]})).statusCode).toBe(400);await prisma.product.update({where:{id:products[1].id},data:{status:'DISABLED'}});expect((await post(app,body)).statusCode).toBe(400);await prisma.product.update({where:{id:products[1].id},data:{status:'ENABLED'}});expect((await post(app,body)).statusCode).toBe(201);expect((await post(app,{...body,requestKey:'conflict-other-key'})).statusCode).toBe(409);expect(await prisma.supplierCreateRequest.count({where:{tenantId,requestKey:'conflict-other-key'}})).toBe(0);await app.close()})
 it('自动编号从旧SUP高水位递增，手工高号不重置，建议只读',async()=>{
   await prisma.supplier.create({data:{tenantId,no:'SUP999',name:'旧高号'}})
   const app=await appFor(),before=await prisma.supplierCreateRequest.count({where:{tenantId}})
   const suggestion=await app.inject({method:'GET',url:'/api/suppliers/next-number'})
   expect(suggestion.json().no).toBe('SUP1000')
   expect(await prisma.supplierCreateRequest.count({where:{tenantId}})).toBe(before)
   const body=payload(),automatic=await post(app,{...body,numberMode:'AUTO',supplier:{...body.supplier,no:'SUP1000'}})
   expect(automatic.statusCode).toBe(201);expect(automatic.json().no).toBe('SUP1000')
   const manual=payload();expect((await post(app,{...manual,supplier:{...manual.supplier,no:'SUP1500'}})).json().no).toBe('SUP1500')
   const next=payload();expect((await post(app,{...next,numberMode:'AUTO'})).json().no).toBe('SUP1501')
   await app.close()
 })
 it('20个不同自动请求并发编号各不相同，同请求重放不再占号',async()=>{
   const app=await appFor(),bodies=Array.from({length:20},()=>({...payload(),numberMode:'AUTO'}))
   const results=await Promise.all(bodies.map(body=>post(app,body)))
   expect(results.every(result=>result.statusCode===201)).toBe(true)
   expect(new Set(results.map(result=>result.json().no)).size).toBe(20)
   const replay=await post(app,bodies[0]);expect(replay.statusCode).toBe(200);expect(replay.json().no).toBe(results[0].json().no)
   await app.close()
 })

})
