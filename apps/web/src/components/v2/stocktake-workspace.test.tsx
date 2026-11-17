// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {beforeEach,expect,it,vi} from 'vitest'
import {StocktakeWorkspace} from './stocktake-workspace'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const push=vi.fn(),fetch=vi.fn()
vi.mock('next/navigation',()=>({useRouter:()=>({push})}))
vi.mock('@/lib/v2-auth',()=>({getUser:()=>({role:'SUPPLY_CHAIN'}),apiFetch:(...args:any[])=>fetch(...args)}))
const columns=[{key:'no',label:'单据编号'},{key:'date',label:'盘点日期'},{key:'warehouse',label:'仓库'},{key:'status',label:'状态'},{key:'generated',label:'是否生成盘点单'}]
const result={id:'multi-count',columns,rows:[{id:'m1',detailId:'m1',rowVersion:3,no:'M1',date:'2026-11-16',warehouse:'总仓',status:'已审核',generated:'否'},{id:'m2',detailId:'m2',rowVersion:4,no:'M2',date:'2026-11-16',warehouse:'总仓',status:'已审核',generated:'否'}],total:2,totalPages:1,page:1,pageSize:100,note:'',sourceAvailable:true,supportedFilters:['warehouse','status','generated'],options:{status:['已审核']}}
const countResult={...result,id:'count',columns:[{key:'no',label:'单据编号'},{key:'status',label:'状态'},{key:'review',label:'复审'}],rows:[{id:'c1',detailId:'c1',rowVersion:7,no:'C1',status:'已审核',review:'未复审'},{id:'c2',detailId:'c2',rowVersion:8,no:'C2',status:'已审核',review:'未复审'}],options:{status:['已审核'],review:['未复审']}}
const printDocument=(id:string,no:string)=>({id,no,countDate:'2026-11-16',status:'CONFIRMED',reviewStatus:'UNREVIEWED',warehouse:{code:'HQ',name:'总仓'},totalBookValue:'10.0000',totalCountedValue:'9.0000',totalDifferenceValue:'-1.0000',note:null,items:[{id:`${id}-item`,section:'A区',assignee:'盘点员',productCode:'P-1',productName:'土豆',productSpec:'500g',inventoryUnit:'kg',bookQuantity:'10.000000',countedQuantity:'9.000000',differenceQuantity:'-1.000000',differenceValue:'-1.0000',reason:'复核过'}]})
beforeEach(()=>{fetch.mockReset();push.mockReset();vi.restoreAllMocks();fetch.mockImplementation(async(url:string,init:any)=>init?.method==='POST'?{stocktake:{id:'formal-1'}}:result)})
async function render(mode:'count'|'multi-count'='multi-count'){const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(<StocktakeWorkspace mode={mode}/>));await act(async()=>new Promise(r=>setTimeout(r,0)));return{host,root}}

it('多人列表勾选同日同仓子单后批量生成并进入正式盘点编辑',async()=>{const{host,root}=await render();act(()=>host.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(box=>box.click()));await act(async()=>Array.from(host.querySelectorAll('button')).find(x=>x.textContent==='生成盘点单')!.click());expect(fetch).toHaveBeenCalledWith('/api/warehouse-stocktakes/generate-formal-batch',expect.objectContaining({method:'POST'}));expect(push).toHaveBeenCalledWith('/v2/supply-chain/stocktake/work?doc=formal-1&from=count');act(()=>root.unmount())})

it('专用列表请求不超过API每页100并不展示辅助单位或空方案',async()=>{const{host,root}=await render('count');const url=String(fetch.mock.calls.find(([url])=>String(url).includes('/api/inventory-management/count?'))?.[0]);expect(new URL(url,'http://local').searchParams.get('pageSize')).toBe('100');expect(host.textContent).not.toContain('辅助单位');expect(host.textContent).not.toContain('盘点方案');act(()=>root.unmount())})

