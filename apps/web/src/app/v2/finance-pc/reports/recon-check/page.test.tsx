// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterAll,beforeAll,expect,it,vi} from 'vitest'
import Page from './page'
import {apiFetch} from '@/lib/v2-auth'
import {exportXlsx} from '@/lib/exportXlsx'
vi.mock('@/lib/v2-auth',()=>({apiFetch:vi.fn()}))
vi.mock('@/lib/exportXlsx',()=>({exportXlsx:vi.fn().mockResolvedValue(undefined)}))
vi.mock('../../_topnav',()=>({default:()=>null}))
vi.mock('@/components/v2',()=>({Chip:({children}:any)=><span>{children}</span>,MonthPicker:({value,onChange}:any)=><><span>{value}</span><button onClick={()=>onChange('2026-09')}>九月</button></>}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
beforeAll(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-20T10:00:00Z'))})
afterAll(()=>{vi.useRealTimers()})
const data=(month:string,matched:number)=>({month,summary:{voucherEntries:matched,cashTxs:matched,matched,unmatchedEntries:0,unmatchedTxs:0},unmatchedEntries:[],unmatchedTxs:[]})
it.each(['success','error'])('late old-month %s cannot change new-month display or exported summary',async outcome=>{
 let resolveOld!:(x:any)=>void,rejectOld!:(x:any)=>void
 const old=new Promise((resolve,reject)=>{resolveOld=resolve;rejectOld=reject})
 vi.mocked(apiFetch).mockReset().mockImplementation((url:any)=>url.includes('month=2026-09')?Promise.resolve(data('2026-09',3)):old as any)
 vi.mocked(exportXlsx).mockClear()
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{await act(async()=>root.render(<Page/>));await act(async()=>host.querySelector('button')!.click())
 await act(async()=>{if(outcome==='success')resolveOld(data('2026-10',99));else rejectOld(new Error('旧月失败'))})
 expect(host.textContent).toContain('3 笔凭证流水一一对应');expect(host.textContent).not.toContain('99 笔');expect(host.textContent).not.toContain('旧月失败')
 await act(async()=>Array.from(host.querySelectorAll('button')).find(x=>x.textContent?.includes('导出'))!.click())
 expect(exportXlsx).toHaveBeenCalledWith('对账自检-2026-09.xlsx',expect.arrayContaining([expect.objectContaining({name:'汇总',rows:expect.arrayContaining([['已匹配',3,expect.any(String)]])})]))
 }finally{await act(async()=>root.unmount());host.remove()}
})

it('does not enable export when only the previous month has returned',async()=>{
 let resolveOld!:(x:any)=>void,resolveNew!:(x:any)=>void
 const old=new Promise(resolve=>{resolveOld=resolve}),fresh=new Promise(resolve=>{resolveNew=resolve})
 vi.mocked(apiFetch).mockReset().mockImplementation((url:any)=>url.includes('month=2026-09')?fresh as any:old as any)
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 try{await act(async()=>root.render(<Page/>));await act(async()=>host.querySelector('button')!.click());await act(async()=>resolveOld(data('2026-10',99)))
 expect((Array.from(host.querySelectorAll('button')).find(x=>x.textContent?.includes('导出')) as HTMLButtonElement).disabled).toBe(true);expect(host.textContent).toContain('扫描中');expect(host.textContent).not.toContain('99 笔')
 await act(async()=>resolveNew(data('2026-09',3)))
 expect((Array.from(host.querySelectorAll('button')).find(x=>x.textContent?.includes('导出')) as HTMLButtonElement).disabled).toBe(false)
 }finally{await act(async()=>root.unmount());host.remove()}
})
