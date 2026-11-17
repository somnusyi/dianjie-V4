import Fastify from 'fastify'
import {afterEach,expect,it,vi} from 'vitest'
import {prisma} from '@dianjie/db'
import {lossClaimRoutes} from '../../src/routes/lossClaims'
afterEach(()=>vi.restoreAllMocks())
it.each(['MANAGER','KITCHEN_LEAD','REGIONAL_MANAGER'])('%s list uses the authenticated store collection and selected header',async role=>{
 const find=vi.spyOn(prisma.lossClaim,'findMany').mockResolvedValue([])
 const app=Fastify();app.decorate('authenticate',async(req:any)=>{req.user={tenantId:'t',userId:'u',role,storeId:'a',storeIds:['a','b']}})
 await app.register(lossClaimRoutes,{prefix:'/api/loss-claims'})
 try{
  expect((await app.inject({url:'/api/loss-claims',headers:{'x-active-store':'b'}})).statusCode).toBe(200)
  expect(find).toHaveBeenCalledWith(expect.objectContaining({where:{tenantId:'t',storeId:'b'}}))
  find.mockClear();expect((await app.inject({url:'/api/loss-claims',headers:{'x-active-store':'foreign'}})).statusCode).toBe(403);expect(find).not.toHaveBeenCalled()
 }finally{await app.close()}
})
