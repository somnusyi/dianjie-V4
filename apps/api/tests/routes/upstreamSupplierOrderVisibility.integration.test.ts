import Fastify from 'fastify'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,expect,it,vi} from 'vitest'
import {prisma} from '@dianjie/db'
import {upstreamProcurementRoutes} from '../../src/routes/upstreamProcurement'

let app:ReturnType<typeof Fastify>,tenantId:string,supplierId:string,otherSupplierId:string,userId:string,vendorId:string
const orders:Record<string,string>={}
const sentStatuses=['SUBMITTED_TO_SUPPLIER','CHANGE_PROPOSED','SUPPLIER_ACCEPTED','PARTIALLY_SHIPPED','SHIPPED','PARTIALLY_RECEIVED','RECEIVED','SETTLEMENT_PENDING','CLOSED'] as const
const headers=()=>({'x-role':'SUPPLIER_OWNER','x-supplier':supplierId})
beforeAll(async()=>{
 vi.stubEnv('UPSTREAM_PROCUREMENT_ENABLED','true')
 tenantId=(await prisma.tenant.create({data:{slug:`order-visibility-${randomUUID()}`,name:'采购发送可见性隔离'}})).id
 const supplier=await prisma.supplier.create({data:{tenantId,no:'A',name:'供货甲'}});supplierId=supplier.id
 otherSupplierId=(await prisma.supplier.create({data:{tenantId,no:'B',name:'供货乙'}})).id
 userId=(await prisma.user.create({data:{tenantId,email:`${randomUUID()}@local.invalid`,password:'unusable',role:'SUPPLY_CHAIN',name:'采购员'}})).id
 vendorId=(await prisma.user.create({data:{tenantId,email:`${randomUUID()}@local.invalid`,password:'unusable',role:'SUPPLIER_OWNER',name:'供应商甲',supplierId}})).id
 const warehouseId=(await prisma.warehouse.create({data:{tenantId,code:'MAIN',name:'总仓'}})).id
 for(const status of ['DRAFT','PENDING_APPROVAL',...sentStatuses,'CANCELLED'] as const){
  orders[status]=(await prisma.upstreamPurchaseOrder.create({data:{tenantId,supplierId,warehouseId,createdById:userId,no:status,status,submittedAt:status==='CANCELLED'?new Date():null}})).id
 }
 orders.CANCELLED_UNSENT=(await prisma.upstreamPurchaseOrder.create({data:{tenantId,supplierId,warehouseId,createdById:userId,no:'CANCELLED-UNSENT',status:'CANCELLED'}})).id
 app=Fastify();app.decorate('authenticate',async(req:any)=>{req.user={tenantId,userId:req.headers['x-role']==='SUPPLIER_OWNER'?vendorId:userId,role:req.headers['x-role']||'SUPPLY_CHAIN',supplierId:req.headers['x-supplier']||null}})
 await app.register(upstreamProcurementRoutes,{prefix:'/api/upstream'});await app.ready()
})
afterAll(async()=>{await app?.close();vi.unstubAllEnvs();await prisma.$disconnect()})
it('supplier lists only sent orders, including sent cancellation history',async()=>{
 const res=await app.inject({url:'/api/upstream/purchase-orders',headers:headers()});expect(res.statusCode).toBe(200)
 expect(res.json().map((o:any)=>o.id).sort()).toEqual([...sentStatuses.map(s=>orders[s]),orders.CANCELLED].sort())
})
it.each(['DRAFT','PENDING_APPROVAL','CANCELLED_UNSENT'])('hides unsent %s from details, batch entry and explicit status queries',async status=>{
 const detail=await app.inject({url:`/api/upstream/purchase-orders/${orders[status]}`,headers:headers()});expect(detail.statusCode).toBe(404)
 const batches=await app.inject({url:`/api/upstream/purchase-orders/${orders[status]}/quality-batches`,headers:headers()});expect(batches.statusCode).toBe(404)
 const queryStatus=status==='CANCELLED_UNSENT'?'CANCELLED':status
 const list=await app.inject({url:`/api/upstream/purchase-orders?status=${queryStatus}&paginated=true`,headers:headers()});expect(list.statusCode).toBe(200);expect(list.json().total).toBe(status==='CANCELLED_UNSENT'?1:0);if(status==='CANCELLED_UNSENT')expect(list.json().items.map((o:any)=>o.id)).toEqual([orders.CANCELLED])
})
it('internal users retain drafts while other companies cannot read sent orders',async()=>{
 expect((await app.inject(`/api/upstream/purchase-orders/${orders.DRAFT}`)).statusCode).toBe(200)
 const other={'x-role':'SUPPLIER_OWNER','x-supplier':otherSupplierId}
 expect((await app.inject({url:`/api/upstream/purchase-orders/${orders.SUBMITTED_TO_SUPPLIER}`,headers:other})).statusCode).toBe(404)
 expect((await app.inject({url:'/api/upstream/purchase-orders',headers:other})).json()).toEqual([])
})
