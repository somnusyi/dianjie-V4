import {beforeEach,afterEach,expect,it,vi} from 'vitest'
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import {wecomRoutes} from '../../src/routes/wecom'
const {db,exchange}=vi.hoisted(()=>({db:{tenant:{findUnique:vi.fn()},weComConfig:{findUnique:vi.fn()},user:{findUnique:vi.fn(),update:vi.fn()},weComSyncLog:{create:vi.fn()},$queryRaw:vi.fn()},exchange:vi.fn()}))
vi.mock('@dianjie/db',()=>({prisma:db}))
vi.mock('../../src/services/wecom',()=>({exchangeOAuthCode:exchange,getUserInfo:vi.fn(),sendAppMsg:vi.fn(),getContactToken:vi.fn()}))
let app:any
const origin='https://app.example.test'
beforeEach(async()=>{
 vi.resetAllMocks();let sequence=0n;db.$queryRaw.mockImplementation(async(...args:any[])=>[{value:args[1]===false?sequence:++sequence,issuedAtMs:BigInt(Date.now()),legacyExpiresAtMs:BigInt(Date.now()+2592000000),rollback:false}]);vi.stubEnv('BROWSER_SESSION_ENV','test');vi.stubEnv('BROWSER_SESSION_ORIGINS',origin);vi.stubEnv('WECOM_REDIRECT_BASE',origin)
 db.tenant.findUnique.mockResolvedValue({id:'t',status:'ACTIVE'});db.weComConfig.findUnique.mockResolvedValue({enabled:true,corpId:'corp',agentId:'1'});db.user.findUnique.mockResolvedValue({id:'u',tenantId:'t',name:'Test',role:'SUPPLY_CHAIN',status:'ACTIVE',authVersion:0,storeIds:[]});db.user.update.mockResolvedValue({});db.weComSyncLog.create.mockResolvedValue({});exchange.mockResolvedValue({wecomUserId:'wx'})
 app=Fastify();await app.register(jwt,{secret:'synthetic-test-key-not-production'});app.decorate('authenticate',async(req:any)=>{await req.jwtVerify()});await app.register(wecomRoutes,{prefix:'/api/wecom'});await app.ready()
})
afterEach(async()=>{await app.close();vi.unstubAllEnvs()})
async function begin(){return app.inject({method:'GET',url:'/api/wecom/oauth/url?tenant=dianjie&redirect=/v2/me',headers:{origin,'x-dianjie-session':'cookie-v1'}})}
it('sets nonce cookie and never places login bearer or user details in redirect URL',async()=>{
 const res=await begin();expect(res.statusCode).toBe(200);const state=new URL(res.json().url).searchParams.get('state')!;const cookie=String(res.headers['set-cookie']).split(';')[0]
 const finish=await app.inject({method:'GET',url:'/api/wecom/oauth/callback?code=synthetic-code&state='+encodeURIComponent(state),headers:{cookie}})
 expect(finish.statusCode).toBe(302);expect(finish.headers.location).toBe(origin+'/v2/wecom-bridge?redirect=%2Fv2%2Fme');expect(String(finish.headers.location)).not.toContain('token');expect(String(finish.headers['set-cookie'])).toContain('__Host-dj_test_refresh_s_');expect(String(finish.headers['set-cookie'])).toContain('HttpOnly')
})
it('rejects callback without matching browser nonce before provider exchange',async()=>{
 const res=await begin();const state=new URL(res.json().url).searchParams.get('state')!;const finish=await app.inject({method:'GET',url:'/api/wecom/oauth/callback?code=synthetic-code&state='+encodeURIComponent(state)})
 expect(finish.statusCode).toBe(403);expect(exchange).not.toHaveBeenCalled()
})
it('requires a canonical matching origin rather than planting cross-host cookies',async()=>{
 vi.stubEnv('BROWSER_SESSION_ORIGINS',origin+',https://other.example.test')
 const res=await app.inject({method:'GET',url:'/api/wecom/oauth/url?tenant=dianjie',headers:{origin:'https://other.example.test'}});expect(res.statusCode).toBe(403)
})

