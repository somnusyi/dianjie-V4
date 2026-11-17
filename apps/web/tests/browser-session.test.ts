import {beforeEach,afterEach,expect,it,vi} from 'vitest'
class MemoryStorage {values=new Map<string,string>();getItem(k:string){return this.values.get(k)||null}setItem(k:string,v:string){this.values.set(k,String(v))}removeItem(k:string){this.values.delete(k)}}
let local:MemoryStorage,session:MemoryStorage
beforeEach(()=>{vi.resetModules();local=new MemoryStorage();session=new MemoryStorage();vi.stubGlobal('window',{});vi.stubGlobal('localStorage',local);vi.stubGlobal('sessionStorage',session);vi.stubGlobal('location',{pathname:'/v2/login',href:'/v2/login'});vi.stubGlobal('fetch',vi.fn())})
afterEach(()=>{vi.unstubAllGlobals()})
const user={id:'u',role:'SUPPLY_CHAIN',name:'Test',email:'a@example.test'}
it('keeps bearer only in memory and erases every legacy persistent alias',async()=>{
 const auth=await import('../src/lib/v2-auth');for(const key of ['token','dj_token','refreshToken','dj_refresh']){local.setItem(key,'synthetic-old');session.setItem(key,'synthetic-old')}
 auth.setSession('synthetic-access',user,{},'synthetic-refresh');expect(auth.getToken()).toBe('synthetic-access');expect(auth.getRefreshToken()).toBeNull()
 for(const key of ['token','dj_token','refreshToken','dj_refresh']){expect(local.getItem(key)).toBeNull();expect(session.getItem(key)).toBeNull()}
 expect(JSON.stringify([...local.values])).not.toContain('synthetic-access');expect(JSON.stringify([...local.values])).not.toContain('synthetic-refresh')
})
it('one-time upgrades legacy refresh and coalesces bootstrap before child guards read memory',async()=>{
 const auth=await import('../src/lib/v2-auth');local.setItem('dj_refresh','synthetic-legacy');let resolve:any;vi.mocked(fetch).mockReturnValue(new Promise(r=>{resolve=r}))
 const a=auth.bootstrapSession(),b=auth.bootstrapSession();expect(fetch).toHaveBeenCalledTimes(1);expect(local.getItem('dj_refresh')).toBeNull()
 expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toEqual({token:'synthetic-legacy'})
 resolve({ok:true,json:async()=>({token:'synthetic-access',user})});expect(await a).toBe('synthetic-access');expect(await b).toBe('synthetic-access');expect(auth.getToken()).toBe('synthetic-access')
})
it('reload restores from cookie without reading or writing refresh to browser storage',async()=>{
 vi.mocked(fetch).mockResolvedValue({ok:true,json:async()=>({token:'synthetic-access',user})}as any)
 const auth=await import('../src/lib/v2-auth');expect(await auth.bootstrapSession()).toBe('synthetic-access');expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({credentials:'same-origin',body:'{}',headers:{'X-Dianjie-Session':'cookie-v1'}})
 expect(auth.getRefreshToken()).toBeNull();expect(local.getItem('refreshToken')).toBeNull()
})
it('does not resurrect memory from a refresh finishing after logout',async()=>{
 const auth=await import('../src/lib/v2-auth');auth.setSession('synthetic-access',user);let resolve:any;vi.mocked(fetch).mockReturnValueOnce(new Promise(r=>{resolve=r}));const refresh=auth.refreshAccessOnce();vi.mocked(fetch).mockResolvedValueOnce({ok:true}as any);await auth.logoutSession();resolve({ok:true,json:async()=>({token:'synthetic-stale',user})});expect(await refresh).toBeNull();expect(auth.getToken()).toBeNull()
})
it('keeps failed logout pending across reload, preventing automatic cookie sign-in',async()=>{
 let auth=await import('../src/lib/v2-auth');auth.setSession('synthetic-access',user);vi.mocked(fetch).mockRejectedValue(new Error('offline'));await expect(auth.logoutSession()).rejects.toThrow('offline');expect(local.getItem('dj:logout-pending')).toBe('1')
 vi.resetModules();auth=await import('../src/lib/v2-auth');expect(await auth.bootstrapSession()).toBeNull();expect(auth.getToken()).toBeNull();expect(vi.mocked(fetch).mock.calls.every(c=>c[0]==='/api/auth/browser-logout')).toBe(true)
})
it('waits for logout completion before sending a new login',async()=>{
 const auth=await import('../src/lib/v2-auth');auth.setSession('synthetic-access',user);let resolve:any;vi.mocked(fetch).mockReturnValueOnce(new Promise(r=>{resolve=r}));const out=auth.logoutSession();const login=auth.browserLogin('/api/auth/login',{password:'synthetic-password'});expect(fetch).toHaveBeenCalledTimes(1);vi.mocked(fetch).mockResolvedValueOnce({ok:true}as any);resolve({ok:true});await out;await login;expect(vi.mocked(fetch).mock.calls[1][0]).toBe('/api/auth/login')
})
