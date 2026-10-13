// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,it,expect,vi} from 'vitest'
import FinanceLogin from './page'
import MainLogin from '../../login/page'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();localStorage.clear();document.body.replaceChildren();window.history.replaceState({},'','/')})
for(const [name,Page] of [['财务',FinanceLogin],['主登录',MainLogin]] as const){
 it(`${name}测试入口不会因正式租户query显示正式环境，登录发送锁定租户`,async()=>{
  localStorage.clear();vi.stubEnv('NEXT_PUBLIC_PREVIEW_TENANT_SLUG','supply-chain-uat');window.history.replaceState({},'','/v2/login?tenant=dianjie')
  const fetch=vi.fn().mockResolvedValue({ok:false,json:async()=>({error:'合成失败'})});vi.stubGlobal('fetch',fetch)
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
  try{
   await act(async()=>root.render(<Page/>));expect(host.textContent).toContain('测试环境');expect(host.textContent).toContain('supply-chain-uat');expect(host.textContent).not.toContain('正式环境')
   const fields=host.querySelectorAll('input'),set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!
   act(()=>{set.call(fields[0],'fin');fields[0].dispatchEvent(new Event('input',{bubbles:true}));set.call(fields[1],'only-test');fields[1].dispatchEvent(new Event('input',{bubbles:true}))})
   await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
   expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({tenantSlug:'supply-chain-uat'})
  }finally{act(()=>root.unmount())}
 })
}
