import { randomUUID } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { Prisma,prisma } from '@dianjie/db'
import { createSupplierInvoice,reviewInvoice } from '../../src/services/invoiceIntegrity'
let tenantId:string,supplierId:string,otherSupplier:string,storeId:string,userId:string
beforeAll(async()=>{tenantId=(await prisma.tenant.create({data:{slug:`invoice-retry-${randomUUID()}`,name:'重交票据核验机构'}})).id;supplierId=(await prisma.supplier.create({data:{tenantId,no:'A',name:'云岭食材'}})).id;otherSupplier=(await prisma.supplier.create({data:{tenantId,no:'B',name:'清禾食材'}})).id;storeId=(await prisma.store.create({data:{tenantId,no:'M1',name:'资料核对门店'}})).id;userId=(await prisma.user.create({data:{tenantId,name:'票据经办',email:`${randomUUID()}@local.invalid`,password:'!no-login-fixture',role:'FINANCE'}})).id})
afterAll(async()=>{await prisma.opLog.deleteMany({where:{tenantId}});await prisma.receipt.deleteMany({where:{tenantId}});await prisma.invoice.deleteMany({where:{tenantId}});await prisma.user.deleteMany({where:{tenantId}});await prisma.store.deleteMany({where:{tenantId}});await prisma.supplier.deleteMany({where:{tenantId}});await prisma.tenant.delete({where:{id:tenantId}});await prisma.$disconnect()})
async function receipt(supplier=supplierId,status:'ACCOUNTED'|'DRAFT'='ACCOUNTED'){return prisma.receipt.create({data:{tenantId,no:`RK-${randomUUID()}`,supplierId:supplier,storeId,createdById:userId,status,deliveryDate:new Date('2026-10-20T00:00:00Z'),confirmedAt:status==='ACCOUNTED'?new Date():null,totalAmount:'61.43'}})}
const input=(id:string,no:string)=>({tenantId,supplierId,uploadedById:userId,role:'SUPPLIER_OWNER',invoiceNo:no,invoiceCode:null,amount:new Prisma.Decimal('61.43'),amountWithoutTax:null,taxRate:new Prisma.Decimal('.06'),taxAmount:null,issueDate:new Date('2026-10-20T00:00:00Z'),fileUrl:'https://example.test/original.png',fileType:'image' as const,note:'初次票据说明',receiptIds:[id]})
async function rejected(){const r=await receipt();const data=input(r.id,`FP-${randomUUID()}`);const c=await createSupplierInvoice(data);await reviewInvoice({tenantId,invoiceId:c.invoice.id,userId,role:'FINANCE',action:'REJECT',note:'补清晰图片',expectedUploadedAt:c.invoice.uploadedAt.toISOString()});return {r,data,original:c.invoice,next:{...data,expectedUploadedAt:c.invoice.uploadedAt.toISOString(),fileUrl:'https://example.test/clear.png',note:'补清晰图片后重交'}}}
describe('rejected invoice resubmission',()=>{
 it('keeps invoice id/no, preserves prior picture and rejection in audit, rebinds receipt and resets review only',async()=>{
  const f=await rejected();expect((await prisma.receipt.findUniqueOrThrow({where:{id:f.r.id}})).invoiceId).toBeNull()
  const result=await createSupplierInvoice(f.next);expect(result.invoice.id).toBe(f.original.id);expect(result.invoice.status).toBe('PENDING');expect(result.invoice.fileUrl).toBe(f.next.fileUrl);expect(result.invoice.uploadedAt.getTime()).toBeGreaterThan(f.original.uploadedAt.getTime());expect(result.invoice.reviewNote).toBeNull();expect(result.invoice.reviewedAt).toBeNull();expect(result.invoice.reviewedById).toBeNull()
  const r=await prisma.receipt.findUniqueOrThrow({where:{id:f.r.id}});expect(r.invoiceId).toBe(f.original.id);expect(r.status).toBe('ACCOUNTED');expect(r.totalAmount.toString()).toBe('61.43')
  const log=await prisma.opLog.findFirstOrThrow({where:{tenantId,targetId:f.original.id,metadata:{path:['action'],equals:'RESUBMIT'}}});expect((log.metadata as any).previous.fileUrl).toBe(f.data.fileUrl);expect((log.metadata as any).previous.reviewNote).toBe('补清晰图片')
 })
 it.each(['wrong-amount','other-company','draft','occupied','stale-version','missing-version','paid'])('rejects %s without changing original rejected invoice or links',async kind=>{
  const f=await rejected();let next:any={...f.next}
  if(kind==='wrong-amount')next.amount=new Prisma.Decimal('62')
  if(kind==='other-company')next.receiptIds=[(await receipt(otherSupplier)).id]
  if(kind==='draft')next.receiptIds=[(await receipt(supplierId,'DRAFT')).id]
  if(kind==='occupied'){const r=await receipt();await createSupplierInvoice(input(r.id,`FP-occupied-${randomUUID()}`));next.receiptIds=[r.id]}
  if(kind==='stale-version')next.expectedUploadedAt='2020-01-01T00:00:00.000Z'
  if(kind==='missing-version')delete next.expectedUploadedAt
  if(kind==='paid')await prisma.invoice.update({where:{id:f.original.id},data:{paidAmount:'0.01'}})
  const before=await prisma.invoice.findUniqueOrThrow({where:{id:f.original.id}})
  await expect(createSupplierInvoice(next)).rejects.toMatchObject({statusCode:kind==='wrong-amount'?400:409})
  expect(await prisma.invoice.findUniqueOrThrow({where:{id:f.original.id}})).toEqual(before);expect((await prisma.receipt.findUniqueOrThrow({where:{id:f.r.id}})).invoiceId).toBeNull()
 })
 it('two simultaneous resubmissions make one revision, while a pending retry cannot replace its picture',async()=>{
  const f=await rejected();const results=await Promise.all([createSupplierInvoice(f.next),createSupplierInvoice({...f.next,fileUrl:'https://example.test/other.png'})]);expect(results.map(x=>x.duplicated).sort()).toEqual([false,true]);expect(new Set(results.map(x=>x.invoice.id)).size).toBe(1)
  expect(await prisma.opLog.count({where:{tenantId,targetId:f.original.id,metadata:{path:['action'],equals:'RESUBMIT'}}})).toBe(1)
  expect((await prisma.invoice.findUniqueOrThrow({where:{id:f.original.id}})).fileUrl).toBe(results.find(x=>!x.duplicated)!.invoice.fileUrl)
 })
 it('stale or unversioned review cannot process a new round; current version can approve once',async()=>{
  const f=await rejected();const c=await createSupplierInvoice(f.next)
  const review={tenantId,invoiceId:c.invoice.id,userId,role:'FINANCE',action:'APPROVE' as const,note:null}
  await expect(reviewInvoice({...review,expectedUploadedAt:f.original.uploadedAt.toISOString()})).rejects.toMatchObject({statusCode:409});await expect(reviewInvoice(review)).rejects.toMatchObject({statusCode:409})
  const current={...review,expectedUploadedAt:c.invoice.uploadedAt.toISOString()};expect((await reviewInvoice(current)).duplicated).toBe(false);expect((await reviewInvoice(current)).duplicated).toBe(true)
  expect((await prisma.invoice.findUniqueOrThrow({where:{id:c.invoice.id}})).status).toBe('VERIFIED')
 })
 it('concurrent replay of the old rejection cannot reject the resubmitted round',async()=>{
  const f=await rejected()
  const [upload,oldReview]=await Promise.allSettled([createSupplierInvoice(f.next),reviewInvoice({tenantId,invoiceId:f.original.id,userId,role:'FINANCE',action:'REJECT',note:'补清晰图片',expectedUploadedAt:f.original.uploadedAt.toISOString()})])
  expect(upload.status).toBe('fulfilled')
  if(oldReview.status==='fulfilled')expect(oldReview.value.duplicated).toBe(true)
  else expect(oldReview.reason).toMatchObject({statusCode:409})
  const current=await prisma.invoice.findUniqueOrThrow({where:{id:f.original.id}})
  expect(current.status).toBe('PENDING');expect(current.reviewNote).toBeNull();expect(current.fileUrl).toBe(f.next.fileUrl)
  expect((await prisma.receipt.findUniqueOrThrow({where:{id:f.r.id}})).invoiceId).toBe(f.original.id)
 })

})
