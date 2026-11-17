import{beforeAll,beforeEach,afterAll,afterEach,expect,it,vi}from'vitest'
import{randomBytes}from'node:crypto'
import{PrismaClient}from'@prisma/client'
import Fastify from'fastify'
import jwt from'@fastify/jwt'
import bcrypt from'bcryptjs'
import{createAuthenticate}from'../../src/lib/authenticate-principal'
import{authRoutes}from'../../src/routes/auth'
import{userRoutes}from'../../src/routes/users'
import{issueSessionTokens}from'../../src/services/authTokens'
import{registerIdempotency}from'../../src/lib/idempotency'
const{state,cache}=vi.hoisted(()=>({state:{db:null as any},cache:new Map<string,string>()}))
vi.mock('@dianjie/db',()=>({prisma:new Proxy({}, {get:(_t,key)=>{const value=state.db[key];return typeof value==='function'?value.bind(state.db):value}})}))
vi.mock('ioredis',()=>({default:class{on(){}async get(k:string){return cache.get(k)}async setex(k:string,_ttl:number,value:string){cache.set(k,value)}}}))
let app:any,tenant:any,user:any,protectedWrites:number
const browser={origin:'http://localhost:3201','x-dianjie-session':'cookie-v1','sec-fetch-site':'same-origin'}
beforeAll(()=>{
 const databaseUrl=process.env.DATABASE_URL; if(!databaseUrl)throw Error('Dedicated database URL required'); const url=new URL(databaseUrl)
 if(url.hostname!=='127.0.0.1'||url.port!=='15449'||url.pathname!=='/dianjie_four_gap_test')throw Error('Isolated database guard refused')
 state.db=new PrismaClient({datasources:{db:{url:databaseUrl}},log:[]})
})
afterAll(()=>state.db?.$disconnect())
beforeEach(async()=>{
 cache.clear();protectedWrites=0;vi.stubEnv('NODE_ENV','test');vi.stubEnv('PREVIEW_TENANT_SLUG','');vi.stubEnv('BROWSER_SESSION_ENV','isolated');vi.stubEnv('BROWSER_SESSION_ORIGINS',browser.origin);vi.stubEnv('BROWSER_SESSION_ALLOW_LOCAL_HTTP','true')
 tenant=await state.db.tenant.create({data:{name:'清禾商贸',slug:'g02-auth-'+randomBytes(8).toString('hex')}})
 user=await state.db.user.create({data:{tenantId:tenant.id,name:'李晨',email:'li@example.test',password:await bcrypt.hash('synthetic-password',4),role:'SUPPLY_CHAIN'}})
 app=Fastify();await app.register(jwt,{secret:'synthetic-isolated-signing-key-not-production'});app.decorate('authenticate',createAuthenticate(state.db));registerIdempotency(app)
 await app.register(authRoutes,{prefix:'/api/auth'});await app.register(userRoutes,{prefix:'/api/users'})
 app.get('/read',{preHandler:[app.authenticate]},async()=>({ok:true}))
 app.post('/write',{preHandler:[app.authenticate]},async()=>{await state.db.opLog.create({data:{tenantId:tenant.id,userId:user.id,action:'受限写入'}});protectedWrites++;return{ok:true}})
 await app.ready()
})
afterEach(async()=>{
 await app?.close();await state.db.revokedToken.deleteMany({where:{userId:user.id}});await state.db.opLog.deleteMany({where:{tenantId:tenant.id}});await state.db.user.deleteMany({where:{tenantId:tenant.id}});await state.db.tenant.delete({where:{id:tenant.id}});vi.unstubAllEnvs()
})
async function login(headers:any=browser){const result=await app.inject({method:'POST',url:'/api/auth/login',headers,payload:{identifier:user.email,password:'synthetic-password',tenantSlug:tenant.slug}});expect(result.statusCode).toBe(200);return result}
const bearer=(r:any)=>({authorization:'Bearer '+r.json().token})
const cookie=(r:any)=>String(r.headers['set-cookie']).split(';')[0]
it('real cookie logout denies read/write/refresh for one session and leaves another session alive',async()=>{
 const a=await login(),b=await login();const out=await app.inject({method:'POST',url:'/api/auth/browser-logout',headers:{...browser,cookie:cookie(a)},payload:{}});expect(out.statusCode).toBe(200)
 expect((await app.inject({url:'/read',headers:bearer(a)})).statusCode).toBe(401);expect((await app.inject({url:'/write',method:'POST',headers:bearer(a)})).statusCode).toBe(401);expect(protectedWrites).toBe(0)
 expect((await app.inject({url:'/read',headers:bearer(b)})).statusCode).toBe(200)
 expect((await app.inject({method:'POST',url:'/api/auth/refresh',headers:{...browser,cookie:cookie(a)},payload:{}})).statusCode).toBe(401)
})
it('real legacy logout invalidates current access and its refresh; no global authVersion bump',async()=>{
 const a=await login({});const before=await state.db.user.findUnique({where:{id:user.id}})
 const out=await app.inject({method:'POST',url:'/api/auth/logout',headers:bearer(a),payload:{refreshToken:a.json().refreshToken}});expect(out.statusCode).toBe(200);expect((await app.inject({url:'/read',headers:bearer(a)})).statusCode).toBe(401)
 expect((await state.db.user.findUnique({where:{id:user.id}})).authVersion).toBe(before.authVersion)
})
it('real password change invalidates issued access and refresh before further writes',async()=>{
 const a=await login();expect((await app.inject({method:'POST',url:'/api/auth/change-password',headers:bearer(a),payload:{oldPassword:'synthetic-password',newPassword:'synthetic-new-password'}})).statusCode).toBe(200)
 expect((await app.inject({url:'/write',method:'POST',headers:bearer(a)})).statusCode).toBe(401);expect(protectedWrites).toBe(0)
 expect((await app.inject({method:'POST',url:'/api/auth/refresh',headers:{...browser,cookie:cookie(a)},payload:{}})).statusCode).toBe(401)
})
it.each([{status:'INACTIVE'},{role:'MANAGER'}])('real status/role mutation denies stale access and cache replay: %j',async(change)=>{
 const a=await login(),headers={...bearer(a),'idempotency-key':'auth-cache-12345'}
 expect((await app.inject({url:'/write',method:'POST',headers})).statusCode).toBe(200)
 expect((await app.inject({url:'/write',method:'POST',headers})).headers['idempotent-replay']).toBe('true')
 await state.db.user.update({where:{id:user.id},data:change})
 expect((await app.inject({url:'/read',headers:bearer(a)})).statusCode).toBe(401)
 expect((await app.inject({url:'/write',method:'POST',headers})).statusCode).toBe(401);expect(protectedWrites).toBe(1)
})
it('refresh returns tenant identity only from the verified DB user',async()=>{
 const a=await login(),out=await app.inject({method:'POST',url:'/api/auth/refresh',headers:{...browser,cookie:cookie(a)},payload:{}})
 expect(out.statusCode).toBe(200);expect(out.json().user.tenantId).toBe(tenant.id);expect(app.jwt.verify(out.json().token).sid).toBe(app.jwt.verify(a.json().token).sid)
})

