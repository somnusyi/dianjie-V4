// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InventoryRules } from './inventory-rules'
import { SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT } from './supply-chain-shell'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const mock = vi.hoisted(() => ({ api: vi.fn(), confirm: vi.fn() }))
vi.mock('@/lib/v2-auth', () => ({ apiFetch: mock.api,getUser:()=>({role:'SUPPLY_CHAIN'}) }))
vi.mock('@/lib/ui-dialogs', () => ({ confirmDialog: mock.confirm }))
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a> }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const result = (unitChanged = false, source: 'configured' | 'legacy-fallback' = 'configured') => ({
  warehouse: { id: 'w1', code: 'MAIN', name: '总仓', isDefault: true },
  warehouses: [{ id: 'w1', code: 'MAIN', name: '总仓', isDefault: true }, { id: 'w2', code: 'COLD', name: '冷藏仓', isDefault: false }],
  items: [
    { productId: 'p1', code: 'P001', name: '土豆', spec: '1kg', category: '蔬菜', inventoryUnit: 'kg', currentQty: 12, minQty: 5, maxQty: 20, stagnantDays: 30, source, alertStatus: '正常', active: true, rowVersion: source === 'legacy-fallback' ? 0 : 2, unitChanged, hasPolicy: source !== 'legacy-fallback' },
    { productId: 'p2', code: 'P002', name: '白菜', spec: '500g', category: '蔬菜', inventoryUnit: 'kg', currentQty: 8, minQty: 2, maxQty: 15, stagnantDays: 45, source: 'configured', alertStatus: '正常', active: true, rowVersion: 1, unitChanged: false, hasPolicy: true },
  ],
  total: 2, page: 1, pageSize: 50,
})

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLDivElement
async function render(unitChanged = false, source: 'configured' | 'legacy-fallback' = 'configured') {
  mock.api.mockImplementation((url: string) => url.startsWith('/api/inventory-reports/policies?') ? Promise.resolve(result(unitChanged, source)) : Promise.resolve({revision:{id:'r1',status:'DRAFT',rowVersion:0,payload:{minQty:5,maxQty:25,active:true,stagnantDays:30}},replayed:false}))
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  await act(async () => root!.render(<InventoryRules />))
}
afterEach(() => { act(() => root?.unmount()); container?.remove(); sessionStorage.clear(); mock.api.mockReset(); mock.confirm.mockReset(); vi.restoreAllMocks() })

