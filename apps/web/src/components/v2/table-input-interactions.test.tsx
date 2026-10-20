// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,expect,it,vi} from 'vitest'
import {navigateTableInput,protectNumberWheel,TableInputInteractions} from './table-input-interactions'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
const rect=vi.spyOn(HTMLElement.prototype,'getClientRects').mockImplementation(function(this:HTMLElement){return this.style.display==='none'?[]:[{width:10,height:10}] as any})
afterEach(()=>{document.body.innerHTML='';vi.clearAllMocks()})
function grid(){
 document.body.innerHTML='<table><thead><tr><th>A</th><th>B</th><th>C</th><th>D</th></tr></thead><tbody><tr><td>商品甲</td><td><input id="q1" type="number" value="2"></td><td><input id="p1" type="number" value="10.25"></td><td><input id="n1" value="备注"></td></tr><tr><td>商品乙</td><td><input id="q2" type="number" value="3"></td><td><input id="p2" type="number" value="20"></td><td><input id="n2" value="说明"></td></tr></tbody></table>'
 const input=(id:string)=>document.getElementById(id) as HTMLInputElement
 const key=(id:string,key:string,extra:KeyboardEventInit={})=>{input(id).focus();const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra});input(id).addEventListener('keydown',navigateTableInput,{once:true});input(id).dispatchEvent(event);return event}
 return {input,key}
}
it('all four arrows navigate editable cells without changing quantities or prices',()=>{
 const {input,key}=grid()
 expect(key('q1','ArrowRight').defaultPrevented).toBe(true);expect(document.activeElement).toBe(input('p1'))
 key('p1','ArrowDown');expect(document.activeElement).toBe(input('p2'))
 key('p2','ArrowLeft');expect(document.activeElement).toBe(input('q2'))
 key('q2','ArrowUp');expect(document.activeElement).toBe(input('q1'))
 expect(['q1','q2','p1','p2'].map(id=>input(id).value)).toEqual(['2','3','10.25','20'])
})
it('edges never step a number or jump to another table; readonly, disabled and hidden cells are skipped',()=>{
 const {input,key}=grid();input('q2').disabled=true;input('p1').readOnly=true;input('n1').style.display='none'
 document.body.insertAdjacentHTML('beforeend','<table><tr><td><input id="foreign" type="number"></td></tr></table>')
 key('q1','ArrowUp');expect(document.activeElement).toBe(input('q1'))
 key('q1','ArrowDown');expect(document.activeElement).toBe(input('q1'))
 key('q1','ArrowRight');expect(document.activeElement).toBe(input('q1'))
 expect(key('q1','ArrowLeft').defaultPrevented).toBe(true)
})
it('vertical navigation follows table columns and colspans rather than editable-field ordinal',()=>{
 document.body.innerHTML='<table><tr><td colspan="2">商品</td><td><input id="a" type="number"></td></tr><tr><td><input id="unrelated"></td><td>单位</td><td><input id="b" type="number"></td></tr></table>'
 const a=document.getElementById('a') as HTMLInputElement;a.focus()
 a.addEventListener('keydown',navigateTableInput)
 a.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))
 expect(document.activeElement?.id).toBe('b')
})
it('text editing shortcuts, composition, dropdowns, textareas and non-table fields keep native handling',()=>{
 const {input,key}=grid();expect(key('q1','ArrowRight',{shiftKey:true}).defaultPrevented).toBe(false)
 expect(key('q1','ArrowDown',{isComposing:true}).defaultPrevented).toBe(false)
 input('n1').setAttribute('role','combobox');expect(key('n1','ArrowDown').defaultPrevented).toBe(false)
 document.body.insertAdjacentHTML('beforeend','<input id="outside" type="number"><textarea id="multi"></textarea>')
 for(const id of ['outside','multi']){const target=document.getElementById(id)!;target.addEventListener('keydown',navigateTableInput);const event=new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true});target.dispatchEvent(event);expect(event.defaultPrevented).toBe(false)}
})
it('horizontal and vertical wheel over focused numbers scroll ancestors without blur, stepping or triggering change',()=>{
 document.body.innerHTML='<div id="scroll" style="overflow-x:auto;overflow-y:auto"><input id="qty" type="number" value="12.5"></div>'
 const parent=document.getElementById('scroll')!,input=document.getElementById('qty') as HTMLInputElement
 Object.defineProperties(parent,{scrollWidth:{value:1000},clientWidth:{value:100},scrollHeight:{value:900},clientHeight:{value:100}})
 input.focus();const blur=vi.fn(),change=vi.fn();input.addEventListener('blur',blur);input.addEventListener('change',change)
 input.addEventListener('wheel',protectNumberWheel)
 const event=new WheelEvent('wheel',{deltaX:180,deltaY:32,bubbles:true,cancelable:true});input.dispatchEvent(event)
 expect(event.defaultPrevented).toBe(true);expect(parent.scrollLeft).toBe(180);expect(parent.scrollTop).toBe(32)
 expect(input.value).toBe('12.5');expect(document.activeElement).toBe(input);expect(blur).not.toHaveBeenCalled();expect(change).not.toHaveBeenCalled()
})
it('wheel on an unfocused input or page and pinch zoom remain native',()=>{
 const {input}=grid();input('q1').addEventListener('wheel',protectNumberWheel)
 const unfocused=new WheelEvent('wheel',{deltaY:10,cancelable:true});input('q1').dispatchEvent(unfocused);expect(unfocused.defaultPrevented).toBe(false)
 input('q1').focus();const pinch=new WheelEvent('wheel',{deltaY:10,ctrlKey:true,cancelable:true});input('q1').dispatchEvent(pinch);expect(pinch.defaultPrevented).toBe(false)
})
it('global mount covers dynamically inserted tables and portals; unmount removes listeners',()=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 act(()=>root.render(<TableInputInteractions/>))
 const {input}=grid();input('q1').focus();input('q1').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));expect(document.activeElement).toBe(input('p1'))
 act(()=>root.unmount())
 input('q1').focus();const event=new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true});input('q1').dispatchEvent(event);expect(event.defaultPrevented).toBe(false)
})

it('Shift with vertical wheel retains horizontal table scrolling',()=>{
 document.body.innerHTML='<div id="scroll" style="overflow-x:auto"><input id="qty" type="number" value="5"></div>'
 const parent=document.getElementById('scroll')!,input=document.getElementById('qty') as HTMLInputElement
 Object.defineProperties(parent,{scrollWidth:{value:1000},clientWidth:{value:100}})
 input.focus();input.addEventListener('wheel',protectNumberWheel)
 input.dispatchEvent(new WheelEvent('wheel',{deltaY:80,shiftKey:true,bubbles:true,cancelable:true}))
 expect(parent.scrollLeft).toBe(80);expect(input.value).toBe('5');expect(document.activeElement).toBe(input)
})
