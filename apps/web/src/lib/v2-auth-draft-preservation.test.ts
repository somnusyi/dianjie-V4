// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest'
import {clearSession,getUser,setSession} from './v2-auth'
afterEach(()=>{localStorage.clear();sessionStorage.clear()})
it('removes authentication while retaining account drafts and chosen columns on recovery',()=>{
 setSession('temporary',{id:'one',tenantId:'tenant',name:'同事',email:'',role:'SUPPLY_CHAIN'})
 localStorage.setItem('dj:supplier-create:tenant:one','draft')
 sessionStorage.setItem('dj:stocktake-create:tenant:one','count')
 localStorage.setItem('dj:report-columns:tenant:one:inventory:realtime','["orgCode"]')
 localStorage.setItem('token','old');localStorage.setItem('refreshToken','old')
 clearSession({preserveDrafts:true})
 expect(getUser()).toBeNull();expect(localStorage.getItem('token')).toBeNull();expect(localStorage.getItem('refreshToken')).toBeNull()
 expect(localStorage.getItem('dj:supplier-create:tenant:one')).toBe('draft')
 expect(sessionStorage.getItem('dj:stocktake-create:tenant:one')).toBe('count')
 expect(localStorage.getItem('dj:report-columns:tenant:one:inventory:realtime')).toBe('["orgCode"]')
})
it('retains normal explicit logout cleanup behavior',()=>{
 localStorage.setItem('dj:supplier-create:tenant:one','draft');sessionStorage.setItem('dj:stocktake-create:tenant:one','count')
 clearSession();expect(localStorage.getItem('dj:supplier-create:tenant:one')).toBeNull();expect(sessionStorage.getItem('dj:stocktake-create:tenant:one')).toBeNull()
})
