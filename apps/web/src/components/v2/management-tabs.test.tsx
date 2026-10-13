// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {beforeEach,expect,it,vi} from 'vitest'
import {ManagementTabs} from './management-tabs'
const nav=vi.hoisted(()=>({push:vi.fn()}))
vi.mock('next/navigation',()=>({useRouter:()=>nav}))
vi.mock('next/link',()=>({default:({children,href,...props}:any)=><a href={href} {...props}>{children}</a>}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
beforeEach(()=>{sessionStorage.clear();nav.push.mockClear()})
it('库存管理、盘点、库存报表及财务报表在同一栏保留，重挂载仍保留',async()=>{
 const host=document.createElement('div');document.body.append(host);let root=createRoot(host)
 for(const id of ['purchase-in','count','report:realtime','finance:group-profit'])act(()=>root.render(<ManagementTabs activeId={id}/>))
 expect(host.querySelectorAll('nav')).toHaveLength(1);expect(host.querySelectorAll('nav a')).toHaveLength(4)
 expect(host.querySelector('a[href="/v2/supply-chain/reports?report=realtime"]')).not.toBeNull()
 act(()=>root.unmount());root=createRoot(host);act(()=>root.render(<ManagementTabs activeId="count"/>))
 expect(host.querySelectorAll('nav a')).toHaveLength(4)
 await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label="关闭盘点单"]')!.click())
 expect(nav.push).toHaveBeenCalledWith('/v2/supply-chain/reports?report=realtime')
 act(()=>root.unmount());host.remove()
})
it('跨类切换与关闭当前页均保留原未保存保护，非法存储不生成链接',async()=>{
 sessionStorage.setItem('dianjie:management-open-tabs',JSON.stringify(['limits','report:realtime','unknown']))
 const host=document.createElement('div');const root=createRoot(host);const guard=vi.fn().mockResolvedValue(false)
 act(()=>root.render(<ManagementTabs activeId="limits" beforeNavigate={guard}/>))
 expect(host.querySelectorAll('a')).toHaveLength(2)
 await act(async()=>host.querySelector<HTMLAnchorElement>('a[href*="?report="]')!.click())
 await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label="关闭库存上下限"]')!.click())
 expect(guard).toHaveBeenCalledTimes(2);expect(nav.push).not.toHaveBeenCalled();expect(host.querySelectorAll('a')).toHaveLength(2)
 act(()=>root.unmount());const next=createRoot(host);act(()=>next.render(<ManagementTabs activeId="report:none"/>))
 expect(host.querySelectorAll('a')).toHaveLength(2);act(()=>next.unmount())
})
