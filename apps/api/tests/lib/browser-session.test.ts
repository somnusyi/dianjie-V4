import {beforeEach,afterEach,expect,it} from 'vitest'
import {vi} from 'vitest'
import {sessionPolicy,checkBrowserSession,writeBrowserCookie,readCookie,constantEqual,safeRedirectTarget} from '../../src/lib/browser-session'
beforeEach(()=>{vi.stubEnv('BROWSER_SESSION_ENV','production');vi.stubEnv('BROWSER_SESSION_ORIGINS','https://app.example.test,http://localhost:3201,http://116.62.32.162:8085');vi.stubEnv('BROWSER_SESSION_ALLOW_LOCAL_HTTP','true');vi.stubEnv('NODE_ENV','test')})
afterEach(()=>vi.unstubAllEnvs())
it('isolates cookie names and uses host-only HttpOnly Secure cookies',()=>{
 const headers:any={};writeBrowserCookie({header:(k:string,v:any)=>headers[k]=v},'https://app.example.test','refreshName','synthetic-refresh',30)
 expect(headers['set-cookie']).toContain('__Host-dj_production_refresh=');expect(headers['set-cookie']).toContain('HttpOnly');expect(headers['set-cookie']).toContain('Secure');expect(headers['set-cookie']).not.toContain('Domain=')
 vi.stubEnv('BROWSER_SESSION_ENV','uat');expect(sessionPolicy('https://app.example.test').refreshName).toBe('__Host-dj_uat_refresh')
})
it('refuses public plaintext transport, missing/foreign/null origins and cross-site fetch',()=>{
 for(const origin of [undefined,'null','https://evil.test','http://116.62.32.162:8085'])expect(()=>sessionPolicy(origin)).toThrow('浏览器会话')
 expect(()=>checkBrowserSession({headers:{origin:'https://app.example.test','sec-fetch-site':'cross-site'}})).toThrow()
 expect(()=>sessionPolicy('https://app.example.test/path')).toThrow()
})
it('permits explicit localhost development HTTP only, never production',()=>{
 expect(sessionPolicy('http://localhost:3201').secure).toBe(false);vi.stubEnv('NODE_ENV','production');expect(()=>sessionPolicy('http://localhost:3201')).toThrow()
})
it('rejects cookie pollution, compares nonce safely, and blocks scheme-relative/backslash redirects',()=>{
 expect(readCookie({headers:{cookie:'x=a; x=b'}},'x')).toBeNull();expect(constantEqual('nonce','other')).toBe(false);expect(constantEqual('nonce','nonce')).toBe(true)
 expect(safeRedirectTarget('//evil.test','https://app.example.test')).toBe('/');expect(safeRedirectTarget('/\\evil.test','https://app.example.test')).toBe('/');expect(safeRedirectTarget('/v2/me','https://app.example.test')).toBe('/v2/me')
})
