// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import Page from './page'
import {apiFetch} from '@/lib/v2-auth'
import {exportXlsx} from '@/lib/exportXlsx'
import {notifyUser} from '@/lib/ui-dialogs'
vi.mock('@/lib/v2-auth',()=>({apiFetch:vi.fn()}))
vi.mock('@/lib/exportXlsx',()=>({exportXlsx:vi.fn().mockResolvedValue(undefined)}))
vi.mock('@/lib/ui-dialogs',()=>({notifyUser:vi.fn()}))
vi.mock('../_topnav',()=>({default:()=>null}))
vi.mock('@/components/v2/bank-transactions-drawer',()=>({BankTransactionsDrawer:()=>null}))
vi.mock('@/components/v2',()=>({BlackHero:()=>null,Chip:({children}:any)=><span>{children}</span>,MonthPicker:()=>null}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
const account=(id='a')=>({id,name:'清源现金'+id,type:'CASH',balance:'101.00',status:'ACTIVE',cmbBindAccount:null})
const tx=(i:number)=>({id:'t'+i,txDate:'2026-10-15T12:00:00Z',direction:1,category:'其他',amount:'1.00',balanceAfter:i+1,refType:'LocalReference',refId:String(i)})
let accounts=[account()],rows=Array.from({length:101},(_,i)=>tx(i)),host:HTMLDivElement,root:ReturnType<typeof createRoot>
function mockList(overrides?:(url:URL)=>any){vi.mocked(apiFetch).mockImplementation(async path=>{const u=new URL(String(path),'http://localhost')
 if(u.pathname==='/api/cashbook/summary')return{totalBalance:101,monthIncome:101,monthExpense:0,monthNet:101,accounts} as any
 if(u.pathname==='/api/schedules')return[] as any
 if(u.pathname==='/api/cashbook/transactions'){
 const overridden=overrides?.(u);if(overridden!==undefined)return await overridden
 const page=Number(u.searchParams.get('page')||1);return{items:rows.slice((page-1)*100,page*100),total:rows.length,page,pageSize:100} as any
 }
 throw new Error('unexpected request '+u.pathname)
})}
async function render(){host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root.render(<Page/>))}
function button(){return Array.from(host.querySelectorAll('button')).find(x=>/导出对账单|导出中/.test(x.textContent||''))!}
async function click(){await act(async()=>button().click())}
beforeEach(()=>{vi.resetAllMocks();vi.mocked(exportXlsx).mockResolvedValue(undefined);accounts=[account()];rows=Array.from({length:101},(_,i)=>tx(i));mockList()})
afterEach(async()=>{if(root)await act(async()=>root.unmount());document.body.innerHTML=''})
it.each([0,100,101,200,201])('exports all %s local transactions without any bank request',async count=>{
 rows=Array.from({length:count},(_,i)=>tx(i));await render();await click()
 expect(exportXlsx).toHaveBeenCalledTimes(1)
 const sheets=vi.mocked(exportXlsx).mock.calls[0][1]
 expect(sheets).toHaveLength(count?2:1)
 if(count)expect(sheets[1].rows.slice(3)).toHaveLength(count)
 expect(vi.mocked(apiFetch).mock.calls.some(([p])=>String(p).includes('/api/cmb'))).toBe(false)
})
it.each(['later-failure','duplicate','total-change'])('does not export partial data on %s and allows retry',async mode=>{
 mockList(u=>{if(Number(u.searchParams.get('page')||1)!==2)return
 if(mode==='later-failure')return Promise.reject(new Error('后页读取失败'))
 return {items:mode==='duplicate'?[rows[0]]:[rows[100]],total:mode==='total-change'?102:101,page:2,pageSize:100}
 });await render();await click();expect(exportXlsx).not.toHaveBeenCalled();expect(notifyUser).toHaveBeenCalled();expect(button().disabled).toBe(false)
 mockList();await click();expect(exportXlsx).toHaveBeenCalledTimes(1)
})
it('one failed account does not generate any partial file',async()=>{
 accounts=[account('a'),account('b')];mockList(u=>u.searchParams.get('accountId')==='b'?Promise.reject(new Error('账户读取失败')):undefined)
 await render();await click();expect(exportXlsx).not.toHaveBeenCalled();expect(notifyUser).toHaveBeenCalled()
})
it('double click produces one download and unlocks after a failed file generation',async()=>{
 let reject!:(e:Error)=>void;vi.mocked(exportXlsx).mockReturnValueOnce(new Promise((_,r)=>{reject=r}))
 await render();await act(async()=>{button().click();button().click()})
 expect(exportXlsx).toHaveBeenCalledTimes(1);expect(button().disabled).toBe(true)
 await act(async()=>reject(new Error('文件生成失败')));expect(button().disabled).toBe(false)
 await click();expect(exportXlsx).toHaveBeenCalledTimes(2)
})
