import { beforeEach, expect, it, vi } from 'vitest'
import { prisma } from '@dianjie/db'
import { generateCarryoverVoucher, confirmCarryover, closeConfirmedPeriod } from '../../src/services/voucher/carryover'
vi.mock('@dianjie/db', () => ({ prisma: { $transaction: vi.fn() } }))
vi.mock('../../src/services/voucher/index', () => ({ nextVoucherNo: vi.fn(async () => 'PZ-202608-0003') }))
let tx: any, existing: any, source: number
const entries = (n: number) => [{ accountCode: '6001', debit: n, credit: 0 }, { accountCode: '4103', debit: 0, credit: n }]
const opts = { tenantId: 't', month: '2026-08', createdById: 'f' }
const close = () => closeConfirmedPeriod({ tenantId: 't', month: '2026-08', closedById: 'f' })
beforeEach(() => {
 vi.clearAllMocks(); source = 9.14
 existing = { id:'carry',sourceId:'2026-08',status:'DRAFT',exportedAt:null,updatedAt:new Date(),totalDebit:10.25,totalCredit:10.25,entries:entries(10.25) }
 tx = { $queryRaw:vi.fn(),chartOfAccount:{findFirst:vi.fn(async()=>({code:'4103',name:'本年利润'}))},
 voucherEntry:{findMany:vi.fn(async()=>[{accountCode:'6001',credit:source,debit:0}]),deleteMany:vi.fn(),createMany:vi.fn()},
 voucher:{findFirst:vi.fn(async()=>existing),updateMany:vi.fn(async()=>({count:1})),create:vi.fn(async()=>({id:'new'})),count:vi.fn(async()=>0)},
 accountingPeriod:{findUnique:vi.fn(async()=>({status:'REOPENED'})),upsert:vi.fn(async()=>({id:'p',status:'CLOSED'}))},opLog:{create:vi.fn()} }
 vi.mocked(prisma.$transaction).mockImplementation(async(fn:any)=>fn(tx))
})
it('recalculates draft 10.25 to 9.14 with same ID and before/after log',async()=>{
 expect(await generateCarryoverVoucher(opts)).toBe('carry')
 expect(tx.voucher.updateMany.mock.calls[0][0]).toMatchObject({where:{status:'DRAFT',exportedAt:null},data:{totalDebit:9.14,totalCredit:9.14}})
 expect(tx.opLog.create.mock.calls[0][0].data.metadata).toMatchObject({before:{totalDebit:'10.25'},after:{totalDebit:9.14}})
 expect(tx.voucher.create).not.toHaveBeenCalled()
})
it.each(['POSTED','VOIDED','EXPORTED'])('protects %s from recalculation',async status=>{
 if(status==='EXPORTED')existing.exportedAt=new Date();else existing.status=status
 await expect(generateCarryoverVoucher(opts)).rejects.toThrow('不能自动重算');expect(tx.voucherEntry.deleteMany).not.toHaveBeenCalled()
})
it('same draft is idempotent',async()=>{source=10.25;expect(await generateCarryoverVoucher(opts)).toBe('carry');expect(tx.opLog.create).not.toHaveBeenCalled()})
it.each([9.14,.01,-9.14,-.01])('creates balanced draft for %s',async n=>{source=n;existing=null;await generateCarryoverVoucher(opts);expect(tx.voucher.create.mock.calls[0][0].data).toMatchObject({status:'DRAFT',totalDebit:Math.abs(n),totalCredit:Math.abs(n)})})
it('rejects stale confirmation',async()=>{await expect(confirmCarryover('t','carry','f')).rejects.toThrow('本月数据已变化');expect(tx.voucher.updateMany).not.toHaveBeenCalled()})
it('finance confirms a current draft',async()=>{source=10.25;await confirmCarryover('t','carry','f');expect(tx.voucher.updateMany.mock.calls[0][0].data).toMatchObject({status:'POSTED',postedById:'f'})})
it('racing approval prevents entry replacement',async()=>{tx.voucher.updateMany.mockResolvedValue({count:0});await expect(generateCarryoverVoucher(opts)).rejects.toThrow('状态已变化');expect(tx.voucherEntry.deleteMany).not.toHaveBeenCalled()})
it.each(['missing','DRAFT','stale'])('blocks %s carryover close',async mode=>{if(mode==='missing')existing=null;if(mode==='stale')existing.status='POSTED';await expect(close()).rejects.toThrow();expect(tx.accountingPeriod.upsert).not.toHaveBeenCalled()})
it('closes only after finance confirmed current calculation',async()=>{source=10.25;existing.status='POSTED';await close();expect(tx.accountingPeriod.upsert.mock.calls[0][0].update).toMatchObject({status:'CLOSED',carryoverVoucherId:'carry'})})
it('empty month closes without artificial voucher',async()=>{source=0;existing=null;await close();expect(tx.accountingPeriod.upsert.mock.calls[0][0].update.carryoverVoucherId).toBeNull()})
it('other drafts still prevent close',async()=>{source=10.25;existing.status='POSTED';tx.voucher.count.mockResolvedValue(1);await expect(close()).rejects.toThrow('未审核凭证')})
it.each(['prepare','confirm','close'])('closed period rejects %s',async mode=>{tx.accountingPeriod.findUnique.mockResolvedValue({status:'CLOSED'});await expect(mode==='prepare'?generateCarryoverVoucher(opts):mode==='confirm'?confirmCarryover('t','carry','f'):close()).rejects.toThrow('已关账');expect(tx.voucher.updateMany).not.toHaveBeenCalled();expect(tx.accountingPeriod.upsert).not.toHaveBeenCalled()})

it('net one cent after offsetting entries is not lost to binary rounding',async()=>{
 existing=null;tx.voucherEntry.findMany.mockResolvedValue([{accountCode:'6001',credit:9.15,debit:9.14}]);await generateCarryoverVoucher(opts);expect(tx.voucher.create.mock.calls[0][0].data).toMatchObject({totalDebit:.01,totalCredit:.01})
})
