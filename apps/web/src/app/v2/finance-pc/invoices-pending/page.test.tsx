// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {expect,it,vi} from 'vitest'
import Page from './page'
import {apiFetch} from '@/lib/v2-auth'
vi.mock('@/lib/v2-auth',()=>({apiFetch:vi.fn()}))
vi.mock('../_topnav',()=>({default:()=>null}))
vi.mock('@/components/v2',()=>({Chip:({children}:any)=><span>{children}</span>,BlackHero:({label,value,delta,stats}:any)=><div>{label}{value}{delta?.text}{stats.map((x:any)=><span key={x.label}>{x.label}{x.value}</span>)}</div>}))
vi.mock('@/lib/ui-dialogs',()=>({notifyUser:vi.fn()}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
it('preserves exact cents in both invoice tracking totals and receipt rows',async()=>{
 vi.mocked(apiFetch).mockResolvedValue({paid:[{id:'r',no:'RK201',totalAmount:'2.22',deliveryDate:'2026-05-20',daysSincePaid:153,store:{name:'门店'},supplier:{name:'松源食材'},paymentSchedule:{paidAt:'2026-05-20'}}],pending:[],summary:{paidCount:201,pendingCount:201,paidAmount:446.22,pendingAmount:223.11,oldestPaidDays:153}} as any)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<Page/>))
 expect(host.textContent?.match(/¥446\.22/g)?.length).toBe(2);expect(host.textContent).toContain('¥2.22');expect(host.textContent).toContain('RK201');expect(host.textContent).toContain('已付款未开票 201')
 await act(async()=>root.unmount());host.remove()
})
it('failed tracking fetch stays unknown and does not declare no uninvoiced receipts',async()=>{
 vi.mocked(apiFetch).mockRejectedValue(new Error('待开票读取失败'))
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<Page/>))
 expect(host.textContent).toContain('待开票读取失败');expect(host.textContent).toContain('已付款未开票 —');expect(host.textContent).not.toContain('没有已付款未开票的单子')
 await act(async()=>root.unmount());host.remove()
})

it('copies an unpaid receipt without falsely saying it has already been paid',async()=>{
 const writeText=vi.fn().mockResolvedValue(undefined)
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}})
 const row={id:'u',no:'RK-U201',totalAmount:'1.11',deliveryDate:'2026-05-20',store:{name:'门店'},supplier:{name:'松源食材'},paymentSchedule:null}
 vi.mocked(apiFetch).mockResolvedValue({paid:[],pending:[row],summary:{paidCount:0,pendingCount:1,paidAmount:0,pendingAmount:1.11,oldestPaidDays:0}} as any)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<Page/>))
 await act(async()=>Array.from(host.querySelectorAll('button')).find(x=>x.textContent==='未付款未开票 1')!.click())
 await act(async()=>Array.from(host.querySelectorAll('button')).find(x=>x.textContent?.includes('催发票'))!.click())
 expect(writeText).toHaveBeenCalledTimes(1);expect(writeText.mock.calls[0][0]).toContain('RK-U201 (门店) ¥1.11 未付款');expect(writeText.mock.calls[0][0]).not.toContain('已付款')
 await act(async()=>root.unmount());host.remove()
})
it('paid reminder keeps its true elapsed days and does not invent zero days when unknown',async()=>{
 const writeText=vi.fn().mockResolvedValue(undefined)
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}})
 const row={id:'p',no:'RK-P201',totalAmount:'2.22',deliveryDate:'2026-05-20',daysSincePaid:153,store:{name:'门店'},supplier:{name:'松源食材'},paymentSchedule:{paidAt:'2026-05-20'}}
 vi.mocked(apiFetch).mockResolvedValue({paid:[row,{...row,id:'p2',no:'RK-P202',daysSincePaid:null}],pending:[],summary:{paidCount:2,pendingCount:0,paidAmount:4.44,pendingAmount:0,oldestPaidDays:153}} as any)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<Page/>))
 const buttons=Array.from(host.querySelectorAll('button')).filter(x=>x.textContent?.includes('催发票'))
 await act(async()=>buttons[0].click());await act(async()=>buttons[1].click())
 expect(writeText.mock.calls[0][0]).toContain('已付款 153 天');expect(writeText.mock.calls[1][0]).toContain('已付款 —');expect(writeText.mock.calls[1][0]).not.toContain('0 天')
 await act(async()=>root.unmount());host.remove()
})