it('单张反审核使用勾选时版本调用批量端点',async()=>{
 vi.spyOn(window,'prompt').mockReturnValue('录入复核错误')
 fetch.mockImplementation(async(url:string,init:any)=>{
  if(String(url).includes('/api/inventory-management/count?'))return countResult
  if(url==='/api/warehouse-stocktakes/batch/reverse-approval'&&init?.method==='POST')return{operationId:'b1',status:'COMPLETED',summary:{total:1,succeeded:1,failed:0,skipped:0,pending:0},results:[{id:'c1',no:'C1',outcome:'SUCCEEDED',rowVersion:8}]}
  throw new Error(`unexpected ${url}`)
 })
 const{host,root}=await render('count');const row=[...host.querySelectorAll('tr')].find(row=>row.textContent?.includes('C1'))!;await act(async()=>([...row.querySelectorAll('button')].find(button=>button.textContent==='反审核') as HTMLButtonElement).click());await act(async()=>new Promise(r=>setTimeout(r,0)))
 const call=fetch.mock.calls.find(([url,init])=>url==='/api/warehouse-stocktakes/batch/reverse-approval'&&init?.method==='POST')!;expect(JSON.parse(String(call[1].body))).toMatchObject({reason:'录入复核错误',items:[{id:'c1',rowVersion:7}],requestKey:expect.any(String)});expect(host.textContent).toContain('C1：成功');act(()=>root.unmount())
})

it('批量结果显示成功失败未处理，成功项移出而失败项保留',async()=>{
 vi.spyOn(window,'prompt').mockReturnValue('批量复核错误')
 fetch.mockImplementation(async(url:string,init:any)=>{
  if(String(url).includes('/api/inventory-management/count?'))return countResult
  if(url==='/api/warehouse-stocktakes/batch/reverse-approval'&&init?.method==='POST')return{operationId:'b2',status:'COMPLETED',summary:{total:2,succeeded:1,failed:1,skipped:0,pending:0},results:[{id:'c1',no:'C1',outcome:'SUCCEEDED',rowVersion:8},{id:'c2',no:'C2',outcome:'FAILED',code:'VERSION_CONFLICT',message:'盘点单已更新'}]}
  throw new Error(`unexpected ${url}`)
 })
 const{host,root}=await render('count');act(()=>host.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(box=>box.click()));await act(async()=>([...host.querySelectorAll('button')].find(button=>button.textContent==='批量反审核') as HTMLButtonElement).click());await act(async()=>new Promise(r=>setTimeout(r,0)))
 expect(host.textContent).toContain('成功 1，失败 1，未处理 0');expect(host.textContent).toContain('C2：失败（盘点单已更新）');expect(host.textContent).toContain('已选 1 张');expect((host.querySelector<HTMLInputElement>('input[aria-label="选择C1"]')!).checked).toBe(false);expect((host.querySelector<HTMLInputElement>('input[aria-label="选择C2"]')!).checked).toBe(true);act(()=>root.unmount())
})

it('只重试失败项会先刷新当前版本并成功，首次仍使用勾选时版本',async()=>{
 let batchCalls=0
 fetch.mockImplementation(async(url:string,init:any)=>{
  if(String(url).includes('/api/inventory-management/count?'))return countResult
  if(url==='/api/warehouse-stocktakes/c1')return{rowVersion:9}
  if(url==='/api/warehouse-stocktakes/batch/approve'&&init?.method==='POST'){
   batchCalls+=1
   return batchCalls===1
    ?{operationId:'retry-1',status:'COMPLETED',summary:{total:1,succeeded:0,failed:1,skipped:0,pending:0},results:[{id:'c1',no:'C1',outcome:'FAILED',code:'VERSION_CONFLICT',message:'盘点单已更新'}]}
    :{operationId:'retry-2',status:'COMPLETED',summary:{total:1,succeeded:1,failed:0,skipped:0,pending:0},results:[{id:'c1',no:'C1',outcome:'SUCCEEDED',rowVersion:10}]}
  }
  throw new Error(`unexpected ${url}`)
 })
 const{host,root}=await render('count');act(()=>host.querySelector<HTMLInputElement>('input[aria-label="选择C1"]')!.click());await act(async()=>([...host.querySelectorAll('button')].find(button=>button.textContent==='批量审核') as HTMLButtonElement).click());await act(async()=>new Promise(r=>setTimeout(r,0)))
 let calls=fetch.mock.calls.filter(([url,init])=>url==='/api/warehouse-stocktakes/batch/approve'&&init?.method==='POST');expect(JSON.parse(String(calls[0][1].body))).toMatchObject({items:[{id:'c1',rowVersion:7}]})
 await act(async()=>([...host.querySelectorAll('button')].find(button=>button.textContent==='只重试失败/未处理项') as HTMLButtonElement).click());await act(async()=>new Promise(r=>setTimeout(r,0)))
 calls=fetch.mock.calls.filter(([url,init])=>url==='/api/warehouse-stocktakes/batch/approve'&&init?.method==='POST');expect(fetch).toHaveBeenCalledWith('/api/warehouse-stocktakes/c1');expect(JSON.parse(String(calls[1][1].body))).toMatchObject({items:[{id:'c1',rowVersion:9}]});expect(host.textContent).toContain('C1：成功');expect(host.textContent).toContain('已选 0 张');act(()=>root.unmount())
})

