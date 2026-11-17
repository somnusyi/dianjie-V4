import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { invoiceRoutes } from '../../src/routes/invoices'
let app:ReturnType<typeof Fastify>, tenantId:string, otherTenant:string, a:string,b:string,foreign:string,verified:string
let ids:string[]=[]
const headers=(role='SUPPLIER_OWNER',supplier=a)=>({'x-role':role,'x-supplier':supplier})
beforeAll(async()=>{
 tenantId=(await prisma.tenant.create({data:{slug:`invoice-page-${randomUUID()}`,name:'票据核对机构'}})).id
 otherTenant=(await prisma.tenant.create({data:{slug:`invoice-other-${randomUUID()}`,name:'另一票据机构'}})).id
 a=(await prisma.supplier.create({data:{tenantId,no:'A',name:'云岭食材'}})).id
 b=(await prisma.supplier.create({data:{tenantId,no:'B',name:'山川农产'}})).id
 const c=(await prisma.supplier.create({data:{tenantId:otherTenant,no:'C',name:'清禾食材'}})).id
 const uploader=(await prisma.user.create({data:{tenantId,name:'票据参考经办',email:`${randomUUID()}@local.invalid`,password:'!no-login-fixture',role:'FINANCE'}})).id
 const row=(supplierId:string,no:string,status:'PENDING'|'VERIFIED'='PENDING')=>({tenantId,supplierId,invoiceNo:no,status,amount:'1.23',issueDate:new Date('2026-10-01T00:00:00Z'),uploadedAt:new Date('2026-10-20T00:00:00Z'),fileUrl:'',uploadedById:uploader,reviewNote:'内部复核备注'})
 await prisma.invoice.createMany({data:Array.from({length:51},(_,i)=>row(a,`A-${i}`))})
 ids=(await prisma.invoice.findMany({where:{tenantId,supplierId:a},orderBy:[{uploadedAt:'desc'},{id:'desc'}],select:{id:true}})).map(x=>x.id)
 verified=(await prisma.invoice.create({data:row(a,'A-VERIFIED','VERIFIED')})).id
 b=(await prisma.invoice.create({data:row(b,'B-1')})).id
 foreign=(await prisma.invoice.create({data:{...row(c,'C-1'),tenantId:otherTenant}})).id
 app=Fastify();app.decorate('authenticate',async(req:any)=>{req.user={tenantId,role:req.headers['x-role'],supplierId:req.headers['x-supplier'],userId:uploader}})
 await app.register(invoiceRoutes,{prefix:'/api/invoices'});await app.ready()
})
afterAll(async()=>{await app?.close();for(const id of [tenantId,otherTenant].filter(Boolean)) await prisma.invoice.deleteMany({where:{tenantId:id}});await prisma.user.deleteMany({where:{tenantId}});for(const id of [tenantId,otherTenant].filter(Boolean)){await prisma.supplier.deleteMany({where:{tenantId:id}});await prisma.tenant.delete({where:{id}})}await prisma.$disconnect()})
describe('invoice scoped pagination',()=>{
 it.each(['SUPPLIER_OWNER','SUPPLIER_STAFF'])('%s reads all 51 pending invoices in stable tied timestamp order',async role=>{
  const first=await app.inject({url:'/api/invoices?status=PENDING',headers:headers(role)});expect(first.statusCode).toBe(200);expect(first.json().map((x:any)=>x.id)).toEqual(ids.slice(0,50))
  const last=await app.inject({url:`/api/invoices?status=PENDING&cursor=${ids[49]}`,headers:headers(role)});expect(last.statusCode).toBe(200);expect(last.json().map((x:any)=>x.id)).toEqual(ids.slice(50))
 })
 it.each(['company','tenant','status','missing'])('rejects %s cursor outside the exact visible set',async kind=>{
  const cursor=kind==='company'?b:kind==='tenant'?foreign:kind==='status'?verified:randomUUID()
  expect((await app.inject({url:`/api/invoices?status=PENDING&cursor=${cursor}`,headers:headers()})).statusCode).toBe(409)
 })
 it('rejects empty cursor and unbound supplier',async()=>{
  expect((await app.inject({url:'/api/invoices?cursor=',headers:headers()})).statusCode).toBe(400)
  expect((await app.inject({url:'/api/invoices',headers:headers('SUPPLIER_OWNER','')})).statusCode).toBe(403)
 })
 it('keeps supply chain restricted fields on every page',async()=>{
  const r=await app.inject({url:`/api/invoices?status=PENDING&cursor=${ids[49]}`,headers:headers('SUPPLY_CHAIN')});expect(r.statusCode).toBe(200)
  for(const x of r.json()){expect(x).not.toHaveProperty('reviewNote');expect(x).not.toHaveProperty('payments');expect(x).not.toHaveProperty('fileUrl');expect(x).not.toHaveProperty('paidAmount')}
 })
 it('finance can read all same-tenant invoices including both companies but no foreign rows',async()=>{
  const found:string[]=[];let cursor='';for(let i=0;i<2;i++){const r=await app.inject({url:'/api/invoices'+(cursor?`?cursor=${cursor}`:''),headers:headers('FINANCE')});expect(r.statusCode).toBe(200);const rows=r.json();found.push(...rows.map((x:any)=>x.id));cursor=found.at(-1)!}expect(found.length).toBe(53);expect(new Set(found).size).toBe(53);expect(found).toContain(b);expect(found).not.toContain(foreign)
 })
})
