import {beforeEach,afterEach,expect,it,vi} from 'vitest'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import bcrypt from 'bcryptjs'
import {authRoutes} from '../../src/routes/auth'
const {db}=vi.hoisted(()=>({db:{tenant:{findUnique:vi.fn()},user:{findUnique:vi.fn(),findFirst:vi.fn(),update:vi.fn()},store:{findMany:vi.fn()},opLog:{create:vi.fn()},revokedToken:{findUnique:vi.fn(),upsert:vi.fn()},$queryRaw:vi.fn(),$transaction:vi.fn()}}))
vi.mock('@dianjie/db',()=>({prisma:db}))
let user:any,revoked:Set<string>,app:any
const origin='https://app.example.test'
const browser={'x-dianjie-session':'cookie-v1',origin,'sec-fetch-site':'same-origin'}
beforeEach(async()=>{
 vi.stubEnv('BROWSER_SESSION_ENV','test');vi.stubEnv('BROWSER_SESSION_ORIGINS',origin);vi.stubEnv('PREVIEW_TENANT_SLUG','');vi.stubEnv('NODE_ENV','test')
 vi.resetAllMocks();let sequence=0n;db.$queryRaw.mockImplementation(async(...args:any[])=>[{value:args[1]===false?sequence:++sequence,issuedAtMs:BigInt(Date.now()),legacyExpiresAtMs:BigInt(Date.now()+2592000000),rollback:false}]);revoked=new Set();user={id:'u',tenantId:'t',name:'Test',email:'a@example.test',role:'SUPPLY_CHAIN',status:'ACTIVE',password:await bcrypt.hash('synthetic-password',4),authVersion:0,storeIds:[],storeId:null,tenant:{status:'ACTIVE'}}
 db.tenant.findUnique.mockResolvedValue({id:'t',slug:'dianjie',name:'Test',status:'ACTIVE'});db.user.findUnique.mockImplementation(async()=>user);db.user.findFirst.mockImplementation(async()=>user);db.user.update.mockResolvedValue(user);db.store.findMany.mockResolvedValue([]);db.opLog.create.mockResolvedValue({});db.$transaction.mockImplementation(async(ops:any)=>{const before=new Set(revoked);try{return typeof ops==='function'?await ops(db):await Promise.all(ops)}catch(e){revoked=before;throw e}});db.revokedToken.findUnique.mockImplementation(async({where}:any)=>revoked.has(where.jti)?{}:null);db.revokedToken.upsert.mockImplementation(async({where}:any)=>{revoked.add(where.jti);return{}})
 app=Fastify();await app.register(jwt,{secret:'synthetic-test-key-that-is-not-a-real-secret'});app.decorate('authenticate',async(req:any)=>{await req.jwtVerify()});await app.register(authRoutes,{prefix:'/api/auth'});await app.ready()
})
afterEach(async()=>{await app.close();vi.unstubAllEnvs()})
const payload={identifier:'a@example.test',password:'synthetic-password'}
async function login(headers:any=browser){return app.inject({method:'POST',url:'/api/auth/login',headers,payload})}
const cookie=(res:any)=>String(res.headers['set-cookie']).split(';')[0]
it('browser login omits refresh body, restores from HttpOnly cookie, keeps legacy JSON clients working',async()=>{
 const res=await login();expect(res.statusCode).toBe(200);expect(res.json().refreshToken).toBeUndefined();expect(String(res.headers['set-cookie'])).toContain('HttpOnly')
 const refreshed=await app.inject({method:'POST',url:'/api/auth/refresh',headers:{...browser,cookie:cookie(res)},payload:{}});expect(refreshed.statusCode).toBe(200);expect(refreshed.json().token).toBeTruthy();expect(refreshed.json().refreshToken).toBeUndefined()
 const legacy=await login({});expect(legacy.json().refreshToken).toBeTruthy();const oldRefresh=await app.inject({method:'POST',url:'/api/auth/refresh',payload:{token:legacy.json().refreshToken}});expect(oldRefresh.statusCode).toBe(200)
})
it('blocks CSRF and invalid browser transport configuration before touching credentials',async()=>{
 const res=await login();const bad=await app.inject({method:'POST',url:'/api/auth/refresh',headers:{...browser,origin:'https://evil.test',cookie:cookie(res)},payload:{}});expect(bad.statusCode).toBe(403)
 const missing=await login({'x-dianjie-session':'cookie-v1'});expect(missing.statusCode).toBe(403)
})
it('upgrades old refresh into cookie without extending its expiration',async()=>{
 const old=await login({});const res=await app.inject({method:'POST',url:'/api/auth/refresh',headers:browser,payload:{token:old.json().refreshToken}});expect(res.statusCode).toBe(200);expect(String(res.headers['set-cookie'])).toContain('Max-Age=');expect(res.json().refreshToken).toBeUndefined()
})
it('cookie logout revokes refresh without clearing a newer cookie',async()=>{
 const res=await login();const out=await app.inject({method:'POST',url:'/api/auth/browser-logout',headers:{...browser,cookie:cookie(res)},payload:{}});expect(out.statusCode).toBe(200);expect(out.headers['set-cookie']).toBeUndefined()
 const again=await app.inject({method:'POST',url:'/api/auth/refresh',headers:{...browser,cookie:cookie(res)},payload:{}});expect(again.statusCode).toBe(401)
})
it('retains disabled account and auth-version revocation checks',async()=>{
 const res=await login();user.authVersion=1
 expect((await app.inject({method:'POST',url:'/api/auth/refresh',headers:{...browser,cookie:cookie(res)},payload:{}})).statusCode).toBe(401)
 user.authVersion=0;user.status='DISABLED';expect((await app.inject({method:'POST',url:'/api/auth/refresh',headers:{...browser,cookie:cookie(res)},payload:{}})).statusCode).toBe(401)
})
it('does not claim logout success when revocation persistence fails',async()=>{
 const res=await login();db.revokedToken.upsert.mockRejectedValue(new Error('synthetic-db-failure'))
 const out=await app.inject({method:'POST',url:'/api/auth/browser-logout',headers:{...browser,cookie:cookie(res)},payload:{}});expect(out.statusCode).toBe(500);expect(out.headers['set-cookie']).toBeUndefined()
})