function setInput(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!
  descriptor.set!.call(input, value)
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('库存上下限与呆滞规则页面', () => {
  it('提供独立入口、仓库切换、预警跳转和停用语义', async () => {
    await render()
    expect(container.textContent).toContain('库存上下限与呆滞规则')
    expect(container.textContent).toContain('统一30天')
    expect(container.querySelector('input[aria-label="白菜呆滞天数"]')).toBeNull()
    expect(container.textContent).toContain('不自动移库')
    expect(container.textContent).toContain('停用后该仓库商品按“阈值未配置”处理')
    expect(container.querySelector('a[href="/v2/supply-chain/reports?report=alerts"]')).not.toBeNull()
    expect(container.querySelector('td[data-label="库存上限"]')).not.toBeNull()
    const warehouse = container.querySelector('select[aria-label="仓库"]') as HTMLSelectElement
    await act(async () => setInput(warehouse, 'w2'))
    expect(mock.api.mock.calls.some(([url]) => String(url).includes('warehouseId=w2'))).toBe(true)
  })

  it('保存库存基准单位阈值并携带CAS版本', async () => {
    await render()
    const max = container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement
    await act(async () => setInput(max, '25'))
    const save = [...container.querySelectorAll('button')].find(button => button.textContent === '保存')!
    await act(async () => save.click())
    const call = mock.api.mock.calls.find(([url, init]) => url === '/api/inventory-reports/policies/p1' && init?.method === 'PATCH')
    const payload = JSON.parse(String(call?.[1]?.body))
    expect(payload).toMatchObject({ warehouseId: 'w1', minQty: 5, maxQty: 25, stagnantDays: 30, active: true, rowVersion: 2, confirmUnitChange: false })
    expect(payload.requestId).toBeTruthy()
  })

  it('库存单位变更必须二次确认', async () => {
    mock.confirm.mockResolvedValue(false)
    await render(true)
    const max = container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement
    await act(async () => setInput(max, '25'))
    const save = [...container.querySelectorAll('button')].find(button => button.textContent === '保存')!
    await act(async () => save.click())
    expect(mock.confirm).toHaveBeenCalled()
    expect(mock.api.mock.calls.some(([url]) => url === '/api/inventory-reports/policies/p1')).toBe(false)
    mock.confirm.mockResolvedValue(true)
    await act(async () => save.click())
    const call = mock.api.mock.calls.find(([url, init]) => url === '/api/inventory-reports/policies/p1' && init?.method === 'PATCH')
    expect(JSON.parse(String(call?.[1]?.body)).confirmUnitChange).toBe(true)
  })

  it('旧安全库存显示为兼容生效，保存时明确迁移', async () => {
    mock.confirm.mockResolvedValue(true)
    await render(false, 'legacy-fallback')
    expect(container.textContent).toContain('旧安全库存兼容 · 待迁移')
    expect(container.textContent).toContain('兼容生效')
    const max = container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement
    await act(async () => setInput(max, '25'))
    const save = [...container.querySelectorAll('button')].find(button => button.textContent === '迁移并保存')!
    await act(async () => save.click())
    expect(mock.confirm).toHaveBeenCalledWith(expect.stringContaining('迁移为该仓库的独立库存规则'))
  })

  it('保存一行不会丢失另一行尚未保存的修改', async () => {
    await render()
    const potato = container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement
    const cabbage = container.querySelector('input[aria-label="白菜库存上限"]') as HTMLInputElement
    await act(async () => { setInput(potato, '25'); setInput(cabbage, '18') })
    expect(container.textContent).toContain('2 条未保存')
    const potatoSave = [...container.querySelectorAll('button')].find(button => button.textContent === '保存')!
    await act(async () => potatoSave.click())
    expect((container.querySelector('input[aria-label="白菜库存上限"]') as HTMLInputElement).value).toBe('18')
    expect(container.textContent).toContain('1 条未保存')
  })

  it('切换仓库前拦截未保存修改，取消后不发请求', async () => {
    mock.confirm.mockResolvedValue(false)
    await render()
    const max = container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement
    await act(async () => setInput(max, '25'))
    const callsBefore = mock.api.mock.calls.length
    const warehouse = container.querySelector('select[aria-label="仓库"]') as HTMLSelectElement
    await act(async () => setInput(warehouse, 'w2'))
    expect(mock.confirm).toHaveBeenCalledWith(expect.stringContaining('尚未保存'))
    expect(mock.api.mock.calls.length).toBe(callsBefore)
  })

  it('CAS冲突仅刷新冲突行并保留其他草稿', async () => {
    let getCount = 0
    mock.api.mockImplementation((url: string) => {
      if (url.startsWith('/api/inventory-reports/policies?')) { getCount += 1; return Promise.resolve(result()) }
      if (url === '/api/inventory-reports/policies/p1') return Promise.reject(new Error('库存规则已被其他人修改，请刷新后重试'))
      return Promise.resolve({ policy: { minQty: 2, maxQty: 18, stagnantDays: 45, active: true, rowVersion: 2 }, replayed: false })
    })
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    await act(async () => root!.render(<InventoryRules />))
    const potato = container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement
    const cabbage = container.querySelector('input[aria-label="白菜库存上限"]') as HTMLInputElement
    await act(async () => { setInput(potato, '25'); setInput(cabbage, '18') })
    const save = [...container.querySelectorAll('button')].find(button => button.textContent === '保存')!
    await act(async () => save.click())
    expect(getCount).toBeGreaterThan(1)
    expect(container.textContent).toContain('其他未保存修改已保留')
    expect((container.querySelector('input[aria-label="白菜库存上限"]') as HTMLInputElement).value).toBe('18')
  })

  it('停用已生效规则必须危险确认', async () => {
    mock.confirm.mockResolvedValue(false)
    await render()
    const toggle = container.querySelector('input[aria-label="土豆启用库存规则"]') as HTMLInputElement
    await act(async () => toggle.click())
    const save = [...container.querySelectorAll('button')].find(button => button.textContent === '保存')!
    await act(async () => save.click())
    expect(mock.confirm).toHaveBeenCalledWith(expect.stringContaining('不会恢复旧安全库存'))
    expect(mock.api.mock.calls.some(([url]) => url === '/api/inventory-reports/policies/p1')).toBe(false)
  })

  it('未保存修改会保护报表深链、管理标签和浏览器离开', async () => {
    sessionStorage.setItem('dianjie:management-open-tabs', JSON.stringify(['purchase-in']))
    mock.confirm.mockResolvedValue(false)
    await render()
    const max = container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement
    await act(async () => setInput(max, '25'))

    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)

    const alertLink = container.querySelector('a[href="/v2/supply-chain/reports?report=alerts"]')!
    const alertNavigation = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { alertLink.dispatchEvent(alertNavigation); await Promise.resolve() })
    expect(alertNavigation.defaultPrevented).toBe(true)

    const tabLink = container.querySelector('nav[aria-label="已打开的业务页面"] a[href="/v2/supply-chain/inventory-management/purchase-in"]')!
    const tabNavigation = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { tabLink.dispatchEvent(tabNavigation); await Promise.resolve() })
    expect(tabNavigation.defaultPrevented).toBe(true)
    expect(mock.confirm).toHaveBeenCalledTimes(2)
  })

  it('全局侧边栏或底部导航会拦截未保存规则，取消保留且确认只跳转一次', async () => {
    await render()
    const cleanProceed = vi.fn()
    const cleanEvent = new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, { cancelable: true, detail: { proceed: cleanProceed } })
    expect(window.dispatchEvent(cleanEvent)).toBe(true)
    expect(cleanProceed).not.toHaveBeenCalled()

    const max = container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement
    await act(async () => setInput(max, '25'))
    const proceed = vi.fn()
    const first = new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, { cancelable: true, detail: { proceed } })
    await act(async () => { expect(window.dispatchEvent(first)).toBe(false) })
    expect(container.textContent).toContain('放弃未保存的库存规则？')
    const cancel = [...container.querySelectorAll('button')].find(button => button.textContent === '取消')!
    await act(async () => cancel.click())
    expect((container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement).value).toBe('25')
    expect(proceed).not.toHaveBeenCalled()

    const second = new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, { cancelable: true, detail: { proceed } })
    await act(async () => { expect(window.dispatchEvent(second)).toBe(false) })
    const leave = [...container.querySelectorAll('button')].find(button => button.textContent === '放弃并离开')!
    await act(async () => leave.click())
    expect(proceed).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('1 条未保存')
  })
})

