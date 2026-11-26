import {beforeEach,afterEach,it,expect,vi} from 'vitest'
class MemoryStorage {values=new Map<string,string>();events:string[]=[];getItem(k:string){return this.values.get(k)||null}setItem(k:string,v:string){this.values.set(k,String(v));if(k==='dj:session-event')this.events.push(String(v))}removeItem(k:string){this.values.delete(k)}}
let local:MemoryStorage
beforeEach(()=>{vi.resetModules();local=new MemoryStorage();vi.stubGlobal('window',{});vi.stubGlobal('localStorage',local);vi.stubGlobal('sessionStorage',new MemoryStorage());vi.stubGlobal('location',{pathname:'/v2/login',href:'/v2/login'});vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('offline')))})
afterEach(()=>{vi.unstubAllGlobals()})
it('pending logout bootstrap retries must not create another cross-tab logout event',async()=>{
 let auth=await import('../src/lib/v2-auth');await auth.logoutSession().catch(()=>{});expect(local.events).toHaveLength(1);expect(local.getItem('dj:logout-pending')).toBe('1')
 for(let i=0;i<3;i++){vi.resetModules();auth=await import('../src/lib/v2-auth');await auth.bootstrapSession()}
 expect(local.events).toHaveLength(1);expect(local.getItem('dj:logout-pending')).toBe('1');expect(auth.getToken()).toBeNull()
})
it('a later fresh logout still broadcasts after the earlier pending logout has completed',async()=>{
 const auth=await import('../src/lib/v2-auth');vi.mocked(fetch).mockResolvedValue(new Response('{}',{status:200}));await auth.logoutSession();expect(local.getItem('dj:logout-pending')).toBeNull();await auth.logoutSession();expect(local.events).toHaveLength(2)
})