it('selects newest sid then rejects revoked newest without falling back to the previous account',async()=>{
 const first=await login(),second=await login();const both=cookie(first)+'; '+cookie(second)
 const out=await app.inject({method:'POST',url:'/api/auth/browser-logout',headers:{...browser,cookie:both},payload:{}});expect(out.statusCode).toBe(200);expect(out.headers['set-cookie']).toBeUndefined()
 const again=await app.inject({method:'POST',url:'/api/auth/refresh',headers:{...browser,cookie:both},payload:{}});expect(again.statusCode).toBe(401)
 const firstOnly=await app.inject({method:'POST',url:'/api/auth/refresh',headers:{...browser,cookie:cookie(first)},payload:{}});expect(firstOnly.statusCode).toBe(200)
})
it('late legacy upgrade uses its own sid cookie and cannot delete a newer login',async()=>{
 const legacy=await login({}),fresh=await login();const upgrade=await app.inject({method:'POST',url:'/api/auth/refresh',headers:{...browser,cookie:cookie(fresh)},payload:{token:legacy.json().refreshToken}})
 // When a browser already carries a session, a stale body token cannot select another account.
 expect(upgrade.statusCode).toBe(200);const value=String(upgrade.headers['set-cookie']);expect(value).not.toContain('Max-Age=0');expect(value).toContain(cookie(fresh))
})

it('sequence failures stop browser issuance but preserve explicit legacy API login compatibility',async()=>{
 db.$queryRaw.mockRejectedValue(new Error('synthetic-sequence-unavailable'))
 const stopped=await login();expect(stopped.statusCode).toBe(500);expect(stopped.headers['set-cookie']).toBeUndefined();expect(db.opLog.create).not.toHaveBeenCalled()
 const legacy=await login({});expect(legacy.statusCode).toBe(200);expect(legacy.json().refreshToken).toBeTruthy()
})

it('freezes login expiration at request intent and does not extend it on refresh',async()=>{
 const start=Date.now();let issued=false
 db.$queryRaw.mockImplementation(async(_sql:any,issue:boolean)=>[{value:1n,issuedAtMs:BigInt(issue?(issued=true,start):start+120000),legacyExpiresAtMs:BigInt(start+2592000000),rollback:false}])
 const res=await login();expect(issued).toBe(true);expect(res.statusCode).toBe(200)
 const rt=decodeURIComponent(cookie(res).split('=')[1]),claims=app.jwt.verify(rt);expect(claims.exp).toBe(Math.floor((start+2592000000)/1000));expect(Number(claims.bia)).toBe(start)
 const refreshed=await app.inject({method:'POST',url:'/api/auth/refresh',headers:{...browser,cookie:cookie(res)},payload:{}});expect(refreshed.statusCode).toBe(200)
 expect(app.jwt.verify(decodeURIComponent(cookie(refreshed).split('=')[1])).exp).toBe(claims.exp)
})
it('caps old legacy expiration to deployment window so lower-priority cookies cannot outlive new sessions',async()=>{
 const now=Date.now(),cutoff=now+100000
 const rt=app.jwt.sign({typ:'refresh',jti:'legacy-clock-ahead',userId:'u',tenantId:'t',ver:0,exp:Math.floor(now/1000)+2592000})
 db.$queryRaw.mockResolvedValue([{value:1n,issuedAtMs:BigInt(now),legacyExpiresAtMs:BigInt(cutoff),rollback:false}])
 const upgraded=await app.inject({method:'POST',url:'/api/auth/refresh',headers:browser,payload:{token:rt}});expect(upgraded.statusCode).toBe(200)
 const claims=app.jwt.verify(decodeURIComponent(cookie(upgraded).split('=')[1]));expect(claims.exp).toBe(Math.floor(cutoff/1000));expect(claims.bso).toBe('0')
 db.$queryRaw.mockResolvedValue([{value:1n,issuedAtMs:BigInt(cutoff+1),legacyExpiresAtMs:BigInt(cutoff),rollback:false}])
 const expired=await app.inject({method:'POST',url:'/api/auth/refresh',headers:{...browser,cookie:cookie(upgraded)},payload:{}});expect(expired.statusCode).toBe(401)
})
it('refuses issuance on detected DB clock rollback without falling back to a client clock',async()=>{
 db.$queryRaw.mockResolvedValue([{value:1n,issuedAtMs:BigInt(Date.now()),legacyExpiresAtMs:BigInt(Date.now()+2592000000),rollback:true}])
 const res=await login();expect(res.statusCode).toBe(503);expect(res.headers['set-cookie']).toBeUndefined()
})
