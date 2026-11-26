import {beforeEach,afterEach,it,expect,vi} from 'vitest'
class MemoryStorage {values=new Map<string,string>();getItem(k:string){return this.values.get(k)||null}setItem(k:string,v:string){this.values.set(k,String(v))}removeItem(k:string){this.values.delete(k)}}
beforeEach(()=>{vi.resetModules();vi.stubGlobal('window',{});vi.stubGlobal('localStorage',new MemoryStorage());vi.stubGlobal('sessionStorage',new MemoryStorage());vi.stubGlobal('location',{pathname:'/v2/login',href:'/v2/login'});vi.stubGlobal('fetch',vi.fn())})
afterEach(()=>{vi.unstubAllGlobals()})
it('starts OAuth only after the pending logout succeeds',async()=>{
 const auth=await import('../src/lib/v2-auth');localStorage.setItem('dj:logout-pending','1');let release:any
 vi.mocked(fetch).mockImplementationOnce(()=>new Promise(r=>release=r)).mockResolvedValueOnce(new Response(JSON.stringify({url:'https://provider.example.test'}),{status:200}))
 const oauth=auth.browserOAuthStart('/api/wecom/oauth/url?tenant=dianjie');expect(fetch).toHaveBeenCalledTimes(1);expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/auth/browser-logout')
 release(new Response('{}',{status:200}));expect((await oauth).ok).toBe(true);expect(localStorage.getItem('dj:logout-pending')).toBeNull();expect(vi.mocked(fetch).mock.calls[1][0]).toBe('/api/wecom/oauth/url?tenant=dianjie')
})
it('does not begin OAuth when logout is still failing, preventing a fresh cookie from being deleted on bridge reload',async()=>{
 const auth=await import('../src/lib/v2-auth');localStorage.setItem('dj:logout-pending','1');vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
 await expect(auth.browserOAuthStart('/api/wecom/oauth/url?tenant=dianjie')).rejects.toThrow('offline');expect(fetch).toHaveBeenCalledTimes(1);expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/auth/browser-logout');expect(localStorage.getItem('dj:logout-pending')).toBe('1')
})
