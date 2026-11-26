import Fastify from 'fastify'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,expect,it} from 'vitest'
import {prisma} from '@dianjie/db'
import {invoiceRoutes} from '../../src/routes/invoices'
let app:ReturnType<typeof Fastify>,tenantId:string,foreignTenant:string,supplierId:string,emptySupplier:string,nullPaidId:string,nullPendingId:string
const paidIds:string[]=[],pendingIds:string[]=[],otherIds:string[]=[]
beforeAll(async()=>{
 tenantId=(await prisma.tenant.create({data:{slug:`pending-${randomUUID()}`,name:'待开票核对资料'}})).id
 foreignTenant=(await prisma.tenant.create({data:{slug:`pending-other-${randomUUID()}`,name:'另一资料机构'}})).id
 const creator=(await prisma.user.create({data:{tenantId,name:'资料经办',email:`${randomUUID()}@local.invalid`,password:'!fixture-no-login',role:'FINANCE'}})).id
 const storeId=(await prisma.store.create({data:{tenantId,no:'A',name:'资料门店'}})).id
 supplierId=(await prisma.supplier.create({data:{tenantId,no:'A',name:'松源食材',sourceType:'MAIN_SUPPLIER'}})).id
 emptySupplier=(await prisma.supplier.create({data:{tenantId,no:'B',name:'清禾食材',sourceType:'MAIN_SUPPLIER'}})).id
 const hq=(await prisma.supplier.create({data:{tenantId,no:'HQ',name:'资料总仓',sourceType:'HEADQ_WAREHOUSE'}})).id
 const unclassified=(await prisma.supplier.create({data:{tenantId,no:'NULL',name:'未分类供货方'}})).id
 const date=new Date('2026-05-20T00:00:00Z')
 const data=(id:string,no:string,supplier=supplierId)=>({id,tenantId,no,supplierId:supplier,storeId,createdById:creator,status:'ACCOUNTED' as const,totalAmount:'1.11',deliveryDate:date,confirmedAt:date})
 for(let i=0;i<201;i++){paidIds.push(randomUUID());pendingIds.push(randomUUID())}
 await prisma.receipt.createMany({data:[...paidIds.map((id,i)=>({...data(id,`P${i}`),totalAmount:'2.22'})),...pendingIds.map((id,i)=>data(id,`U${i}`))]})
 await prisma.paymentSchedule.createMany({data:paidIds.map(receiptId=>({tenantId,receiptId,supplierId,storeId,amount:'9.99',status:'PAID' as const,creditDays:0,confirmedAt:date,dueAt:date,paidAt:date}))})
 for(const status of ['PENDING','APPROVED','PENDING_APPROVAL','OVERDUE','ON_HOLD'] as const){const id=randomUUID();otherIds.push(id);await prisma.receipt.create({data:data(id,status)});await prisma.paymentSchedule.create({data:{tenantId,receiptId:id,supplierId,storeId,amount:'8.88',status,creditDays:0,confirmedAt:date,dueAt:date}})}
 nullPaidId=randomUUID();nullPendingId=randomUUID()
 await prisma.receipt.create({data:{...data(nullPaidId,'NULL-PAID',unclassified),totalAmount:'3.33'}})
 await prisma.paymentSchedule.create({data:{tenantId,receiptId:nullPaidId,supplierId:unclassified,storeId,amount:'8.88',status:'PAID',creditDays:0,confirmedAt:date,dueAt:date,paidAt:date}})
 await prisma.receipt.create({data:{...data(nullPendingId,'NULL-PENDING',unclassified),totalAmount:'4.44'}})
 const hqPaid=randomUUID();await prisma.receipt.create({data:data(hqPaid,'HEADQ-PAID',hq)})
 await prisma.paymentSchedule.create({data:{tenantId,receiptId:hqPaid,supplierId:hq,storeId,amount:'1.11',status:'PAID',creditDays:0,confirmedAt:date,dueAt:date,paidAt:date}})
 await prisma.receipt.create({data:data(randomUUID(),'HEADQ',hq)})
 await prisma.receipt.create({data:{...data(randomUUID(),'DRAFT'),status:'DRAFT'}})
 const inv=await prisma.invoice.create({data:{tenantId,supplierId,invoiceNo:'LINKED',status:'PENDING',amount:'1.11',issueDate:date,fileUrl:'',uploadedById:creator}})
 await prisma.receipt.create({data:{...data(randomUUID(),'LINKED'),invoiceId:inv.id}})
 app=Fastify();app.decorate('authenticate',async(req:any)=>{req.user={tenantId:req.headers['x-foreign']?foreignTenant:tenantId,role:req.headers['x-role']||'FINANCE',supplierId:req.headers['x-supplier']??supplierId,userId:creator}});await app.register(invoiceRoutes,{prefix:'/api/invoices'});await app.ready()
})
afterAll(async()=>{await app?.close();await prisma.paymentSchedule.deleteMany({where:{tenantId}});await prisma.receipt.deleteMany({where:{tenantId}});await prisma.invoice.deleteMany({where:{tenantId}});await prisma.user.deleteMany({where:{tenantId}});await prisma.store.deleteMany({where:{tenantId}});await prisma.supplier.deleteMany({where:{tenantId}});for(const id of [tenantId,foreignTenant])if(id)await prisma.tenant.delete({where:{id}});await prisma.$disconnect()})
it.each(['SUPPLIER_OWNER','SUPPLIER_STAFF'])('%s sees all 407 eligible own receipts beyond 100, with stable tied dates',async role=>{
 const r=await app.inject({url:'/api/invoices/pending-payable',headers:{'x-role':role}});expect(r.statusCode).toBe(200);const rows=r.json();expect(rows).toHaveLength(407);expect(new Set(rows.map((x:any)=>x.id)).size).toBe(407);expect(rows.map((x:any)=>x.id)).toEqual([...paidIds,...pendingIds,...otherIds].sort().reverse());expect(rows.every((x:any)=>x.supplierId===supplierId)).toBe(true)
})
it('finance preserves both full buckets and exact receipt amounts, not schedule amounts',async()=>{
 const r=await app.inject({url:'/api/invoices/pending-from-finance'});expect(r.statusCode).toBe(200);const d=r.json();expect(d.paid).toHaveLength(202);expect(d.pending).toHaveLength(206);expect(d.summary).toMatchObject({paidCount:202,pendingCount:206,paidAmount:449.55,pendingAmount:231.99});expect(d.paid.map((x:any)=>x.id)).toEqual([...paidIds,nullPaidId].sort());expect(d.pending.map((x:any)=>x.id)).not.toContain(otherIds.at(-1));expect(d.pending.map((x:any)=>x.id)).toEqual([...pendingIds,...otherIds.slice(0,4),nullPendingId].sort())
})
it('empty company and another tenant remain empty',async()=>{
 const a=await app.inject({url:'/api/invoices/pending-payable',headers:{'x-role':'SUPPLIER_OWNER','x-supplier':emptySupplier}});expect(a.json()).toEqual([])
 const b=await app.inject({url:'/api/invoices/pending-from-finance',headers:{'x-foreign':'yes'}});expect(b.json()).toMatchObject({paid:[],pending:[],summary:{paidCount:0,pendingCount:0,paidAmount:0,pendingAmount:0}})
})
it('role and missing binding guards remain intact',async()=>{
 expect((await app.inject({url:'/api/invoices/pending-from-finance',headers:{'x-role':'SUPPLIER_OWNER'}})).statusCode).toBe(403)
 expect((await app.inject({url:'/api/invoices/pending-payable',headers:{'x-role':'FINANCE'}})).statusCode).toBe(403)
 expect((await app.inject({url:'/api/invoices/pending-payable',headers:{'x-role':'SUPPLIER_OWNER','x-supplier':''}})).statusCode).toBe(403)
})