it('keeps the effective limit at20 until final review then forbids cancellation',async()=>{
 const data=result();let revision:any=null
 mock.confirm.mockResolvedValue(true)
 mock.api.mockImplementation(async(url:string,init:any)=>{
  if(url.startsWith('/api/inventory-reports/policies?'))return {...data,items:data.items.map(row=>row.productId==='p1'?{...row,revision}:row)}
  const body=JSON.parse(init.body)
  if(init.method==='PATCH'){revision={id:'r1',status:'DRAFT',rowVersion:0,payload:{minQty:5,maxQty:30,active:true,stagnantDays:30}};return {revision,policy:{minQty:5,maxQty:20}}}
  const action=url.split('/').at(-1);revision={...revision,status:{submit:'PENDING',audit:'AUDITED',review:'REVIEWED',unreview:'AUDITED',unconfirm:'PENDING'}[action!],rowVersion:revision.rowVersion+1}
  if(action==='review')data.items[0].maxQty=30
  if(action==='unreview')data.items[0].maxQty=20
  return {revision}
 })
 container=document.createElement('div');document.body.appendChild(container);root=createRoot(container)
 await act(async()=>root!.render(<InventoryRules/>))
 const max=container.querySelector<HTMLInputElement>('input[aria-label="土豆库存上限"]')!
 await act(async()=>setInput(max,'30'))
 const click=async(name:string)=>act(async()=>{[...container.querySelectorAll('button')].find(b=>b.textContent===name)!.click();await Promise.resolve()})
 await click('保存');expect(container.textContent).toContain('当前生效下限 5／上限 20');expect(container.textContent).toContain('草稿')
 await click('提交');expect(container.textContent).toContain('待审核');expect(container.textContent).toContain('当前生效下限 5／上限 20')
 await click('审核');expect(container.textContent).toContain('已审核 · 待复审');expect(container.textContent).toContain('当前生效下限 5／上限 20')
 await click('复审');expect(container.textContent).toContain('已复审 · 已生效');expect(container.textContent).toContain('当前生效下限 5／上限 30')
 expect([...container.querySelectorAll('button')].some(b=>b.textContent==='反审核')).toBe(false)
 expect([...container.querySelectorAll('button')].some(b=>b.textContent==='取消复审')).toBe(false)
 expect(container.textContent).toContain('当前生效下限 5／上限 30')
})
it('response-loss retry reuses the identical save request and keeps the effective limit unchanged',async()=>{
 let failed=true
 mock.api.mockImplementation(async(url:string,init:any)=>{
  if(url.startsWith('/api/inventory-reports/policies?'))return result()
  if(failed){failed=false;throw Error('模拟响应丢失')}
  return {revision:{id:'r1',status:'DRAFT',rowVersion:0,payload:{minQty:5,maxQty:30,active:true,stagnantDays:30}}}
 })
 container=document.createElement('div');document.body.appendChild(container);root=createRoot(container)
 await act(async()=>root!.render(<InventoryRules/>))
 await act(async()=>setInput(container.querySelector<HTMLInputElement>('input[aria-label="土豆库存上限"]')!,'30'))
 const save=()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='保存')!
 await act(async()=>save().click());await act(async()=>save().click())
 const requests=mock.api.mock.calls.filter(([,init])=>init?.method==='PATCH')
 expect(requests).toHaveLength(2);expect(requests[0]).toEqual(requests[1])
 expect(container.textContent).toContain('当前生效下限 5／上限 20')
})

