import Fastify from 'fastify'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest'
import {prisma} from '@dianjie/db'
import {upstreamProcurementRoutes} from '../../src/routes/upstreamProcurement'

let app:ReturnType<typeof Fastify>,tenantId:string,otherTenantId:string,supplierId:string,otherSupplierId:string
const ids:Record<string,string>={}
const visible=['SENT_TO_SUPPLIER','DISPUTED','CONFIRMED','LOCKED','INVOICED','PAID'] as const
const headers=(role='SUPPLIER_OWNER',supplier=supplierId)=>({'x-role':role,'x-supplier':supplier})
beforeAll(async()=>{
 vi.stubEnv('UPSTREAM_PROCUREMENT_ENABLED','true')
 tenantId=(await prisma.tenant.create({data:{slug:`reconciliation-${randomUUID()}`,name:'对账验证机构'}})).id
 otherTenantId=(await prisma.tenant.create({data:{slug:`reconciliation-other-${randomUUID()}`,name:'另一机构'}})).id
 supplierId=(await prisma.supplier.create({data:{tenantId,no:'A',name:'云岭食材'}})).id
 otherSupplierId=(await prisma.supplier.create({data:{tenantId,no:'B',name:'山川农产'}})).id
 for(const status of ['DRAFT',...visible,'CANCELLED'] as const){
  ids[status]=(await prisma.upstreamSettlementStatement.create({data:{tenantId,supplierId,no:status,status,version:Object.keys(ids).length+1,periodStart:new Date('2026-10-01T00:00:00Z'),periodEnd:new Date('2026-10-31T00:00:00Z'),createdById:'fixture',buyerConfirmedAt:status==='DRAFT'?null:new Date()}})).id
 }
 ids.CANCELLED_UNSENT=(await prisma.upstreamSettlementStatement.create({data:{tenantId,supplierId,no:'CANCELLED-UNSENT',status:'CANCELLED',periodStart:new Date('2026-11-01T00:00:00Z'),periodEnd:new Date('2026-11-30T00:00:00Z'),createdById:'fixture'}})).id
 app=Fastify();app.decorate('authenticate',async(req:any)=>{req.user={tenantId:req.headers['x-tenant']||tenantId,userId:'fixture',role:req.headers['x-role']||'SUPPLY_CHAIN',supplierId:req.headers['x-supplier']||null}})
 await app.register(upstreamProcurementRoutes,{prefix:'/api/upstream'});await app.ready()
})
afterAll(async()=>{
 await app?.close()
 if(tenantId){await prisma.upstreamSettlementStatement.deleteMany({where:{tenantId}});await prisma.supplier.deleteMany({where:{tenantId}});await prisma.tenant.delete({where:{id:tenantId}})}
 if(otherTenantId)await prisma.tenant.delete({where:{id:otherTenantId}})
 vi.unstubAllEnvs();await prisma.$disconnect()
})
describe.each(['SUPPLIER_OWNER','SUPPLIER_STAFF'])('%s settlement read scope',role=>{
 it('lists only sent statements including sent cancellation history',async()=>{
  const res=await app.inject({url:'/api/upstream/settlement-statements',headers:headers(role)})
  expect(res.statusCode).toBe(200)
  expect(res.json().map((x:any)=>x.id).sort()).toEqual([...visible.map(s=>ids[s]),ids.CANCELLED].sort())
 })
 it.each(['DRAFT','CANCELLED_UNSENT'])('hides unsent %s from direct detail',async status=>{
  const res=await app.inject({url:`/api/upstream/settlement-statements/${ids[status]}`,headers:headers(role)})
  expect(res.statusCode).toBe(404)
 })
 it.each([...visible, 'CANCELLED'])('retains sent %s details',async status=>{
  expect((await app.inject({url:`/api/upstream/settlement-statements/${ids[status]}`,headers:headers(role)})).statusCode).toBe(200)
 })
 it('cannot replace its binding through query supplierId',async()=>{
  const list=await app.inject({url:`/api/upstream/settlement-statements?supplierId=${supplierId}`,headers:headers(role,otherSupplierId)})
  expect(list.json()).toEqual([])
  expect((await app.inject({url:`/api/upstream/settlement-statements/${ids.CONFIRMED}`,headers:headers(role,otherSupplierId)})).statusCode).toBe(404)
 })
})
it.each(['SUPPLY_CHAIN','ADMIN','SUPER_ADMIN','FINANCE'])('retains %s internal draft reads',async role=>{
 expect((await app.inject({url:`/api/upstream/settlement-statements/${ids.DRAFT}`,headers:headers(role)})).statusCode).toBe(200)
 const list=await app.inject({url:'/api/upstream/settlement-statements',headers:headers(role)});expect(list.json().map((x:any)=>x.id)).toContain(ids.DRAFT)
})
it('does not leak through another tenant or an unbound supplier',async()=>{
 expect((await app.inject({url:`/api/upstream/settlement-statements/${ids.CONFIRMED}`,headers:{...headers(),'x-tenant':otherTenantId}})).statusCode).toBe(404)
 expect((await app.inject({url:'/api/upstream/settlement-statements',headers:{'x-role':'SUPPLIER_OWNER'}})).statusCode).toBe(403)
 expect((await app.inject({url:'/api/upstream/settlement-statements',headers:{'x-role':'MANAGER'}})).statusCode).toBe(403)
})
it.each([['差','异议原因至少填写2个字'],[' '.repeat(3),'异议原因至少填写2个字'],['需'.repeat(1001),'异议原因不能超过1000字']])('rejects invalid dispute input with a readable message',async(reason,message)=>{
 const res=await app.inject({method:'POST',url:`/api/upstream/settlement-statements/${ids.SENT_TO_SUPPLIER}/dispute`,headers:headers(),payload:{reason}})
 expect(res.statusCode).toBe(400);expect(res.json().error).toBe(message)
 expect((await prisma.upstreamSettlementStatement.findUniqueOrThrow({where:{id:ids.SENT_TO_SUPPLIER}})).status).toBe('SENT_TO_SUPPLIER')
})
