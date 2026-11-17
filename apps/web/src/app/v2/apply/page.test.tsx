// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ApplyPage from './page'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let container: HTMLDivElement
function change(element: Element, value: string) { act(() => Simulate.change(element, { target: { value } } as any)) }
afterEach(() => { if(root) act(() => root!.unmount()); root=undefined; document.body.innerHTML=''; vi.unstubAllEnvs(); vi.unstubAllGlobals() })
async function render() {
 const fetcher=vi.fn(async (url: string, _init?: RequestInit) => ({ok:true,json:async()=>url.includes('store-list')?[{id:'store-local',no:'N01',name:'北城店'}]:url.includes('supplier-list')?[{id:'supplier-local',no:'S01',name:'山禾食材'}]:{ok:true}}))
 vi.stubGlobal('fetch',fetcher)
 container=document.createElement('div');document.body.append(container);root=createRoot(container)
 await act(async()=>root!.render(<ApplyPage/>))
 return fetcher
}
describe('account application environment',()=>{
 it.each([['local-preview','local-preview'],['','dianjie']])('keeps public store choices and submission in the configured tenant %s',async(preview,tenant)=>{
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_TENANT_SLUG',preview)
  const fetcher=await render()
  expect(fetcher).toHaveBeenCalledWith(`/api/auth/store-list?tenantSlug=${tenant}`)
  const inputs=container.querySelectorAll('input:not([type=search])')
  change(inputs[0],'林门店');change(inputs[1],'19900000141');change(inputs[2],'LocalOnly123');change(inputs[3],'LocalOnly123')
  change(container.querySelectorAll('select')[1],'store-local')
  await act(async()=>Simulate.submit(container.querySelector('form')!))
  const call=fetcher.mock.calls.find(([url])=>url==='/api/auth/apply')!
  expect(JSON.parse(String(call[1]!.body))).toMatchObject({tenantSlug:tenant,requestedStoreId:'store-local',requestedRole:'MANAGER'})
  expect(container.textContent).toContain('申请已提交')
 })
 it('loads supplier choices from the same preview tenant',async()=>{
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_TENANT_SLUG','local-preview')
  const fetcher=await render()
  await act(async()=>Simulate.change(container.querySelector('select')!,{target:{value:'SUPPLIER_STAFF'}} as any))
  expect(fetcher).toHaveBeenCalledWith('/api/auth/supplier-list?tenantSlug=local-preview')
  expect(container.textContent).toContain('山禾食材')
 })
})