it('blocks warehouse context changes while a save response is pending',async()=>{
 await render()
 let finish:(value:any)=>void=()=>{}
 const pending=new Promise(resolve=>{finish=resolve})
 mock.api.mockImplementation((url:string,init:any)=>init?.method==='PATCH'?pending:Promise.resolve(result()))
 await act(async()=>setInput(container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement,'25'))
 const save=[...container.querySelectorAll('button')].find(button=>button.textContent==='保存')!
 await act(async()=>save.click())
 const warehouse=container.querySelector('select[aria-label="仓库"]') as HTMLSelectElement
 expect(warehouse.disabled).toBe(true)
 const navigation=new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT,{cancelable:true,detail:{proceed:vi.fn()}})
 await act(async()=>window.dispatchEvent(navigation));expect(navigation.defaultPrevented).toBe(true)
 const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);expect(unload.defaultPrevented).toBe(true)
 await act(async()=>setInput(warehouse,'w2'))
 expect(mock.api.mock.calls.some(([url])=>String(url).includes('warehouseId=w2'))).toBe(false)
 await act(async()=>finish({revision:{id:'r1',status:'DRAFT',rowVersion:1,payload:{inventoryUnitSnapshot:'kg',minQty:5,maxQty:25,active:true,stagnantDays:30}}}))
 expect(warehouse.value).toBe('w1');expect(warehouse.disabled).toBe(false)
})

it('clears obsolete unit values only after explicit recheck, then saves the new unit',async()=>{
 await render()
 const data=result(true);Object.assign(data.items[0],{draftUnit:'箱',storedUnit:'kg',revision:{id:'r-unit',status:'DRAFT',rowVersion:1,payload:{inventoryUnitSnapshot:'kg',minQty:5,maxQty:20,active:true,stagnantDays:30}}})
 mock.api.mockImplementation((url:string)=>url.includes('?')?Promise.resolve(data):Promise.resolve({revision:{id:'r-unit',status:'DRAFT',rowVersion:2,payload:{inventoryUnitSnapshot:'箱',minQty:null,maxQty:3,active:true,stagnantDays:30}}}))
 await act(async()=>{root!.unmount();root=createRoot(container);root.render(<InventoryRules />)})
 const recheck=[...container.querySelectorAll('button')].find(b=>b.textContent==='重新核对单位')!
 mock.confirm.mockResolvedValue(false);await act(async()=>recheck.click())
 expect((container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement).value).toBe('20')
 mock.confirm.mockResolvedValue(true);await act(async()=>recheck.click())
 expect((container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement).value).toBe('')
 await act(async()=>setInput(container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement,'3'))
 await act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='保存')!.click())
 const call=mock.api.mock.calls.find(([url,init])=>String(url).endsWith('/p1')&&init?.method==='PATCH')
 expect(JSON.parse(call![1].body)).toMatchObject({inventoryUnitSnapshot:'箱',minQty:null,maxQty:3,confirmUnitChange:true})
})

