import{beforeEach,afterEach,expect,it,vi}from'vitest'
import Fastify from'fastify'
import jwt from'@fastify/jwt'
import{createAuthenticate}from'../../src/lib/authenticate-principal'
import{issueSessionTokens}from'../../src/services/authTokens'
import{revokeSession}from'../../src/lib/revoke-session'
import{registerIdempotency}from'../../src/lib/idempotency'
const{cache}=vi.hoisted(()=>({cache:new Map<string,string>()}))
vi.mock('ioredis',()=>({default:class{on(){}async get(k:string){return cache.get(k)}async setex(k:string,_ttl:number,value:string){cache.set(k,value)}}}))
let app:any,principal:any,revoked:Set<string>,db:any,readCount:number,writeCount:number
beforeEach(async()=>{
 cache.clear();revoked=new Set();readCount=0;writeCount=0;principal={id:'u',tenantId:'t',role:'SUPPLY_CHAIN',status:'ACTIVE',authVersion:0,storeId:null,storeIds:[],supplierId:null,tenant:{status:'ACTIVE'},supplier:null}
 db={user:{findFirst:vi.fn(async()=>principal)},revokedToken:{findFirst:vi.fn(async({where}:any)=>where.jti.in.some((j:string)=>revoked.has(j))?{}:null),upsert:vi.fn(async({where}:any)=>{revoked.add(where.jti);return{}})},opLog:{create:vi.fn(async()=>({}))},$transaction:async(fn:any)=>{const before=new Set(revoked);try{return await fn(db)}catch(e){revoked=before;throw e}}}
 app=Fastify();await app.register(jwt,{secret:'synthetic-only-test-signing-key'});app.decorate('authenticate',createAuthenticate(db));registerIdempotency(app)
 app.get('/read',{preHandler:[app.authenticate]},async()=>{readCount++;return{ok:true}})
 app.post('/write',{preHandler:[app.authenticate]},async()=>{writeCount++;return{ok:true}})
 await app.ready()
})
afterEach(()=>app.close())
const header=(token:string)=>({authorization:'Bearer '+token})
it.each(['SUPPLY_CHAIN','FINANCE','MANAGER','BOSS','ADMIN','SUPER_ADMIN','STAFF','ENGINEERING','PURCHASER','CHEF','KITCHEN_LEAD','SUPERVISOR','REGIONAL_MANAGER','CHEF_DIRECTOR'])('all roles immediately reject disabled/auth-version/role/tenant changes: %s',async(role)=>{
 principal.role=role;const pair=issueSessionTokens(app.jwt,principal)
 expect((await app.inject({url:'/read',headers:header(pair.token)})).statusCode).toBe(200)
 for(const mutate of [()=>principal.status='DISABLED',()=>principal.authVersion=1,()=>principal.role=role==='STAFF'?'FINANCE':'STAFF',()=>principal.tenant.status='DISABLED']){
  principal.status='ACTIVE';principal.authVersion=0;principal.role=role;principal.tenant.status='ACTIVE';mutate()
  expect((await app.inject({url:'/read',headers:header(pair.token)})).statusCode).toBe(401)
  expect((await app.inject({url:'/write',method:'POST',headers:header(pair.token)})).statusCode).toBe(401)
 }
 expect(writeCount).toBe(0)
})
it('new access and refresh share sid; one logout revokes that session only',async()=>{
 const a=issueSessionTokens(app.jwt,principal),b=issueSessionTokens(app.jwt,principal);const ca=app.jwt.verify(a.token),ra=app.jwt.verify(a.refreshToken)
 expect(ca.sid).toBe(ra.jti);expect(ra.sid).toBe(ca.sid)
 await revokeSession(db,app.jwt,{refreshToken:a.refreshToken})
 expect((await app.inject({url:'/read',headers:header(a.token)})).statusCode).toBe(401)
 expect((await app.inject({url:'/read',headers:header(b.token)})).statusCode).toBe(200)
})
it('legacy logout revokes presented access and refuses mismatched session instead of logging out two devices',async()=>{
 const a=issueSessionTokens(app.jwt,principal),b=issueSessionTokens(app.jwt,principal)
 await expect(revokeSession(db,app.jwt,{accessClaims:app.jwt.verify(a.token),refreshToken:b.refreshToken})).rejects.toThrow('会话不匹配')
 expect(revoked.size).toBe(0)
 await revokeSession(db,app.jwt,{accessClaims:app.jwt.verify(a.token),refreshToken:a.refreshToken});expect((await app.inject({url:'/read',headers:header(a.token)})).statusCode).toBe(401)
})
it('revocation DB failure cannot turn logout into success or partial mutation',async()=>{
 const a=issueSessionTokens(app.jwt,principal);db.opLog.create.mockRejectedValue(new Error('synthetic-fault'))
 await expect(revokeSession(db,app.jwt,{accessClaims:app.jwt.verify(a.token),refreshToken:a.refreshToken})).rejects.toThrow('synthetic-fault');expect(revoked.size).toBe(0)
})
it('cached 2xx cannot bypass logout, permission downgrade or changed store scope',async()=>{
 const a=issueSessionTokens(app.jwt,principal),headers={...header(a.token),'idempotency-key':'same-key-12345'}
 expect((await app.inject({url:'/write',method:'POST',headers})).statusCode).toBe(200)
 expect((await app.inject({url:'/write',method:'POST',headers})).headers['idempotent-replay']).toBe('true')
 principal.storeId='changed-store';expect((await app.inject({url:'/write',method:'POST',headers})).statusCode).toBe(409)
 principal.storeId=null;await revokeSession(db,app.jwt,{refreshToken:a.refreshToken});expect((await app.inject({url:'/write',method:'POST',headers})).statusCode).toBe(401);expect(writeCount).toBe(1)
})
it('principal DB outage fails closed with 503 and never invokes protected handler',async()=>{
 const pair=issueSessionTokens(app.jwt,principal);db.user.findFirst.mockRejectedValue(new Error('synthetic-db-down'));expect((await app.inject({url:'/write',method:'POST',headers:header(pair.token)})).statusCode).toBe(503);expect(writeCount).toBe(0)
})

it.each(['SUPPLIER_OWNER','SUPPLIER_STAFF','SUPPLIER_SUB'])('supplier %s cannot use old token after company disable or binding change',async(role)=>{
 principal.role=role;principal.supplierId='supplier';principal.supplier={id:'supplier',status:'ENABLED',tenantId:'t',businessScopes:['WAREHOUSE_UPSTREAM']}
 const pair=issueSessionTokens(app.jwt,principal)
 expect((await app.inject({url:'/read',headers:header(pair.token)})).statusCode).toBe(200)
 principal.supplier.status='DISABLED';expect((await app.inject({url:'/read',headers:header(pair.token)})).statusCode).toBe(401)
 principal.supplier.status='ENABLED';principal.supplierId='changed';expect((await app.inject({url:'/write',method:'POST',headers:header(pair.token)})).statusCode).toBe(401);expect(writeCount).toBe(0)
})
it('keeps legacy typed access working without sid and revokes that presented access on logout',async()=>{
 const old=app.jwt.sign({userId:'u',tenantId:'t',role:principal.role,jti:'legacy-access',typ:'access',ver:0},{expiresIn:'2h'})
 expect((await app.inject({url:'/read',headers:header(old)})).statusCode).toBe(200)
 await revokeSession(db,app.jwt,{accessClaims:app.jwt.verify(old)})
 expect((await app.inject({url:'/read',headers:header(old)})).statusCode).toBe(401)
})
