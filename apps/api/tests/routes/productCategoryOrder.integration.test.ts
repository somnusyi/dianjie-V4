import Fastify from 'fastify'
import {beforeAll,afterAll,it,expect} from 'vitest'
import {prisma} from '@dianjie/db'
import {productRoutes} from '../../src/routes/products'
const db=new URL(process.env.DATABASE_URL||'postgresql://invalid')
if(db.hostname!=='127.0.0.1'||db.port!=='15439'||db.pathname!=='/dianjie_mouse_test')throw Error('Requires verified isolated mouse database')
const app=Fastify();let tenantId='',supplierId='',userId='',failAudit=false
const stamp=Date.now().toString()
prisma.$use(async(params,next)=>{if(failAudit&&params.model==='OpLog'&&params.action==='create'&&params.args?.data?.targetId===supplierId)throw Error('Synthetic audit failure: rollback required');return next(params)})
beforeAll(async()=>{
 const tenant=await prisma.tenant.create({data:{name:'分类事务隔离测试',slug:`qa-category-${stamp}`}});tenantId=tenant.id
 const supplier=await prisma.supplier.create({data:{tenantId,no:`QA-CAT-${stamp}`,name:'分类事务测试供应商'}});supplierId=supplier.id
 userId=(await prisma.user.create({data:{tenantId,email:`category-${stamp}@mouse.invalid`,password:'synthetic-non-login',name:'分类事务验收',role:'SUPPLY_CHAIN'}})).id
 await prisma.supplierProductCategory.create({data:{tenantId,supplierId,name:'主数据',sortOrder:0}})
 for(const category of ['历史甲','历史乙','水吧'])await prisma.product.create({data:{tenantId,supplierId,code:`${stamp}-${category}`,name:category,category,price:1}})
 app.decorate('authenticate',async(req:any)=>{req.user={tenantId,userId,role:'SUPPLY_CHAIN'}})
 await app.register(productRoutes,{prefix:'/api/products'});await app.ready()
})
afterAll(async()=>{failAudit=false;await app.close();if(tenantId){await prisma.opLog.deleteMany({where:{tenantId}});await prisma.product.deleteMany({where:{tenantId}});await prisma.supplierProductCategory.deleteMany({where:{tenantId}});await prisma.user.deleteMany({where:{tenantId}});await prisma.supplier.deleteMany({where:{tenantId}});await prisma.tenant.delete({where:{id:tenantId}})}await prisma.$disconnect()})
const get=()=>app.inject(`/api/products/categories?supplierId=${supplierId}`)
const save=(categories:any[])=>app.inject({method:'PATCH',url:`/api/products/categories-order?supplierId=${supplierId}`,payload:{categories}})
it('GET remains readonly; audit failure rolls materialization and ordering back in actual PostgreSQL',async()=>{
 const before=await prisma.supplierProductCategory.findMany({where:{tenantId,supplierId},orderBy:{id:'asc'}})
 const response=await get();expect(response.statusCode).toBe(200);const rows=response.json()
 expect(rows.filter((r:any)=>r.id===null)).toHaveLength(3)
 expect(await prisma.supplierProductCategory.count({where:{tenantId,supplierId}})).toBe(1)
 failAudit=true;const failed=await save(rows.map(({id,name}:any)=>({id,name})).reverse());failAudit=false
 expect(failed.statusCode).toBe(500)
 expect(await prisma.supplierProductCategory.findMany({where:{tenantId,supplierId},orderBy:{id:'asc'}})).toEqual(before)
 expect(await prisma.opLog.count({where:{tenantId}})).toBe(0)
})
it('one explicit save materializes full historical set once without changing product category strings',async()=>{
 const rows=(await get()).json();const snapshot=rows.map(({id,name}:any)=>({id,name})).reverse()
 const products=await prisma.product.findMany({where:{tenantId},select:{id:true,category:true},orderBy:{id:'asc'}})
 expect((await save(snapshot)).statusCode).toBe(200)
 const masters=await prisma.supplierProductCategory.findMany({where:{tenantId,supplierId},orderBy:{sortOrder:'asc'}})
 expect(masters.map(row=>row.name)).toEqual(snapshot.map((row:any)=>row.name));expect(masters).toHaveLength(4)
 expect(await prisma.product.findMany({where:{tenantId},select:{id:true,category:true},orderBy:{id:'asc'}})).toEqual(products)
 expect((await save(snapshot)).statusCode).toBe(409)
 expect(await prisma.supplierProductCategory.count({where:{tenantId,supplierId}})).toBe(4)
 expect(await prisma.opLog.count({where:{tenantId}})).toBe(1)
})
it('new category after read rejects stale full set with zero ordering changes',async()=>{
 const snapshot=(await get()).json().map(({id,name}:any)=>({id,name}))
 await prisma.supplierProductCategory.create({data:{tenantId,supplierId,name:'并发新增',sortOrder:99}})
 const before=await prisma.supplierProductCategory.findMany({where:{tenantId,supplierId},orderBy:{id:'asc'}})
 expect((await save(snapshot.reverse())).statusCode).toBe(409)
 expect(await prisma.supplierProductCategory.findMany({where:{tenantId,supplierId},orderBy:{id:'asc'}})).toEqual(before)
})
