import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import jwtPlugin from '@fastify/jwt'
import { sessionPolicy, readBrowserRefresh, writeBrowserRefresh, writeBrowserOAuthIntent, readBrowserOAuthIntent, clearBrowserOAuthIntent } from '../../src/lib/browser-session'
const app=Fastify(); const origin='https://app.example.test'; const secret='isolated-cookie-order-fixture-secret-32chars'
beforeAll(async()=>{await app.register(jwtPlugin,{secret});await app.ready()})
beforeEach(()=>{vi.stubEnv('BROWSER_SESSION_ENV','production');vi.stubEnv('BROWSER_SESSION_ORIGINS',origin)})
afterEach(()=>vi.unstubAllEnvs())
const token=(sid:string,bso?:string,extra:any={})=>app.jwt.sign({typ:'refresh',jti:sid,sid,userId:'fixture-user',tenantId:'fixture-tenant',...(bso===undefined?{}:{bso}),...extra})
const prefix=()=>sessionPolicy(origin).refreshName
const req=(cookie:string)=>({method:'POST',headers:{origin,cookie,'sec-fetch-site':'same-origin'}})
const named=(sid:string,value:string)=>`${prefix()}_s_${sid}=${encodeURIComponent(value)}`
function reply(){let h:any={};return {h,header:(k:string,v:any)=>{h[k]=v},getHeader:(k:string)=>h[k]}}
function apply(jar:Map<string,string>,reply:any){for(const line of [reply.h['set-cookie']].flat().filter(Boolean)){const pair=line.split(';')[0];const at=pair.indexOf('=');if(line.includes('Max-Age=0;')||line.endsWith('Max-Age=0'))jar.delete(pair.slice(0,at));else jar.set(pair.slice(0,at),pair.slice(at+1))}}
const header=(jar:Map<string,string>)=>[...jar].map(([k,v])=>`${k}=${v}`).join('; ')
it('late legacy upgrade cannot overwrite a newer login cookie',()=>{
 const old=token('old'),fresh=token('fresh','2'),jar=new Map<string,string>();const late=reply(),login=reply();writeBrowserRefresh(req(''),late,origin,old,app.jwt,1000);writeBrowserRefresh(req(''),login,origin,fresh,app.jwt,1000);apply(jar,login);apply(jar,late);expect(readBrowserRefresh(req(header(jar)),app.jwt)).toBe(fresh)
})
it('same-second and values beyond Number precision use signed bigint issuance order',()=>{const first=token('a','9007199254740992'),last=token('b','9007199254740993');expect(readBrowserRefresh(req(named('a',first)+'; '+named('b',last)),app.jwt)).toBe(last)})
it('cookie header order does not choose the active account',()=>{const a=token('a','1'),b=token('b','2');expect(readBrowserRefresh(req(named('b',b)+'; '+named('a',a)),app.jwt)).toBe(b)})
it('newest signed session stays selected when revoked; caller must reject, never fallback',()=>{const a=token('a','1'),b=token('b','2');const selected=readBrowserRefresh(req(named('a',a)+'; '+named('b',b)),app.jwt);expect(selected).toBe(b);expect(app.jwt.verify<any>(selected!).sid).toBe('b')})
it('newest expired session is still selected and normal verification rejects it',()=>{const a=token('a','1'),b=token('b','2',{exp:Math.floor(Date.now()/1000)-60});const selected=readBrowserRefresh(req(named('a',a)+'; '+named('b',b)),app.jwt);expect(selected).toBe(b);expect(()=>app.jwt.verify(selected!)).toThrow()})
it('unsigned high order, wrong token type and mismatched sid names cannot win',()=>{const a=token('a','1'),wrong=token('bad','999',{typ:'access'});expect(readBrowserRefresh(req(named('a',a)+'; '+named('fake',wrong)+'; '+named('evil','ey.invalid')),app.jwt)).toBe(a)})
it('fixed old cookie remains readable until migrated, but cannot override a new named session',()=>{const a=token('a'),b=token('b','1');expect(readBrowserRefresh(req(`${prefix()}=${a}`),app.jwt)).toBe(a);expect(readBrowserRefresh(req(`${prefix()}=${a}; ${named('b',b)}`),app.jwt)).toBe(b)})
it('new login removes older visible cookies and stays host-only HttpOnly Secure',()=>{const old=token('a','1'),fresh=token('b','2'),r=reply();writeBrowserRefresh(req(named('a',old)),r,origin,fresh,app.jwt,1000);expect(r.h['set-cookie'][0]).toContain('Max-Age=0');const last=r.h['set-cookie'].at(-1);expect(last).toContain('__Host-dj_production_refresh_s_b=');expect(last).toContain('HttpOnly');expect(last).toContain('Secure');expect(last).not.toContain('Domain=')})
it('late OAuth callback cannot clear or replace a newer password login',()=>{const fresh=token('fresh','3'),oauth=token('oauth','2'),jar=new Map<string,string>([[`${prefix()}_s_fresh`,fresh]]),r=reply();writeBrowserRefresh(req(header(jar)),r,origin,oauth,app.jwt,1000);apply(jar,r);expect(jar.has(`${prefix()}_s_fresh`)).toBe(true);expect(readBrowserRefresh(req(header(jar)),app.jwt)).toBe(fresh)})
it('OAuth issue order is signed into a nonce-specific cookie, and clearing only touches that intent',()=>{const nonce='synthetic_nonce',intent=app.jwt.sign({typ:'browser-oauth',nonce,bso:'5',tenant:'demo',redirect:'/'}),r=reply();writeBrowserOAuthIntent(req(''),r,origin,intent,nonce,app.jwt);const pair=r.h['set-cookie'].split(';')[0];expect(readBrowserOAuthIntent(req(pair),origin,nonce,app.jwt).bso).toBe('5');expect(readBrowserOAuthIntent(req(pair),origin,'other',app.jwt)).toBeNull();const clear=reply();clearBrowserOAuthIntent(clear,origin,nonce);expect(clear.h['set-cookie']).toContain(`oauth_s_${nonce}=`);expect(clear.h['set-cookie']).not.toContain('refresh')})
it('environment prefixes prevent UAT cookies being selected in production',()=>{const a=token('a','1');expect(readBrowserRefresh(req(`__Host-dj_uat_refresh_s_a=${a}`),app.jwt)).toBeNull()})
it('duplicate recognized cookies and excessive counts or bytes fail closed',()=>{const a=token('a','1');expect(()=>readBrowserRefresh(req(named('a',a)+'; '+named('a',a)),app.jwt)).toThrow();expect(()=>readBrowserRefresh(req(Array.from({length:17},(_,i)=>named('x'+i,a)).join('; ')),app.jwt)).toThrow();expect(()=>readBrowserRefresh(req(named('x','x'.repeat(17000))),app.jwt)).toThrow()})
it('refresh cannot read foreign-origin cookies even if the JWT is valid',()=>{const r=req(named('a',token('a','1')));r.headers.origin='https://foreign.test';expect(()=>readBrowserRefresh(r,app.jwt)).toThrow()})
