import {beforeEach,afterEach,it,expect,vi} from 'vitest'
class MemoryStorage {values=new Map<string,string>();getItem(k:string){return this.values.get(k)||null}setItem(k:string,v:string){this.values.set(k,String(v))}removeItem(k:string){this.values.delete(k)}}
beforeEach(()=>{vi.resetModules();vi.stubGlobal('window',{});vi.stubGlobal('localStorage',new MemoryStorage());vi.stubGlobal('sessionStorage',new MemoryStorage());vi.stubGlobal('location',{pathname:'/v2/login',href:'/v2/login'});vi.stubGlobal('fetch',vi.fn())})
afterEach(()=>{vi.unstubAllGlobals()})
const manager=(id='same',storeIds=['a','b'])=>({id,role:'MANAGER',name:id,email:id+'@local.invalid',storeIds,storeId:storeIds[0]||null})
it('clears the old account store before another account begins using the shared browser',async()=>{
 const auth=await import('../src/lib/v2-auth');auth.setSession('access-a',manager('a-user'),{id:'tenant-a'});auth.setActiveStoreId('a')
 auth.setSession('access-b',manager('b-user',['c']),{id:'tenant-a'})
 expect(localStorage.getItem('activeStoreId')).toBeNull();expect(auth.getActiveStoreId()).toBe('c')
})
it('keeps a same-user selected store that remains in the trusted refreshed scope',async()=>{
 const auth=await import('../src/lib/v2-auth');auth.setSession('access-a',manager());auth.setActiveStoreId('b')
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({token:'fresh',user:manager()}),{status:200}));await auth.refreshAccessOnce()
 expect(auth.getActiveStoreId()).toBe('b')
})
it('drops a revoked store filter on same-user refresh and falls back to the remaining bound store',async()=>{
 const auth=await import('../src/lib/v2-auth');auth.setSession('access-a',manager());auth.setActiveStoreId('a')
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({token:'fresh',user:manager('same',['b'])}),{status:200}));await auth.refreshAccessOnce()
 expect(localStorage.getItem('activeStoreId')).toBeNull();expect(auth.getActiveStoreId()).toBe('b')
})
it('clears an unbound store-scoped account instead of inventing retained authorization',async()=>{
 const auth=await import('../src/lib/v2-auth');auth.setSession('access-a',manager());auth.setActiveStoreId('a')
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({token:'fresh',user:manager('same',[])}),{status:200}));await auth.refreshAccessOnce()
 expect(localStorage.getItem('activeStoreId')).toBeNull();expect(auth.getActiveStoreId()).toBeNull()
})
it('preserves an explicit same-user tenant-wide filter when supply chain has no storeIds collection',async()=>{
 const auth=await import('../src/lib/v2-auth');const user={id:'supply',role:'SUPPLY_CHAIN',name:'供应链',email:'supply@local.invalid'}
 auth.setSession('access-a',user,{id:'tenant'});auth.setActiveStoreId('shop-filter')
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({token:'fresh',user}),{status:200}));await auth.refreshAccessOnce()
 expect(auth.getActiveStoreId()).toBe('shop-filter')
})
it('clears active store when trusted tenant changes even if the returned user id matches',async()=>{
 const auth=await import('../src/lib/v2-auth');auth.setSession('access-a',{...manager(),tenantId:'old-tenant'},{id:'old-tenant'});auth.setActiveStoreId('a')
 auth.setSession('access-b',{...manager(),tenantId:'new-tenant'},{id:'new-tenant'})
 expect(localStorage.getItem('activeStoreId')).toBeNull();expect(JSON.parse(localStorage.getItem('tenant')!)).toEqual({id:'new-tenant'})
})
it('cookie bootstrap into another user removes stale tenant metadata when no new tenant is supplied',async()=>{
 const auth=await import('../src/lib/v2-auth');auth.setSession('access-a',manager('old'),{id:'old-tenant',slug:'old-tenant'});auth.setActiveStoreId('a');auth.setMemoryToken(null)
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({token:'fresh',user:manager('new',['c'])}),{status:200}));await auth.refreshAccessOnce()
 expect(localStorage.getItem('activeStoreId')).toBeNull();expect(localStorage.getItem('tenant')).toBeNull();expect(auth.getUser()?.id).toBe('new')
})