it('protects clean-row approval while its result is still pending',async()=>{
 await render();const data=result();Object.assign(data.items[0],{revision:{id:'r-clean',status:'PENDING',rowVersion:2,payload:{inventoryUnitSnapshot:'kg',minQty:5,maxQty:20,active:true,stagnantDays:30}}})
 let finish:(value:any)=>void=()=>{};const pending=new Promise(resolve=>{finish=resolve})
 mock.api.mockImplementation((url:string,init:any)=>init?.method==='POST'?pending:Promise.resolve(data))
 await act(async()=>{root!.unmount();root=createRoot(container);root.render(<InventoryRules />)})
 mock.confirm.mockResolvedValue(true);await act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='审核')!.click())
 const proceed=vi.fn(),navigation=new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT,{cancelable:true,detail:{proceed}})
 await act(async()=>window.dispatchEvent(navigation));expect(navigation.defaultPrevented).toBe(true);expect(proceed).not.toHaveBeenCalled()
 const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);expect(unload.defaultPrevented).toBe(true)
 expect((container.querySelector('select[aria-label="仓库"]') as HTMLSelectElement).disabled).toBe(true)
 await act(async()=>finish({}));const after=new Event('beforeunload',{cancelable:true});window.dispatchEvent(after);expect(after.defaultPrevented).toBe(false)
})
it('does not claim the server version was verified when conflict refresh fails',async()=>{
 await render();mock.api.mockImplementation((_url:string,init:any)=>Promise.reject(Error(init?.method==='PATCH'?'版本冲突请刷新':'网络失败')))
 await act(async()=>setInput(container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement,'25'))
 await act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='保存')!.click())
 expect(container.textContent).toContain('尚未核对服务器版本');expect(container.textContent).not.toContain('服务器版本已核对')
 expect((container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement).value).toBe('25')
 expect([...container.querySelectorAll('button')].some(b=>b.textContent==='用本页输入重新保存')).toBe(false)
})

it('a failed conflict refresh retains the choice gate after later reload and displays cleared thresholds',async()=>{
 await render()
 let fetches=0,writes=0
 const latest:any=result()
 latest.items[0]={...latest.items[0],revision:{id:'new-r',status:'DRAFT',rowVersion:8,payload:{inventoryUnitSnapshot:'kg',minQty:null,maxQty:null,active:false,stagnantDays:30}}} as any
 mock.api.mockImplementation(async(_url:string,init:any)=>{
  if(init?.method==='PATCH'){
   writes++
   if(writes===1)throw Object.assign(Error('规则已修改'),{status:409})
   expect(JSON.parse(String(init.body))).toMatchObject({revisionId:'new-r',draftVersion:8,minQty:5,maxQty:25})
   return {revision:{...latest.items[0].revision,rowVersion:9,payload:{inventoryUnitSnapshot:'kg',minQty:5,maxQty:25,active:true,stagnantDays:30}}}
  }
  if(++fetches===1)throw Error('冲突刷新网络失败')
  return latest
 })
 await act(async()=>{setInput(container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement,'25');setInput(container.querySelector('input[aria-label="白菜库存上限"]') as HTMLInputElement,'18')})
 const row=()=>container.querySelector('input[aria-label="土豆库存上限"]')!.closest('tr')!
 const action=(label:string)=>Array.from(row().querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent===label)!
 await act(async()=>action('保存').click())
 expect(container.textContent).toContain('尚未核对服务器版本')
 expect(action('保存').disabled).toBe(true)
 expect(action('用本页输入重新保存')).toBeUndefined()
 await act(async()=>Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='重新加载')!.click())
 expect(row().textContent).toContain('服务器拟值：不设／不设')
 expect(row().textContent).toContain('停用')
 expect(action('保存').disabled).toBe(true)
 expect((container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement).value).toBe('25')
 expect((container.querySelector('input[aria-label="白菜库存上限"]') as HTMLInputElement).value).toBe('18')
 expect(writes).toBe(1)
 mock.confirm.mockResolvedValue(true)
 await act(async()=>action('用本页输入重新保存').click())
 expect(writes).toBe(2)
})