it('late OAuth callback retains its signed start order and cannot clear newer login cookies',async()=>{
 const start=await begin();const state=new URL(start.json().url).searchParams.get('state')!;const nonceCookie=String(start.headers['set-cookie']).split(';')[0]
 const fresh=app.jwt.sign({typ:'refresh',sid:'newer-password',jti:'newer-password',userId:'u',tenantId:'t',bso:'999'})
 const finish=await app.inject({method:'GET',url:'/api/wecom/oauth/callback?code=synthetic-code&state='+encodeURIComponent(state),headers:{cookie:nonceCookie+'; __Host-dj_test_refresh_s_newer-password='+fresh}})
 expect(finish.statusCode).toBe(302);const cookies=[finish.headers['set-cookie']].flat() as string[]
 expect(cookies.some(c=>c.startsWith('__Host-dj_test_refresh_s_newer-password='))).toBe(false)
 const issued=cookies.find(c=>c.startsWith('__Host-dj_test_refresh_s_'))!;const rt=decodeURIComponent(issued.split(';')[0].split('=')[1]);expect(app.jwt.verify(rt).bso).toBe('1')
})
it('keeps the already-issued legacy fixed nonce callback compatible at lower priority zero',async()=>{
 const nonce='legacy_nonce',state='dianjie|/v2/me|'+nonce
 const finish=await app.inject({method:'GET',url:'/api/wecom/oauth/callback?code=synthetic-code&state='+encodeURIComponent(state),headers:{cookie:'__Host-dj_test_oauth='+nonce}})
 expect(finish.statusCode).toBe(302);const issued=([finish.headers['set-cookie']].flat() as string[]).find(c=>c.startsWith('__Host-dj_test_refresh_s_'))!;expect(app.jwt.verify(decodeURIComponent(issued.split(';')[0].split('=')[1])).bso).toBe('0')
})

it('freezes OAuth expiry at signed start time rather than delayed callback completion',async()=>{
 const start=await begin(),state=new URL(start.json().url).searchParams.get('state')!,nonceCookie=String(start.headers['set-cookie']).split(';')[0]
 const intent=app.jwt.verify(decodeURIComponent(nonceCookie.split('=')[1])),startMs=Number(intent.bia)
 db.$queryRaw.mockResolvedValue([{value:2n,issuedAtMs:BigInt(startMs+120000),legacyExpiresAtMs:BigInt(startMs+2592000000),rollback:false}])
 const finish=await app.inject({method:'GET',url:'/api/wecom/oauth/callback?code=synthetic-code&state='+encodeURIComponent(state),headers:{cookie:nonceCookie}});expect(finish.statusCode).toBe(302)
 const issued=([finish.headers['set-cookie']].flat() as string[]).find(c=>c.startsWith('__Host-dj_test_refresh_s_'))!
 expect(app.jwt.verify(decodeURIComponent(issued.split(';')[0].split('=')[1])).exp).toBe(Math.floor((startMs+2592000000)/1000))
 expect(issued).toContain('Max-Age=2591880')
})

it('rejects named OAuth intent after ten minutes on the DB clock before exchanging provider code',async()=>{
 const start=await begin(),state=new URL(start.json().url).searchParams.get('state')!,nonceCookie=String(start.headers['set-cookie']).split(';')[0]
 const intent=app.jwt.verify(decodeURIComponent(nonceCookie.split('=')[1])),startMs=Number(intent.bia)
 db.$queryRaw.mockResolvedValue([{value:2n,issuedAtMs:BigInt(startMs+600001),legacyExpiresAtMs:BigInt(startMs+2592000000),rollback:false}])
 const finish=await app.inject({method:'GET',url:'/api/wecom/oauth/callback?code=synthetic-code&state='+encodeURIComponent(state),headers:{cookie:nonceCookie}});expect(finish.statusCode).toBe(403);expect(exchange).not.toHaveBeenCalled()
})
it('rechecks the DB nonce deadline after a slow provider response before issuing session tokens',async()=>{
 const start=await begin(),state=new URL(start.json().url).searchParams.get('state')!,nonceCookie=String(start.headers['set-cookie']).split(';')[0]
 const intent=app.jwt.verify(decodeURIComponent(nonceCookie.split('=')[1])),startMs=Number(intent.bia)
 db.$queryRaw.mockResolvedValueOnce([{value:2n,issuedAtMs:BigInt(startMs+1000),legacyExpiresAtMs:BigInt(startMs+2592000000),rollback:false}]).mockResolvedValueOnce([{value:2n,issuedAtMs:BigInt(startMs+600001),legacyExpiresAtMs:BigInt(startMs+2592000000),rollback:false}])
 const finish=await app.inject({method:'GET',url:'/api/wecom/oauth/callback?code=synthetic-code&state='+encodeURIComponent(state),headers:{cookie:nonceCookie}});expect(finish.statusCode).toBe(403);expect(exchange).toHaveBeenCalledOnce();expect(String(finish.headers['set-cookie'])).not.toContain('refresh_s_')
})
