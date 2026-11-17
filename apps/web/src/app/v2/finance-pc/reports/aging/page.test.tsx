// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,beforeEach,it,expect,vi} from 'vitest'
import Page from './page'
import {apiFetch} from '@/lib/v2-auth'
import {exportXlsx} from '@/lib/exportXlsx'
vi.mock('@/lib/v2-auth',()=>({apiFetch:vi.fn()}))
vi.mock('@/lib/exportXlsx',()=>({exportXlsx:vi.fn().mockResolvedValue(undefined)}))
vi.mock('@/components/v2',()=>({Chip:({children}:any)=><span>{children}</span>}))
vi.mock('@/components/v2/use-dashboard',()=>({ErrorScreen:({message}:any)=><div role="alert">{message}</div>}))
vi.mock('../../_topnav',()=>({default:()=>null}))
const isPC=true
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
let root:ReturnType<typeof createRoot>,host:HTMLDivElement
const data={asOf:'2026-10-22T10:00:00Z',totalOverdue:7.89,totalNotDue:12345.67,grandTotal:12353.56,buckets:{notDue:{count:1,total:12345.67,label:'未到期'},d0_30:{count:1,total:7.89,label:'逾期 0-30 天'},d30_60:{count:0,total:0,label:'逾期 30-60 天'},d60_90:{count:0,total:0,label:'逾期 60-90 天'},d90plus:{count:0,total:0,label:'逾期 90+ 天'}},items:[{scheduleId:'a',supplierId:'s1',supplierName:'青禾食材',storeId:'store',storeName:'清源一店',amount:7.89,dueAt:'2026-10-20T12:00:00Z',overdueDays:2,bucket:'d0_30',status:'OVERDUE'},{scheduleId:'b',supplierId:'s2',supplierName:'云岭农产',storeId:'store',storeName:'清源一店',amount:12345.67,dueAt:'2026-11-01T12:00:00Z',overdueDays:-10,bucket:'notDue',status:'NOTIFIED'}],supplierRank:[{supplierId:'s2',name:'云岭农产',total:12345.67,count:1,oldest:-1},{supplierId:'s1',name:'青禾食材',total:7.89,count:1,oldest:2}]}
beforeEach(()=>{vi.resetAllMocks();vi.mocked(apiFetch).mockResolvedValue(data as any);vi.mocked(exportXlsx).mockResolvedValue(undefined)})
afterEach(async()=>{if(root)await act(async()=>root.unmount());document.body.innerHTML=''})
async function render(){host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root.render(<Page/>))}
const button=(prefix:string)=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent?.startsWith(prefix))!
it('hero, buckets, supplier rank and detail consistently retain cents and large currency',async()=>{await render();expect(host.textContent?.split('¥12,353.56').length).toBeGreaterThanOrEqual(3);expect(host.textContent?.split('¥12,345.67').length).toBeGreaterThanOrEqual(5);expect(host.textContent?.split('¥7.89').length).toBeGreaterThanOrEqual(5)})
it('bucket filtering keeps the correct status, decimal amount and reset behavior',async()=>{await render();await act(async()=>button('逾期 0-30 天').click());expect(host.textContent).toContain('明细 (1 笔)');if(isPC){expect(host.querySelector('tbody')?.textContent).toContain('7.89');expect(host.querySelector('tbody')?.textContent).not.toContain('12,345.67')}else{expect(host.querySelectorAll('ul')[0]?.textContent).toContain('OVERDUE');expect(host.querySelectorAll('ul')[0]?.textContent).not.toContain('NOTIFIED')}await act(async()=>button('全部').click());expect(host.textContent).toContain('明细 (2 笔)')})
it('a failed read is an error and does not expose a fabricated zero report or export',async()=>{vi.mocked(apiFetch).mockRejectedValue(new Error('账龄不可读取'));await render();expect(host.textContent).toContain('账龄不可读取');expect(host.textContent).not.toContain('¥0.00');if(isPC)expect(button('📊 导出 Excel').disabled).toBe(true)})
it('export preserves complete report scope and exact amounts after a bucket filter',async()=>{await render();await act(async()=>button('逾期 0-30 天').click());await act(async()=>button('📊 导出 Excel').click());const [name,sheets]=vi.mocked(exportXlsx).mock.calls[0];expect(name).toContain('20261022');expect(sheets[0].rows).toContainEqual(['合计',2,12353.56,'100%']);expect(sheets[1].rows).toHaveLength(3);expect(sheets[1].rows[1][3]).toBe(7.89);expect(sheets[1].rows[2][3]).toBe(12345.67)})