it('real admin role update bumps only the affected account version and prevents old refresh renewal',async()=>{
 const a=await login({}),admin=await state.db.user.create({data:{tenantId:tenant.id,name:'周平',email:'zhou@example.test',password:await bcrypt.hash('synthetic-password',4),role:'ADMIN'}})
 const adminToken=issueSessionTokens(app.jwt,admin)
 const out=await app.inject({method:'PATCH',url:'/api/users/'+user.id,headers:{authorization:'Bearer '+adminToken.token},payload:{role:'FINANCE'}})
 expect(out.statusCode).toBe(200)
 expect((await state.db.user.findUnique({where:{id:user.id}})).authVersion).toBe(1)
 expect((await state.db.user.findUnique({where:{id:admin.id}})).authVersion).toBe(0)
 expect((await app.inject({url:'/read',headers:bearer(a)})).statusCode).toBe(401)
 expect((await app.inject({method:'POST',url:'/api/auth/refresh',payload:{token:a.json().refreshToken}})).statusCode).toBe(401)
})
it('real SQL failure rolls back both access/session revocations and cannot return successful logout',async()=>{
 const a=await login({}),original=state.db.$transaction.bind(state.db)
 const spy=vi.spyOn(state.db,'$transaction').mockImplementation((fn:any,opts:any)=>original(async(tx:any)=>fn(new Proxy(tx,{get:(target,key)=>key==='opLog'?{create:async()=>{await target.$queryRawUnsafe('SELECT 1/0')}}:typeof target[key]==='function'?target[key].bind(target):target[key]})),opts))
 try{
  const out=await app.inject({method:'POST',url:'/api/auth/logout',headers:bearer(a),payload:{refreshToken:a.json().refreshToken}})
  expect(out.statusCode).toBe(500);expect(out.headers['set-cookie']).toBeUndefined()
  expect(await state.db.revokedToken.count({where:{userId:user.id}})).toBe(0)
  expect((await app.inject({url:'/read',headers:bearer(a)})).statusCode).toBe(200)
 }finally{spy.mockRestore()}
})

it('old refresh without sid upgrades to a linked access session and logout blocks that renewed access',async()=>{
 const old=app.jwt.sign({userId:user.id,tenantId:tenant.id,jti:'legacy-'+user.id,typ:'refresh',ver:0},{expiresIn:'30d'})
 const refreshed=await app.inject({method:'POST',url:'/api/auth/refresh',payload:{token:old}})
 expect(refreshed.statusCode).toBe(200);expect(app.jwt.verify(refreshed.json().token).sid).toBe('legacy-'+user.id)
 const out=await app.inject({method:'POST',url:'/api/auth/logout',headers:{authorization:'Bearer '+refreshed.json().token},payload:{refreshToken:old}})
 expect(out.statusCode).toBe(200);expect((await app.inject({url:'/read',headers:{authorization:'Bearer '+refreshed.json().token}})).statusCode).toBe(401)
})