it('翻页保留选择且慢的旧页响应不覆盖新页',async()=>{
 let resolveOld:(value:any)=>void=()=>{};let first=true
 const page1={...result,total:2,totalPages:2,page:1,pageSize:1,rows:[result.rows[0]]},page2={...result,total:2,totalPages:2,page:2,pageSize:1,rows:[result.rows[1]]}
 fetch.mockImplementation((url:string)=>{const requested=Number(new URL(url,'http://local').searchParams.get('page'));if(first){first=false;return Promise.resolve(page1)}if(requested===2)return Promise.resolve(page2);return new Promise(resolve=>{resolveOld=resolve})})
 const{host,root}=await render();act(()=>host.querySelector<HTMLInputElement>('input[aria-label="选择M1"]')!.click());await act(async()=>([...host.querySelectorAll('button')].find(button=>button.textContent==='下一页') as HTMLButtonElement).click());await act(async()=>new Promise(r=>setTimeout(r,0)));expect(host.textContent).toContain('M2');expect(host.textContent).toContain('已选 1 张');resolveOld(page1);await act(async()=>new Promise(r=>setTimeout(r,0)));expect(host.textContent).toContain('M2');act(()=>root.unmount())
})

it('跨页选中的盘点单按原顺序预览，afterprint后只完成一次打印任务',async()=>{
 const page1={...result,total:2,totalPages:2,page:1,pageSize:1,rows:[result.rows[0]]},page2={...result,total:2,totalPages:2,page:2,pageSize:1,rows:[result.rows[1]]}
 let preparedKey=''
 fetch.mockImplementation(async(url:string,init:any)=>{
  if(String(url).includes('/api/inventory-management/multi-count?'))return Number(new URL(url,'http://local').searchParams.get('page'))===2?page2:page1
  if(url==='/api/warehouse-stocktakes/print-jobs'&&init?.method==='POST'){preparedKey=JSON.parse(String(init.body)).requestKey;return{job:{id:'print-job-1',requestKey:preparedKey}}}
  if(url==='/api/warehouse-stocktakes/print-jobs/print-job-1')return{id:'print-job-1',requestKey:preparedKey,documents:[printDocument('m1','M1'),printDocument('m2','M2')]}
  if(url==='/api/warehouse-stocktakes/print-jobs/print-job-1/complete'&&init?.method==='POST')return{replayed:false}
  throw new Error(`unexpected ${url}`)
 })
 const print=vi.spyOn(window,'print').mockImplementation(()=>{})
 const{host,root}=await render();act(()=>host.querySelector<HTMLInputElement>('input[aria-label="选择M1"]')!.click());await act(async()=>([...host.querySelectorAll('button')].find(button=>button.textContent==='下一页') as HTMLButtonElement).click());await act(async()=>new Promise(resolve=>setTimeout(resolve,0)));act(()=>host.querySelector<HTMLInputElement>('input[aria-label="选择M2"]')!.click());await act(async()=>([...host.querySelectorAll('button')].find(button=>button.textContent==='打印选中单据') as HTMLButtonElement).click());await act(async()=>new Promise(resolve=>setTimeout(resolve,0)))
 const prepareCall=fetch.mock.calls.find(([url,init])=>url==='/api/warehouse-stocktakes/print-jobs'&&init?.method==='POST')!;expect(JSON.parse(String(prepareCall[1].body))).toEqual({requestKey:preparedKey,ids:['m1','m2']});expect(host.textContent).toContain('盘点单打印预览（2 张）');expect(host.textContent).toContain('不代表打印机已实际出纸');expect(print).not.toHaveBeenCalled()
 await act(async()=>([...host.querySelectorAll('button')].find(button=>button.textContent==='打印 / 保存 PDF') as HTMLButtonElement).click());expect(print).toHaveBeenCalledTimes(1);await act(async()=>window.dispatchEvent(new Event('afterprint')));await act(async()=>new Promise(resolve=>setTimeout(resolve,0)))
 const completeCalls=fetch.mock.calls.filter(([url])=>url==='/api/warehouse-stocktakes/print-jobs/print-job-1/complete');expect(completeCalls).toHaveLength(1);expect(JSON.parse(String(completeCalls[0][1].body))).toEqual({requestKey:preparedKey});expect(host.querySelector('[data-stocktake-print-root]')).toBeNull();expect(host.textContent).toContain('已记录当前版本完成过浏览器打印流程');act(()=>root.unmount())
})

