// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WarehouseDocsPage from './page'
import { WarehouseDocumentEditor } from './warehouse-document-editor'
import { apiFetch } from '@/lib/v2-auth'

const actor=vi.hoisted(()=>({role:'SUPPLY_CHAIN'}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@/lib/v2-auth', () => ({ apiFetch: vi.fn(), getUser: () => actor }))
vi.mock('@/lib/warehouse-view-state', () => ({
  readWarehouseViewState: (_key: string, fallback: unknown) => fallback,
  writeWarehouseViewState: vi.fn(), useWarehouseScrollRestoration: vi.fn(),
}))
vi.mock('@/components/v2/warehouse-tool-tabs', () => ({ WarehouseToolTabs: () => null }))
vi.mock('@/components/v2/date-range-calendar', () => ({ DateRangeCalendar: () => null }))
vi.mock('@/components/v2/report-actions', () => ({ ReportActions: () => null, collectReportPages: vi.fn() }))
vi.mock('@/components/v2/responsive-data-table', () => ({ ResponsiveDataTable: ({ children }: {children: React.ReactNode}) => <div>{children}</div> }))
const fetch = vi.mocked(apiFetch)
let root: ReturnType<typeof createRoot> | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.replaceChildren()
  window.history.replaceState({}, '', '/')
  actor.role='SUPPLY_CHAIN'
  vi.clearAllMocks()
})

async function open(type: string, attachments: unknown[], options:Record<string,unknown>={}) {
  const doc = { id: 'doc', docNo: 'CK-TEST', type, status: 'POSTED', reviewStatus: 'UNREVIEWED', reason: '总仓自损：搬运损坏', attachmentCount: attachments.length, attachments, lines: [], logs: [], createdAt: '2026-10-10T00:00:00Z', effectiveAt: '2026-10-10', totalAmount: 4, ...options }
  fetch.mockImplementation(async (url: string) => {
    if (url === '/api/warehouse-docs/doc/unreview') { Object.assign(doc,{reviewStatus:'UNREVIEWED'}); return {ok:true} as any }
    if (url === '/api/warehouse-docs/doc/review') { Object.assign(doc,{reviewStatus:'REVIEWED'}); return {ok:true} as any }
    if (url === '/api/warehouse-docs/doc') return doc as any
    if (url.startsWith('/api/warehouse-docs?')) return { items: [doc], total: 1 } as any
    if (url.startsWith('/api/suppliers?')) return [] as any
    throw new Error(`Unexpected request ${url}`)
  })
  window.history.replaceState({}, '', '/?doc=doc')
  const host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<WarehouseDocsPage />))
  return host
}

const file = { name: '模拟现场.png', mime: 'image/png', size: 1024, url: 'http://127.0.0.1:4446/object?key=test' }
describe('warehouse document evidence', () => {
  it('shows the stored outbound evidence and its signed link after opening a document', async () => {
    const host = await open('MANUAL_OUTBOUND', [file])
    expect(host.textContent).toContain('现场证据（1份）')
    expect(host.querySelector('a[href="http://127.0.0.1:4446/object?key=test"]')?.textContent).toContain('模拟现场.png')
    expect(host.textContent).toContain('1 份')
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('/confirm'))).toBe(true)
  })
  it('preserves inbound document attachments', async () => {
    const host = await open('MANUAL_INBOUND', [file])
    expect(host.textContent).toContain('供应商随货单据（1份）')
    expect(host.querySelector('a[href="http://127.0.0.1:4446/object?key=test"]')).not.toBeNull()
  })
  it('leaves historical outbound documents without evidence readable', async () => {
    const host = await open('MANUAL_OUTBOUND', [])
    expect(host.textContent).toContain('现场证据（0份）')
    expect(host.textContent).toContain('未上传')
    expect(host.textContent).toContain('CK-TEST')
  })
})

