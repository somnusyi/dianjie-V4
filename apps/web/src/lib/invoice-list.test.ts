import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from './v2-auth'
import { loadInvoices } from './invoice-list'
vi.mock('./v2-auth', () => ({ apiFetch: vi.fn() }))
const mockFetch=vi.mocked(apiFetch)
const rows=(start:number,count:number)=>Array.from({length:count},(_,i)=>({id:`invoice-${start+i}`}))
beforeEach(()=>{ mockFetch.mockReset() })
describe('complete invoice list',()=>{
 it.each([0,1,49,50,51,100])('loads all %i rows and checks the last full page',async count=>{
  const all=rows(0,count)
  mockFetch.mockImplementation(async url=>{const cursor=new URL(String(url),'http://local').searchParams.get('cursor');const start=cursor?all.findIndex(x=>x.id===cursor)+1:0;return all.slice(start,start+50) as any})
  expect(await loadInvoices()).toEqual(all)
  expect(mockFetch).toHaveBeenCalledTimes(Math.floor(count/50)+1)
 })
 it('fails instead of returning a partial list when a later page fails',async()=>{
  mockFetch.mockResolvedValueOnce(rows(0,50) as any).mockRejectedValueOnce(new Error('第二页读取失败'))
  await expect(loadInvoices()).rejects.toThrow('第二页读取失败')
 })
 it('rejects an old server repeating the first page rather than looping or hiding duplicates',async()=>{
  mockFetch.mockResolvedValue(rows(0,50) as any)
  await expect(loadInvoices()).rejects.toThrow('未完整加载')
  expect(mockFetch).toHaveBeenCalledTimes(2)
 })
 it.each([null,{},[{id:''}],[{id:1}],rows(0,51)])('rejects invalid page %#',async page=>{
  mockFetch.mockResolvedValue(page as any)
  await expect(loadInvoices()).rejects.toThrow('未完整加载')
 })
 it('rejects a repeated row even if the second page has a new last cursor',async()=>{
  mockFetch.mockResolvedValueOnce(rows(0,50) as any).mockResolvedValueOnce([{id:'invoice-1'},{id:'invoice-50'}] as any)
  await expect(loadInvoices()).rejects.toThrow('未完整加载')
 })
})

it('keeps the selected status on later pages', async()=>{
 mockFetch.mockResolvedValueOnce(rows(0,50) as any).mockResolvedValueOnce(rows(50,1) as any)
 await loadInvoices('PENDING')
 expect(mockFetch.mock.calls[1][0]).toBe('/api/invoices?status=PENDING&cursor=invoice-49')
})