it('手动关闭打印预览会放弃任务而不完成打印证据',async()=>{
 let preparedKey=''
 fetch.mockImplementation(async(url:string,init:any)=>{
  if(String(url).includes('/api/inventory-management/count?'))return countResult
  if(url==='/api/warehouse-stocktakes/print-jobs'&&init?.method==='POST'){preparedKey=JSON.parse(String(init.body)).requestKey;return{job:{id:'print-job-close',requestKey:preparedKey}}}
  if(url==='/api/warehouse-stocktakes/print-jobs/print-job-close')return{id:'print-job-close',requestKey:preparedKey,documents:[printDocument('c1','C1')]}
  if(url==='/api/warehouse-stocktakes/print-jobs/print-job-close/abandon'&&init?.method==='POST')return{replayed:false}
  throw new Error(`unexpected ${url}`)
 })
 const{host,root}=await render('count');const row=[...host.querySelectorAll('tr')].find(value=>value.textContent?.includes('C1'))!;await act(async()=>([...row.querySelectorAll('button')].find(button=>button.textContent==='打印') as HTMLButtonElement).click());await act(async()=>new Promise(resolve=>setTimeout(resolve,0)));await act(async()=>([...host.querySelectorAll('button')].find(button=>button.textContent==='关闭并放弃') as HTMLButtonElement).click());await act(async()=>new Promise(resolve=>setTimeout(resolve,0)))
 expect(fetch).toHaveBeenCalledWith('/api/warehouse-stocktakes/print-jobs/print-job-close/abandon',expect.objectContaining({method:'POST'}));expect(fetch.mock.calls.some(([url])=>String(url).endsWith('/complete'))).toBe(false);expect(host.textContent).toContain('已关闭打印预览，未改变打印状态');act(()=>root.unmount())
})

it('准备成功后预览确定冲突会放弃旧任务，重试使用新请求号',async()=>{
 let prepareCount=0;const keys:string[]=[]
 fetch.mockImplementation(async(url:string,init:any)=>{
  if(String(url).includes('/api/inventory-management/count?'))return countResult
  if(url==='/api/warehouse-stocktakes/print-jobs'&&init?.method==='POST'){prepareCount+=1;keys.push(JSON.parse(String(init.body)).requestKey);return{job:{id:`conflict-job-${prepareCount}`,requestKey:keys.at(-1)}}}
  if(url==='/api/warehouse-stocktakes/print-jobs/conflict-job-1')throw Object.assign(new Error('准备后单据已变化'),{status:409})
  if(url==='/api/warehouse-stocktakes/print-jobs/conflict-job-1/abandon'&&init?.method==='POST')return{replayed:false}
  if(url==='/api/warehouse-stocktakes/print-jobs/conflict-job-2')return{id:'conflict-job-2',requestKey:keys[1],documents:[printDocument('c1','C1')]}
  throw new Error(`unexpected ${url}`)
 })
 const{host,root}=await render('count');let row=[...host.querySelectorAll('tr')].find(value=>value.textContent?.includes('C1'))!;await act(async()=>([...row.querySelectorAll('button')].find(button=>button.textContent==='打印') as HTMLButtonElement).click());await act(async()=>new Promise(resolve=>setTimeout(resolve,0)));expect(host.textContent).toContain('请重新准备打印');expect(fetch).toHaveBeenCalledWith('/api/warehouse-stocktakes/print-jobs/conflict-job-1/abandon',expect.objectContaining({method:'POST'}))
 row=[...host.querySelectorAll('tr')].find(value=>value.textContent?.includes('C1'))!;await act(async()=>([...row.querySelectorAll('button')].find(button=>button.textContent==='打印') as HTMLButtonElement).click());await act(async()=>new Promise(resolve=>setTimeout(resolve,0)));expect(keys).toHaveLength(2);expect(keys[1]).not.toBe(keys[0]);expect(host.textContent).toContain('盘点单打印预览（1 张）');act(()=>root.unmount())
})