describe('DEC034 supply-chain receipt review boundary',()=>{
 it('shows no inbound audit or review actions to finance',async()=>{
  actor.role='FINANCE';const host=await open('MANUAL_INBOUND',[],{status:'CONFIRMED'})
  expect(Array.from(host.querySelectorAll('button')).some(b=>b.textContent==='复审'||b.textContent?.includes('反审核'))).toBe(false)
 })
 it('lets supply-chain review and then locks the confirmed receipt',async()=>{
  actor.role='SUPPLY_CHAIN';const host=await open('MANUAL_INBOUND',[],{status:'CONFIRMED'})
  const review=Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='复审')!
  await act(async()=>review.click())
  const confirmation=Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='确认复审')!
  await act(async()=>confirmation.click())
  expect(host.textContent).toContain('已复审（锁定）')
  expect(Array.from(host.querySelectorAll('button')).some(b=>b.textContent==='复审'||b.textContent?.includes('反审核'))).toBe(false)
 })
 it('keeps outbound documents outside this accountant receipt feature',async()=>{
  actor.role='FINANCE';const host=await open('MANUAL_OUTBOUND',[],{status:'CONFIRMED'})
  expect(Array.from(host.querySelectorAll('button')).some(b=>b.textContent==='复审')).toBe(false)
 })
})

 it('final reviewed document has no cancellation or reverse action',async()=>{
  const host=await open('MANUAL_INBOUND',[],{status:'CONFIRMED',reviewStatus:'REVIEWED'})
  expect(Array.from(host.querySelectorAll('button')).some(button=>button.textContent==='取消复审'||button.textContent?.includes('反审核'))).toBe(false)
  expect(fetch.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(0)
  expect(host.querySelector('thead')?.textContent).toContain('复审状态')
 })

const changeInput = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('document edit safeguards', () => {
  it('freezes stale approval after reverse409, preserves reason on failed reload, resumes only after latest GET', async () => {
    const host = await open('MANUAL_INBOUND', [], { status: 'CONFIRMED' })
    const previous = fetch.getMockImplementation()!
    let conflict = false, failRead = true
    fetch.mockImplementation(async (url: string, options?: any) => {
      if (url === '/api/warehouse-docs/doc/unconfirm') { conflict = true; throw Object.assign(new Error('只有已审核的单据才能反审核'), { status: 409 }) }
      if (url === '/api/warehouse-docs/doc' && conflict) {
        if (failRead) throw new Error('最新状态读取失败')
        return { ...(await previous(url, options) as any), status: 'POSTED' } as any
      }
      return previous(url, options)
    })
    const editor = host.querySelector('.max-w-4xl')!
    const find = (name: string) => [...editor.querySelectorAll('button')].find(b => b.textContent === name)!
    await act(async () => find('反审核（退回仓库修改）').click())
    const reason = host.querySelector('input[placeholder="退回原因（必填，仓库人员会看到）"]') as HTMLInputElement
    await changeInput(reason, '必须保留的退回原因')
    await act(async () => find('确认退回').click())
    expect(host.textContent).toContain('请先加载最新单据状态')
    expect(find('确认退回').disabled).toBe(true)
    expect(find('复审').disabled).toBe(true)
    expect(reason.value).toBe('必须保留的退回原因')
    await act(async () => find('确认退回').click())
    expect(fetch.mock.calls.filter(call => String(call[0]).endsWith('/unconfirm'))).toHaveLength(1)
    await act(async () => find('加载最新单据状态').click())
    expect(host.textContent).toContain('最新状态读取失败')
    expect(find('确认退回').disabled).toBe(true)
    expect(reason.value).toBe('必须保留的退回原因')
    failRead = false
    await act(async () => find('加载最新单据状态').click())
    expect(find('确认退回')).toBeUndefined()
    expect(find('复审')).toBeUndefined()
    expect(find('审核（锁定单据）').disabled).toBe(false)
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1)
  })

  it('does not enable stale audit when successful POST is followed by failed GET', async () => {
    const host = await open('MANUAL_INBOUND', [])
    const previous = fetch.getMockImplementation()!
    let written = false, failRead = true
    fetch.mockImplementation(async (url: string, options?: any) => {
      if (url === '/api/warehouse-docs/doc/confirm') { written = true; return { ok: true } as any }
      if (url === '/api/warehouse-docs/doc' && written) {
        if (failRead) throw new Error('审核已成功但读取失败')
        return { ...(await previous(url, options) as any), status: 'CONFIRMED' } as any
      }
      return previous(url, options)
    })
    const editor = host.querySelector('.max-w-4xl')!
    const find = (name: string) => [...editor.querySelectorAll('button')].find(b => b.textContent === name)!
    await act(async () => find('审核（锁定单据）').click())
    expect(host.textContent).toContain('审核已成功但读取失败')
    expect(find('审核（锁定单据）').disabled).toBe(true)
    await act(async () => find('审核（锁定单据）').click())
    expect(fetch.mock.calls.filter(call => String(call[0]).endsWith('/confirm'))).toHaveLength(1)
    failRead = false
    await act(async () => find('加载最新单据状态').click())
    expect(find('审核（锁定单据）')).toBeUndefined()
    expect(find('复审').disabled).toBe(false)
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1)
  })
  it('closes an old review confirmation when switching document and never posts to its source', async () => {
    const base = { type:'MANUAL_INBOUND',status:'CONFIRMED',reviewStatus:'UNREVIEWED',lines:[],logs:[],attachments:[],totalAmount:0,effectiveAt:'2026-10-12',createdAt:'2026-10-12' }
    fetch.mockImplementation(async (url: string) => {
      if (url === '/api/warehouse-docs/a') return { ...base, id:'a', docNo:'DOC-A' } as any
      if (url === '/api/warehouse-docs/b') return { ...base, id:'b', docNo:'DOC-B' } as any
      if (url.startsWith('/api/suppliers')) return [] as any
      throw new Error('Unexpected ' + url)
    })
    const host=document.createElement('div');document.body.append(host);root=createRoot(host)
    const show = (id: string) => <WarehouseDocumentEditor docId={id} fullPage canAudit canReview canEdit onClose={()=>{}} onChanged={()=>{}} />
    await act(async () => root!.render(show('a')))
    await act(async () => [...host.querySelectorAll('button')].find(b=>b.textContent==='复审')!.click())
    expect(host.querySelector('[role="dialog"][aria-label="复审"]')).not.toBeNull()
    await act(async () => root!.render(show('b')))
    expect(host.textContent).toContain('DOC-B')
    expect(host.querySelector('[role="dialog"][aria-label="复审"]')).toBeNull()
    expect(fetch.mock.calls.filter(call=>call[1]?.method==='POST')).toHaveLength(0)
  })
  it('preserves changed business inputs across explicit reload after save409', async () => {
    const host = await open('MANUAL_INBOUND', [], { lines:[{id:'line',lineNo:1,productId:'product',productName:'测试土豆',quantity:5,unit:'kg',unitPrice:12,amount:60,inventoryQuantity:5,inventoryUnit:'kg'}] })
    const previous=fetch.getMockImplementation()!
    fetch.mockImplementation(async (url:string,options?:any) => {
      if(options?.method==='PUT') throw Object.assign(new Error('单据已被其他页面操作'),{status:409})
      return previous(url,options)
    })
    const editor=host.querySelector('.max-w-4xl')!
    const find=(name:string)=>[...editor.querySelectorAll('button')].find(b=>b.textContent===name)!
    await changeInput(host.querySelector('[aria-label="测试土豆数量"]')!,'8')
    await changeInput(host.querySelector('[aria-label="单据备注"]')!,'本页未保存备注')
    await changeInput(host.querySelector('input[placeholder^="修改原因"]')!,'原修改原因')
    await act(async()=>find('保存修改').click())
    expect(find('保存修改').disabled).toBe(true)
    expect(find('审核（锁定单据）').disabled).toBe(true)
    await act(async()=>find('加载最新单据状态').click())
    expect((host.querySelector('[aria-label="测试土豆数量"]') as HTMLInputElement).value).toBe('8')
    expect((host.querySelector('[aria-label="单据备注"]') as HTMLInputElement).value).toBe('本页未保存备注')
    expect((host.querySelector('input[placeholder^="修改原因"]') as HTMLInputElement).value).toBe('原修改原因')
    expect(find('保存修改').disabled).toBe(false)
    expect(fetch.mock.calls.filter(call=>call[1]?.method==='PUT')).toHaveLength(1)
  })
  it('late completion of an old review cannot close a new document confirmation', async () => {
    const base={type:'MANUAL_INBOUND',status:'CONFIRMED',reviewStatus:'UNREVIEWED',lines:[],logs:[],attachments:[],totalAmount:0,effectiveAt:'2026-10-12',createdAt:'2026-10-12'}
    let resolveOld!: (value:any)=>void
    fetch.mockImplementation(async (url:string,options?:any)=>{
      if(url==='/api/warehouse-docs/a/review') return new Promise(resolve=>{resolveOld=resolve})
      if(url==='/api/warehouse-docs/a') return {...base,id:'a',docNo:'DOC-A'} as any
      if(url==='/api/warehouse-docs/b') return {...base,id:'b',docNo:'DOC-B'} as any
      if(url.startsWith('/api/suppliers')) return [] as any
      throw new Error('Unexpected '+url)
    })
    const host=document.createElement('div');document.body.append(host);root=createRoot(host)
    const changed=vi.fn();const show=(id:string)=><WarehouseDocumentEditor docId={id} fullPage canAudit canReview canEdit onClose={()=>{}} onChanged={changed}/>
    const find=(name:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===name)!
    await act(async()=>root!.render(show('a')))
    await act(async()=>find('复审').click());await act(async()=>find('确认复审').click())
    await act(async()=>root!.render(show('b')))
    await act(async()=>find('复审').click())
    expect(host.querySelector('[role="dialog"][aria-label="复审"]')).not.toBeNull()
    await act(async()=>resolveOld({ok:true}))
    expect(host.textContent).toContain('DOC-B')
    expect(host.querySelector('[role="dialog"][aria-label="复审"]')).not.toBeNull()
    expect(changed).not.toHaveBeenCalled()
    expect(fetch.mock.calls.filter(call=>call[1]?.method==='POST').map(call=>call[0])).toEqual(['/api/warehouse-docs/a/review'])
  })
  it('blocks auditing an unsaved header and keeps the input', async () => {
    const host = await open('MANUAL_INBOUND', [])
    await changeInput(host.querySelector('input[aria-label="单据备注"]')!, '尚未保存的备注')
    await act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === '审核（锁定单据）')!.click())
    expect(host.textContent).toContain('请先保存修改，再审核单据')
    expect((host.querySelector('input[aria-label="单据备注"]') as HTMLInputElement).value).toBe('尚未保存的备注')
    expect(fetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  })
  it('canceling leave keeps line edits without writing any data', async () => {
    const host = await open('MANUAL_INBOUND', [], {lines: [{id:'line',lineNo:1,productId:'product',productName:'测试土豆',quantity:5,unit:'kg',unitPrice:12,amount:60,inventoryQuantity:5,inventoryUnit:'kg'}]})
    await changeInput(host.querySelector('input[aria-label="测试土豆数量"]')!, '8')
    await act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === '关闭')!.click())
    expect(host.textContent).toContain('放弃未保存的单据修改？')
    await act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === '取消')!.click())
    expect((host.querySelector('input[aria-label="测试土豆数量"]') as HTMLInputElement).value).toBe('8')
    expect(fetch.mock.calls.some(([, options]) => options?.method)).toBe(false)
  })
  it('unit-price edits update amount using the current input quantity and invalid numbers never save', async () => {
    const host = await open('MANUAL_INBOUND', [], {lines: [{id:'line',lineNo:1,productId:'product',productName:'测试土豆',quantity:5,unit:'kg',unitPrice:12,amount:60,inventoryQuantity:5,inventoryUnit:'kg'}]})
    await changeInput(host.querySelector('input[aria-label="测试土豆入库单价"]')!, '15')
    expect((host.querySelector('input[aria-label="测试土豆金额"]') as HTMLInputElement).value).toBe('75')
    expect(host.querySelector('tfoot')?.textContent).toContain('75.00')
    await changeInput(host.querySelector('input[aria-label="测试土豆数量"]')!, '不是数字')
    await changeInput(host.querySelector('input[placeholder^="修改原因"]')!, '测试原因')
    await act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === '保存修改')!.click())
    expect(host.textContent).toContain('数量和金额必须是有效且大于0的数字')
    expect(fetch.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false)
  })
  it('keeps unsaved changes when a save fails, and does not audit afterward', async () => {
    const host = await open('MANUAL_INBOUND', [])
    const currentFetch = fetch.getMockImplementation()!
    fetch.mockImplementation(async (url: string, options?: any) => {
      if (options?.method === 'PUT') throw new Error('模拟网络中断')
      return currentFetch(url, options)
    })
    await changeInput(host.querySelector('input[aria-label="单据备注"]')!, '需要保留的备注')
    await changeInput(host.querySelector('input[placeholder^="修改原因"]')!, '测试修改原因')
    await act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === '保存修改')!.click())
    expect(host.textContent).toContain('模拟网络中断')
    expect((host.querySelector('input[aria-label="单据备注"]') as HTMLInputElement).value).toBe('需要保留的备注')
    await act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === '审核（锁定单据）')!.click())
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
  })
})


