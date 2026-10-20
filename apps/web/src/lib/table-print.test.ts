// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { prepareTablePrint } from './table-print'
afterEach(() => { document.body.innerHTML=''; document.head.innerHTML=''; vi.restoreAllMocks() })
it('preserves every long row once, repeats headings, hides controls and restores after cleanup', () => {
  const source=document.createElement('section')
  source.innerHTML='<header data-management-print-controls>屏幕按钮</header><h1>盘点测试</h1><table><thead><tr><th>物品</th></tr></thead><tbody>'+Array.from({length:5},(_,i)=>`<tr><td>行${i}</td></tr>`).join('')+'</tbody><tfoot><tr><td>合计</td></tr></tfoot></table>'
  document.body.appendChild(source)
  vi.spyOn(Element.prototype,'getBoundingClientRect').mockImplementation(function(this:Element){return {top:0,height:this.matches('tbody > tr')?200:0,bottom:0,left:0,right:100,width:100,x:0,y:0,toJSON(){return {}}} as DOMRect})
  const clear=prepareTablePrint(source)
  expect(document.querySelectorAll('[data-table-print-page]')).toHaveLength(3)
  expect(Array.from(document.querySelectorAll('[data-table-print-root] tbody > tr')).map(r=>r.textContent)).toEqual(['行0','行1','行2','行3','行4'])
  expect(document.querySelectorAll('[data-table-print-root] thead')).toHaveLength(3)
  expect(document.querySelectorAll('[data-table-print-root] tfoot')).toHaveLength(1)
  expect(document.querySelector('[data-table-print-root] [data-management-print-controls]')).toBeNull()
  clear();expect(document.querySelector('[data-table-print-root]')).toBeNull();expect(source.textContent).toContain('屏幕按钮')
})
it('keeps different selected documents on separate pages', () => {
  const source=document.createElement('section');source.innerHTML='<article><h1>单A</h1><table><tbody><tr><td>A</td></tr></tbody></table></article><article><h1>单B</h1><table><tbody><tr><td>B</td></tr></tbody></table></article>'
  document.body.appendChild(source);const clear=prepareTablePrint(source,'article');expect(document.querySelectorAll('[data-table-print-page]')).toHaveLength(2);expect(source.querySelectorAll('article')).toHaveLength(2);clear()
})
it('reserves space for the total and signatures on the final page',()=>{
 const source=document.createElement('section');source.innerHTML='<h1>采购入库单</h1><table><thead><tr><th>商品</th></tr></thead><tbody>'+Array.from({length:4},(_,i)=>`<tr><td>${i}</td></tr>`).join('')+'</tbody><tfoot><tr><td>合计与签字</td></tr></tfoot></table>';document.body.appendChild(source)
 vi.spyOn(Element.prototype,'getBoundingClientRect').mockImplementation(function(this:Element){return {top:0,height:this.matches('tbody > tr')?140:this.matches('tfoot')?100:0,bottom:0,left:0,right:100,width:100,x:0,y:0,toJSON(){return {}}} as DOMRect})
 const clear=prepareTablePrint(source);const pages=document.querySelectorAll('[data-table-print-page]')
 expect(pages).toHaveLength(2);expect(pages[0].querySelector('tfoot')).toBeNull();expect(pages[1].querySelector('tfoot')?.textContent).toBe('合计与签字')
 expect(document.querySelectorAll('[data-table-print-root] tbody > tr')).toHaveLength(4);clear()
})
