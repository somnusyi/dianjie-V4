import Fastify from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { voucherRoutes } from '../../src/routes/vouchers'
import { generateCarryoverVoucher, closeConfirmedPeriod } from '../../src/services/voucher/carryover'
vi.mock('../../src/services/voucher/carryover',()=>({generateCarryoverVoucher:vi.fn(),closeConfirmedPeriod:vi.fn(),confirmCarryover:vi.fn(),previewCarryover:vi.fn()}))
let app: ReturnType<typeof Fastify>
beforeEach(async()=>{vi.resetAllMocks();app=Fastify();app.decorate('authenticate',async(req:any)=>{req.user={tenantId:'isolated',userId:'finance',role:req.headers['x-role']||'FINANCE'}});await app.register(voucherRoutes,{prefix:'/api/vouchers'});await app.ready()})
afterEach(async()=>{await app.close()})
const post=(path:string,payload:any,role='FINANCE')=>app.inject({method:'POST',url:'/api/vouchers/periods/'+path,payload,headers:{'x-role':role}})
it.each(['SUPPLIER_OWNER','SUPPLY_CHAIN','MANAGER'])('denies %s both preparation and closing',async role=>{expect((await post('carryover',{month:'2026-08'},role)).statusCode).toBe(403);expect((await post('close',{month:'2026-08'},role)).statusCode).toBe(403);expect(generateCarryoverVoucher).not.toHaveBeenCalled();expect(closeConfirmedPeriod).not.toHaveBeenCalled()})
it.each(['2026-13','2026-00','bad','2026-8'])('rejects invalid month %s',async month=>{expect((await post('carryover',{month})).statusCode).toBe(400);expect((await post('close',{month})).statusCode).toBe(400)})
it('prepares using authenticated tenant and finance identity',async()=>{vi.mocked(generateCarryoverVoucher).mockResolvedValue('v');const r=await post('carryover',{month:'2026-08',tenantId:'foreign'});expect(r.json()).toEqual({ok:true,carryoverVoucherId:'v'});expect(generateCarryoverVoucher).toHaveBeenCalledWith({tenantId:'isolated',month:'2026-08',createdById:'finance'})})
it('withCarryover false cannot skip mandatory confirmation',async()=>{vi.mocked(closeConfirmedPeriod).mockRejectedValue(new Error('财务先确认'));const r=await post('close',{month:'2026-08',withCarryover:false});expect(r.statusCode).toBe(400);expect(r.json().error).toContain('先确认');expect(generateCarryoverVoucher).not.toHaveBeenCalled()})
it('closing delegates confirmation checks and never generates a draft',async()=>{vi.mocked(closeConfirmedPeriod).mockResolvedValue({id:'p',carryoverVoucherId:'v'} as any);expect((await post('close',{month:'2026-08'})).json()).toMatchObject({ok:true,carryoverVoucherId:'v'});expect(generateCarryoverVoucher).not.toHaveBeenCalled()})