describe('warehouse edit persisted decimal precision', () => {
  it.each([
    ['数量', 'quantity', 1, '1.000001'],
    ['数量', 'quantity', 1.000001, '1'],
    ['金额', 'amount', 1, '1.0001'],
    ['金额', 'amount', 0.0001, '0.0002'],
    ['数量', 'quantity', 99999998.000001, '99999998.000002'],
  ])('sends the smallest representable %s change (%s %s → %s)', async (label, field, before, after) => {
    const line = {id:'line',lineNo:1,productId:'product',productName:'精度测试商品',quantity:1,unit:'kg',unitPrice:1,amount:1,inventoryQuantity:1,inventoryUnit:'kg',[field]:before}
    const host = await open('MANUAL_INBOUND', [], {lines:[line]})
    const previous = fetch.getMockImplementation()!
    fetch.mockImplementation(async (url:string, options?:any) => options?.method === 'PUT' ? {ok:true,changed:true} as any : previous(url,options))
    await changeInput(host.querySelector(`[aria-label="精度测试商品${label}"]`)! as HTMLInputElement, after)
    await changeInput(host.querySelector('input[placeholder^="修改原因"]')! as HTMLInputElement,'最小精度修改验收')
    const save=[...host.querySelectorAll('button')].find(button=>button.textContent==='保存修改')!
    expect(save.disabled).toBe(false)
    await act(async()=>save.click())
    const writes=fetch.mock.calls.filter(call=>call[1]?.method==='PUT')
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0][1]!.body as string).lines[0][field]).toBe(Number(after))
  })
})