it('retains dirty input and navigation guard if a refreshed page omits that product',async()=>{
 await render()
 let reads=0
 mock.api.mockImplementation(async(_url:string,init:any)=>{
  if(init?.method==='PATCH')throw Object.assign(Error('规则已修改'),{status:409})
  const latest=result()
  return ++reads===1?{...latest,items:[latest.items[1]],total:1}:latest
 })
 await act(async()=>setInput(container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement,'25'))
 await act(async()=>Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='保存')!.click())
 expect(container.querySelector('input[aria-label="土豆库存上限"]')).toBeNull()
 expect(container.querySelector('[aria-label="未返回的规则草稿"]')?.textContent).toContain('土豆：5／25')
 const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);expect(unload.defaultPrevented).toBe(true)
 await act(async()=>Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='重新读取未返回草稿')!.click())
 expect((container.querySelector('input[aria-label="土豆库存上限"]') as HTMLInputElement).value).toBe('25')
 const row=container.querySelector('input[aria-label="土豆库存上限"]')!.closest('tr')!
 expect(Array.from(row.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='保存')!.disabled).toBe(true)
 expect(row.textContent).toContain('用本页输入重新保存')
})

async function renderAuditedRule(write:(url:string,init:any)=>Promise<any>,read?:()=>any){
 const data:any=result();data.items[0].revision={id:'r-unknown',status:'AUDITED',rowVersion:2,payload:{inventoryUnitSnapshot:'kg',minQty:5,maxQty:30,active:true,stagnantDays:30}};
 mock.confirm.mockResolvedValue(true);mock.api.mockImplementation((url:string,init:any)=>init?.method==='POST'?write(url,init):Promise.resolve(read?(read()??data):data));
 container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);await act(async()=>root!.render(<InventoryRules/>));return data;
}
function ruleButton(label:string){return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent===label)!}
it('unknown review freezes new actions and replays exactly the original approval request',async()=>{
 let writes=0;let data:any;data=await renderAuditedRule(async()=>{if(++writes===1)throw Error('响应丢失');data.items[0].revision.status='REVIEWED';data.items[0].revision.rowVersion=3;return {}},()=>data);
 await act(async()=>ruleButton('复审').click());expect(container.textContent).toContain('审批结果尚未确认');expect(ruleButton('反审核').disabled).toBe(true);expect(container.querySelector<HTMLInputElement>('input[aria-label="白菜库存上限"]')!.disabled).toBe(true);
 const navigation=new CustomEvent(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT,{cancelable:true,detail:{proceed:vi.fn()}});await act(async()=>window.dispatchEvent(navigation));expect(navigation.defaultPrevented).toBe(true);expect(container.textContent).toContain('离开不会撤销');await act(async()=>ruleButton('取消').click());
 await act(async()=>ruleButton('核对原审批').click());const calls=mock.api.mock.calls.filter(([,init])=>init?.method==='POST');expect(calls).toHaveLength(2);expect(calls[0]).toEqual(calls[1]);expect(container.textContent).toContain('已复审 · 已生效');expect(ruleButton('核对原审批')).toBeUndefined();
});
it('repeated unknown approval keeps the original request and unrelated dirty input',async()=>{
 await renderAuditedRule(async()=>{throw Object.assign(Error('暂时不可用'),{status:503})});await act(async()=>setInput(container.querySelector<HTMLInputElement>('input[aria-label="白菜库存上限"]')!,'18'));
 await act(async()=>ruleButton('复审').click());await act(async()=>ruleButton('核对原审批').click());const calls=mock.api.mock.calls.filter(([,init])=>init?.method==='POST');expect(calls).toHaveLength(2);expect(calls[0]).toEqual(calls[1]);expect(ruleButton('反审核').disabled).toBe(true);expect(container.querySelector<HTMLInputElement>('input[aria-label="白菜库存上限"]')!.value).toBe('18');const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);expect(unload.defaultPrevented).toBe(true);
});
it('known approval refusal does not pretend to be an unknown result',async()=>{
 await renderAuditedRule(async()=>{throw Object.assign(Error('不能复审'),{status:403})});await act(async()=>ruleButton('复审').click());expect(container.textContent).toContain('不能复审');expect(ruleButton('核对原审批')).toBeUndefined();expect(ruleButton('反审核').disabled).toBe(false);
});
it('approval conflict freezes writes until a correct latest read succeeds',async()=>{
 let data:any;let failed=false;data=await renderAuditedRule(async()=>{failed=true;throw Object.assign(Error('版本冲突'),{status:409})},()=>{if(failed)throw Error('读取断开');return data});
 await act(async()=>ruleButton('复审').click());expect(ruleButton('反审核').disabled).toBe(true);expect(ruleButton('核对原审批')).toBeUndefined();failed=false;await act(async()=>ruleButton('重新加载').click());expect(ruleButton('反审核').disabled).toBe(false);
});

