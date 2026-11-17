import {beforeEach,afterEach,expect,it,vi}from'vitest'
import {CallLogger}from'../../src/services/meituan/callLogger'
import {redactProviderPayload,redactProviderRaw,safeProviderCallLog}from'../../src/lib/provider-log-safety'
const {db}=vi.hoisted(()=>({db:{meituanApiCallLog:{create:vi.fn(),update:vi.fn()}}}))
vi.mock('@dianjie/db',()=>({prisma:db}))
beforeEach(()=>{vi.resetAllMocks();db.meituanApiCallLog.create.mockResolvedValue({id:'log'});db.meituanApiCallLog.update.mockResolvedValue({})})
it('removes nested credential keys, serialized biz keys, authorization and echoed known token without mutating source',()=>{
 const value={normal:'rice',nested:{appAuthToken:'synthetic-secret',secret:'private'},biz:JSON.stringify({password:'synthetic-password',qty:2}),headers:{Authorization:'Bearer private'}}
 const before=JSON.stringify(value),safe=JSON.stringify(redactProviderPayload(value,['synthetic-secret']))
 expect(safe).not.toContain('synthetic-secret');expect(safe).not.toContain('synthetic-password');expect(safe).not.toContain('Bearer private');expect(safe).toContain('rice');expect(JSON.stringify(value)).toBe(before)
 expect(redactProviderRaw('unparseable synthetic-secret')).toBe('[Provider response withheld]')
})
it('new call start never persists token/sign and finish strips echoed provider message and credentials',async()=>{
 const logger=new CallLogger();await logger.start({correlationId:'c',apiPath:'/orders',apiTitle:'Orders',mode:'real',requestPublic:{appAuthToken:'synthetic-token',sign:'synthetic-sign',biz:'{}'},requestBiz:{qty:2},signature:'synthetic-sign'})
 expect(JSON.stringify(db.meituanApiCallLog.create.mock.calls)).not.toContain('synthetic-token');expect(JSON.stringify(db.meituanApiCallLog.create.mock.calls)).not.toContain('synthetic-sign')
 await logger.finish('log',{httpStatus:200,httpDurationMs:2,responseCode:'OP_SUCCESS',responseMsg:'synthetic-token',responseRaw:JSON.stringify({code:'OP_SUCCESS',msg:'synthetic-token',data:{access_token:'synthetic-token',qty:2}}),responseData:{nested:{token:'synthetic-token'},qty:2},traceId:'synthetic-token'})
 const saved=JSON.stringify(db.meituanApiCallLog.update.mock.calls);expect(saved).not.toContain('synthetic-token');expect(saved).toContain('qty')
})
it('network failure logs no raw transport message or invalid response',async()=>{
 await new CallLogger().fail('log',{httpDurationMs:2,errorMessage:'https://user:synthetic-secret@host/path?token=private',responseRaw:'synthetic-secret'})
 expect(JSON.stringify(db.meituanApiCallLog.update.mock.calls)).not.toContain('synthetic-secret')
})
it('read guard protects historical detail/export rows before cleanup',()=>{
 const old={id:'old',requestPublic:{appAuthToken:'synthetic-secret'},requestBiz:{qty:2},signature:'synthetic-sign',responseRaw:JSON.stringify({msg:'synthetic-secret',qty:2}),responseData:{token:'synthetic-secret'},responseMsg:'synthetic-secret',errorMessage:'synthetic-secret'}
 expect(JSON.stringify(safeProviderCallLog(old))).not.toContain('synthetic-secret');expect(JSON.stringify(safeProviderCallLog(old))).not.toContain('synthetic-sign');expect(safeProviderCallLog(old).requestBiz).toEqual({qty:2})
})