it('行内导出调用详情Excel而不是列表导出',async()=>{
 Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=> 'blob:stocktake')});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});const anchorClick=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
 fetch.mockImplementation(async(url:string)=>String(url).includes('/api/inventory-management/count?')?countResult:url==='/api/warehouse-stocktakes/c1/export'?{filename:'盘点单-C1.xlsx',fileBase64:'AA=='}:Promise.reject(new Error(`unexpected ${url}`)))
 const{host,root}=await render('count');const row=[...host.querySelectorAll('tr')].find(value=>value.textContent?.includes('C1'))!;await act(async()=>([...row.querySelectorAll('button')].find(button=>button.textContent==='导出明细') as HTMLButtonElement).click());expect(fetch).toHaveBeenCalledWith('/api/warehouse-stocktakes/c1/export');expect(anchorClick).toHaveBeenCalledTimes(1);act(()=>root.unmount())
})

it('跨页最多选择100张，第101张禁用并明确提示上限',async()=>{
 const manyRows=Array.from({length:101},(_,index)=>({id:`m${index+1}`,detailId:`m${index+1}`,rowVersion:index+1,no:`M${index+1}`,date:'2026-11-16',warehouse:'总仓',status:'已审核',generated:'否'}))
 const page1={...result,total:101,totalPages:2,page:1,pageSize:100,rows:manyRows.slice(0,100)},page2={...result,total:101,totalPages:2,page:2,pageSize:100,rows:manyRows.slice(100)}
 fetch.mockImplementation(async(url:string)=>Number(new URL(url,'http://local').searchParams.get('page'))===2?page2:page1)
 const{host,root}=await render();act(()=>host.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(box=>box.click()));expect(host.textContent).toContain('已选 100 张');expect(host.textContent).toContain('已达到每批100张上限');await act(async()=>([...host.querySelectorAll('button')].find(button=>button.textContent==='下一页') as HTMLButtonElement).click());await act(async()=>new Promise(r=>setTimeout(r,0)));expect(host.querySelector<HTMLInputElement>('input[aria-label="选择M101"]')!.disabled).toBe(true);expect(host.textContent).toContain('已选 100 张');act(()=>root.unmount())
})

it('单张和批量删除使用勾选版本、必填原因并展示逐项结果',async()=>{
 const draftResult={...result,rows:[{id:'m1',detailId:'m1',rowVersion:3,no:'M1',date:'2026-11-16',warehouse:'总仓',status:'草稿',generated:'否'}],total:1}
 vi.spyOn(window,'prompt').mockReturnValue('录入错误删除')
 fetch.mockImplementation(async(url:string,init:any)=>{
  if(String(url).includes('/api/inventory-management/multi-count?'))return draftResult
  if(url==='/api/warehouse-stocktakes/batch/delete'&&init?.method==='POST')return{operationId:'delete-1',status:'COMPLETED',summary:{total:1,succeeded:1,failed:0,skipped:0,pending:0},results:[{id:'m1',no:'M1',outcome:'SUCCEEDED',rowVersion:4}]}
  throw new Error(`unexpected ${url}`)
 })
 const{host,root}=await render();const row=[...host.querySelectorAll('tr')].find(value=>value.textContent?.includes('M1'))!;await act(async()=>([...row.querySelectorAll('button')].find(button=>button.textContent==='删除') as HTMLButtonElement).click());await act(async()=>new Promise(resolve=>setTimeout(resolve,0)))
 const call=fetch.mock.calls.find(([url,init])=>url==='/api/warehouse-stocktakes/batch/delete'&&init?.method==='POST')!;expect(JSON.parse(String(call[1].body))).toMatchObject({reason:'录入错误删除',items:[{id:'m1',rowVersion:3}],requestKey:expect.any(String)});expect(host.textContent).toContain('成功 1，失败 0，未处理 0');act(()=>root.unmount())
})