it('successful approval ACK with failed read allows only a latest read, not replay',async()=>{
 let data:any,writeDone=false,readFails=true;data=await renderAuditedRule(async()=>{writeDone=true;data.items[0].revision.status='REVIEWED';return {}},()=>{if(writeDone&&readFails)throw Error('读失败');return data});
 await act(async()=>ruleButton('复审').click());expect(container.textContent).toContain('审批已成功');expect(ruleButton('核对原审批')).toBeUndefined();expect(ruleButton('开始新修订').disabled).toBe(true);expect(container.querySelector<HTMLInputElement>('input[aria-label="白菜库存上限"]')!.disabled).toBe(true);
 readFails=false;await act(async()=>ruleButton('重新加载').click());expect(ruleButton('开始新修订').disabled).toBe(false);expect(mock.api.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});
it('approval ACK cannot unlock a filtered read that omits the approved product',async()=>{
 let data:any,writeDone=false,omit=true;data=await renderAuditedRule(async()=>{writeDone=true;return {}},()=>writeDone&&omit?{...data,items:[data.items[1]]}:data);
 await act(async()=>ruleButton('复审').click());expect(container.textContent).toContain('审批已成功');expect(ruleButton('反审核').disabled).toBe(true);omit=false;await act(async()=>ruleButton('重新加载').click());expect(ruleButton('反审核').disabled).toBe(false);expect(mock.api.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});
it('approval confirmation cannot proceed if its rule is changed during confirmation',async()=>{
 await renderAuditedRule(async()=>({}));let finish:(value:boolean)=>void=()=>{};mock.confirm.mockImplementation(()=>new Promise<boolean>(resolve=>finish=resolve));
 await act(async()=>ruleButton('复审').click());await act(async()=>setInput(container.querySelector<HTMLInputElement>('input[aria-label="土豆库存上限"]')!,'33'));await act(async()=>finish(true));expect(mock.api.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);expect(container.textContent).toContain('规则输入、来源或版本已变化');
});

it('unknown approval cannot be unlocked by resetting unchanged query or submitting the same filters',async()=>{
 await renderAuditedRule(async()=>{throw Error('连接失败')});await act(async()=>ruleButton('复审').click());expect(ruleButton('重置').disabled).toBe(true);expect(ruleButton('查询').disabled).toBe(true);await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));expect(ruleButton('核对原审批')).toBeDefined();expect(ruleButton('反审核').disabled).toBe(true);expect(mock.api.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});

it('上下限没有打印，编辑保存取消同行；取消仅恢复本行且不写服务器',async()=>{
 mock.confirm.mockResolvedValue(true);await render()
 const potato=container.querySelector<HTMLInputElement>('[aria-label="土豆库存上限"]')!
 const cabbage=container.querySelector<HTMLInputElement>('[aria-label="白菜库存上限"]')!
 await act(async()=>{setInput(potato,'25');setInput(cabbage,'18')})
 const row=potato.closest('tr')!,edit=row.querySelector('a')!,group=edit.parentElement!
 expect(Array.from(group.children).map(element=>element.textContent)).toEqual(['编辑','保存','取消'])
 expect(Array.from(container.querySelectorAll('button')).some(button=>button.textContent==='打印')).toBe(false)
 await act(async()=>Array.from(group.querySelectorAll('button')).find(button=>button.textContent==='取消')!.click())
 expect(potato.value).toBe('20');expect(cabbage.value).toBe('18')
 expect(mock.api.mock.calls.every(([,init])=>!init?.method)).toBe(true)
})