describe('warehouse unknown write result', () => {
  it.each(['save','confirm','unconfirm','review'].flatMap(action=>['network','503','parse','408'].map(error=>[action,error])))('%s %s freezes stale actions until explicit latest GET',async(action, failure)=>{
    const line={id:'line',lineNo:1,productId:'product',productName:'未知结果测试商品',quantity:1,unit:'kg',unitPrice:1,amount:1,inventoryQuantity:1,inventoryUnit:'kg'}
    const host=await open('MANUAL_INBOUND',[],{status:['unconfirm','review'].includes(action)?'CONFIRMED':'POSTED',lines:[line]})
    const previous=fetch.getMockImplementation()!
    fetch.mockImplementation(async(url:string,options?:any)=>{
      if(options?.method==='PUT'||options?.method==='POST')throw failure==='503'?Object.assign(new Error('服务暂不可用'),{status:503}):failure==='408'?Object.assign(new Error('响应超时'),{status:408}):failure==='parse'?new SyntaxError('成功响应无法解析'):new TypeError('网络连接失败')
      return previous(url,options)
    })
    const editor=host.querySelector('.max-w-4xl')!
    const find=(name:string)=>[...editor.querySelectorAll('button'),...host.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find(b=>b.textContent===name)!
    if(action==='save'){
      await changeInput(host.querySelector('[aria-label="未知结果测试商品数量"]')!,'2')
      await changeInput(host.querySelector('input[placeholder^="修改原因"]')!,'未知写结果验收')
      await act(async()=>find('保存修改').click())
    }else if(action==='confirm')await act(async()=>find('审核（锁定单据）').click())
    else if(action==='unconfirm'){
      await act(async()=>find('反审核（退回仓库修改）').click())
      await changeInput(host.querySelector('input[placeholder^="退回原因"]')!,'未知退回结果保留')
      await act(async()=>find('确认退回').click())
    }else{
      await act(async()=>find('复审').click())
      await act(async()=>find('确认复审').click())
    }
    expect(find('加载最新单据状态')).toBeDefined()
    const actionButton=find(action==='save'?'保存修改':action==='confirm'?'审核（锁定单据）':action==='unconfirm'?'确认退回':'复审')
    expect(actionButton.disabled).toBe(true)
    await act(async()=>actionButton.click())
    expect(fetch.mock.calls.filter(call=>['POST','PUT'].includes(call[1]?.method||''))).toHaveLength(1)
    if(action==='review')await act(async()=>find('取消').click())
    await act(async()=>find('加载最新单据状态').click())
    if(action==='save')expect((host.querySelector('[aria-label="未知结果测试商品数量"]') as HTMLInputElement).value).toBe('2')
    expect(fetch.mock.calls.filter(call=>['POST','PUT'].includes(call[1]?.method||''))).toHaveLength(1)
  })
})


it.each([400,403])('known business rejection %s preserves editability and original message',async status=>{
 const host=await open('MANUAL_INBOUND',[],{lines:[{id:'line',lineNo:1,productId:'product',productName:'明确拒绝测试商品',quantity:1,unit:'kg',unitPrice:1,amount:1,inventoryQuantity:1,inventoryUnit:'kg'}]})
 const previous=fetch.getMockImplementation()!
 fetch.mockImplementation(async(url:string,options?:any)=>options?.method==='PUT'?Promise.reject(Object.assign(new Error('明确业务拒绝'),{status})):previous(url,options))
 await changeInput(host.querySelector('[aria-label="明确拒绝测试商品数量"]')!,'2')
 await changeInput(host.querySelector('input[placeholder^="修改原因"]')!,'明确拒绝保留')
 const editor=host.querySelector('.max-w-4xl')!,save=[...editor.querySelectorAll('button')].find(b=>b.textContent==='保存修改')!
 await act(async()=>save.click())
 expect(host.textContent).toContain('明确业务拒绝')
 expect(save.disabled).toBe(false)
 expect([...editor.querySelectorAll('button')].some(b=>b.textContent==='加载最新单据状态')).toBe(false)
 expect((host.querySelector('[aria-label="明确拒绝测试商品数量"]') as HTMLInputElement).value).toBe('2')
})

it('audit entry opens the full editor without a blocking confirmation or automatic write; footer audits once',async()=>{
 const doc={id:'doc',docNo:'AUDIT-TEST',type:'MANUAL_INBOUND',status:'POSTED',reviewStatus:'UNREVIEWED',lines:[],logs:[],attachments:[],totalAmount:0,effectiveAt:'2026-10-12',createdAt:'2026-10-12'}
 let finish!: (value:any)=>void
 fetch.mockImplementation(async(url:string,options?:any)=>{
  if(url==='/api/warehouse-docs/doc/confirm')return new Promise(resolve=>{finish=resolve})
  if(url==='/api/warehouse-docs/doc')return {...doc} as any
  if(url.startsWith('/api/suppliers'))return [] as any
  throw new Error('Unexpected '+url)
 })
 const host=document.createElement('div');document.body.append(host);root=createRoot(host)
 await act(async()=>root!.render(<WarehouseDocumentEditor docId="doc" initialAction="audit" fullPage canAudit canReview canEdit onClose={()=>{}} onChanged={()=>{}}/>))
 expect(host.textContent).not.toContain('确认审核');expect(host.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull()
 expect(fetch.mock.calls.some(([,options])=>options?.method)).toBe(false)
 const audit=Array.from(host.querySelectorAll<HTMLButtonElement>('footer button')).find(button=>button.textContent==='审核')!
 expect(audit).toBeTruthy()
 act(()=>{audit.click();audit.click()})
 expect(fetch.mock.calls.filter(([url])=>url==='/api/warehouse-docs/doc/confirm')).toHaveLength(1)
 await act(async()=>{doc.status='CONFIRMED';finish({ok:true})})
})

describe('outbound quality compatibility',()=>{
 it('keeps the original editable outbound quality entry',async()=>{
  const host=await open('MANUAL_OUTBOUND',[])
  expect(Array.from(host.querySelectorAll('button')).some(b=>b.textContent==='质检')).toBe(true)
  expect(Array.from(host.querySelectorAll('button')).some(b=>b.textContent==='历史整单图片（未分配）')).toBe(false)
 })
 it('keeps inbound whole-document history separate and read only',async()=>{
  const host=await open('MANUAL_INBOUND',[])
  expect(Array.from(host.querySelectorAll('button')).some(b=>b.textContent==='历史整单图片（未分配）')).toBe(true)
 })
})
