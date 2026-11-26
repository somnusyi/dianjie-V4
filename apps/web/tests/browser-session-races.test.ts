import { beforeEach, afterEach, it, expect, vi } from 'vitest'
class MemoryStorage { values=new Map<string,string>(); getItem(k:string){return this.values.get(k)||null} setItem(k:string,v:string){this.values.set(k,String(v))} removeItem(k:string){this.values.delete(k)} }
beforeEach(()=>{vi.resetModules();vi.stubGlobal('window',{});vi.stubGlobal('localStorage',new MemoryStorage());vi.stubGlobal('sessionStorage',new MemoryStorage());vi.stubGlobal('location',{pathname:'/v2/supply-chain/home',href:'/v2/supply-chain/home'});vi.stubGlobal('fetch',vi.fn())})
afterEach(()=>{vi.unstubAllGlobals()})
const user=(id:string)=>({id,name:id,email:id+'@local.invalid',role:'SUPPLY_CHAIN'})
const expired=()=>new Response(JSON.stringify({message:'jwt expired'}),{status:401,headers:{'content-type':'application/json'}})
it('must preserve a new login when an old in-flight refresh is discarded',async()=>{
 const auth=await import('../src/lib/v2-auth');auth.setSession('old-access',user('old'))
 let release:any;let refreshing:any;const started=new Promise(r=>refreshing=r)
 vi.mocked(fetch).mockResolvedValueOnce(expired()).mockImplementationOnce(()=>{refreshing();return new Promise(r=>release=r)})
 const req=auth.apiFetch('/api/private');const caught=req.catch(e=>e);await started
 auth.setSession('new-access',user('new'))
 release(new Response(JSON.stringify({token:'stale-access',user:user('old')}),{status:200}))
 await caught
 expect(auth.getToken()).toBe('new-access')
 expect(auth.getUser()?.id).toBe('new')
})
it('must not replay an old write using another users freshly refreshed session',async()=>{
 const auth=await import('../src/lib/v2-auth');auth.setSession('old-access',user('old'))
 let release:any;vi.mocked(fetch).mockImplementationOnce(()=>new Promise(r=>release=r))
 const req=auth.apiFetch('/api/purchase-order/action',{method:'PATCH',body:JSON.stringify({quantity:5})});const caught=req.catch(e=>e)
 auth.setSession('new-access',user('new'))
 vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({token:'new-refreshed',user:user('new')}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({success:true}),{status:200}))
 release(expired());await caught
 expect(fetch).toHaveBeenCalledTimes(1)
})

it('download must preserve a new session after its stale refresh is discarded',async()=>{
 const auth=await import('../src/lib/v2-auth');auth.setSession('old-access',user('old'))
 let release:any;let refreshing:any;const started=new Promise(r=>refreshing=r)
 vi.mocked(fetch).mockResolvedValueOnce(expired()).mockImplementationOnce(()=>{refreshing();return new Promise(r=>release=r)})
 const req=auth.apiDownload('/api/export','data.csv');const caught=req.catch(e=>e);await started
 auth.setSession('new-access',user('new'));release(new Response(JSON.stringify({token:'stale-access',user:user('old')}),{status:200}))
 expect((await caught).code).toBe('SESSION_CHANGED');expect(auth.getToken()).toBe('new-access')
})
it('download must not retry under a newly logged-in account',async()=>{
 const auth=await import('../src/lib/v2-auth');auth.setSession('old-access',user('old'))
 let release:any;vi.mocked(fetch).mockImplementationOnce(()=>new Promise(r=>release=r))
 const req=auth.apiDownload('/api/export','data.csv');const caught=req.catch(e=>e)
 auth.setSession('new-access',user('new'));release(expired());expect((await caught).code).toBe('SESSION_CHANGED');expect(fetch).toHaveBeenCalledTimes(1)
})
it('legacy axios must not replay a stale write using a new account',async()=>{
 const auth=await import('../src/lib/v2-auth');auth.setSession('old-access',user('old'));const api=(await import('../src/lib/api')).default
 let release:any;let begin:any;const begun=new Promise(r=>begin=r);const adapter=vi.fn((config:any)=>{begin();return new Promise<never>((_r,j)=>release=()=>j({config,response:{status:401}}))})
 const req=api.patch('/api/purchase-order/action',{quantity:5},{adapter});const caught=req.catch(e=>e);await begun
 auth.setSession('new-access',user('new'));release();expect((await caught).code).toBe('SESSION_CHANGED');expect(adapter).toHaveBeenCalledTimes(1);expect(fetch).not.toHaveBeenCalled();expect(auth.getToken()).toBe('new-access')
})
it('legacy axios must preserve a new login after its old refresh loses the generation race',async()=>{
 const auth=await import('../src/lib/v2-auth');auth.setSession('old-access',user('old'));const api=(await import('../src/lib/api')).default
 let release:any;let begin:any;const begun=new Promise(r=>begin=r);vi.mocked(fetch).mockImplementationOnce(()=>{begin();return new Promise(r=>release=r)})
 const adapter=vi.fn(async(config:any)=>Promise.reject({config,response:{status:401}}))
 const req=api.get('/api/private',{adapter});const caught=req.catch(e=>e);await begun
 auth.setSession('new-access',user('new'));release(new Response(JSON.stringify({token:'stale',user:user('old')}),{status:200}))
 expect((await caught).code).toBe('SESSION_CHANGED');expect(auth.getToken()).toBe('new-access');expect(adapter).toHaveBeenCalledTimes(1)
})
