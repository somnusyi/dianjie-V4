'use client'
import {useEffect} from 'react'

const textInputTypes=new Set(['text','number','search','email','tel','url','password'])
function editable(input:Element):input is HTMLInputElement {
  return input instanceof HTMLInputElement&&textInputTypes.has(input.type)&&!input.disabled&&!input.readOnly&&!input.closest('[hidden],[inert],[aria-hidden="true"]')&&input.getClientRects().length>0
}
function column(cell:HTMLTableCellElement){
  return Array.from((cell.parentElement as HTMLTableRowElement).cells).slice(0,cell.cellIndex).reduce((sum,item)=>sum+item.colSpan,0)
}
/** Arrow keys move between editable table fields; they never step a numeric value. */
export function navigateTableInput(event:KeyboardEvent){
  if(event.defaultPrevented||event.isComposing||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return
  const input=event.target
  if(!(input instanceof HTMLInputElement)||!editable(input)||input.getAttribute('role')==='combobox'||input.getAttribute('aria-autocomplete'))return
  const cell=input.closest('td,th') as HTMLTableCellElement|null
  const row=cell?.parentElement as HTMLTableRowElement|null
  const table=cell?.closest('table')
  if(!cell||!row||!table)return
  const fields=(scope:Element)=>Array.from(scope.querySelectorAll('input')).filter(item=>editable(item)&&item.closest('table')===table)
  event.preventDefault()
  // Consume before page-specific handlers, so a key cannot move twice or change a value.
  event.stopPropagation()
  let next:HTMLInputElement|undefined
  if(event.key==='ArrowLeft'||event.key==='ArrowRight'){
    const inputs=fields(row),index=inputs.indexOf(input)
    next=inputs[index+(event.key==='ArrowRight'?1:-1)]
  }else{
    const rows=Array.from(table.rows),direction=event.key==='ArrowDown'?1:-1,targetColumn=column(cell)
    const withinCell=fields(cell).indexOf(input)
    for(let index=rows.indexOf(row)+direction;index>=0&&index<rows.length;index+=direction){
      const targetCell=Array.from(rows[index].cells).find(candidate=>column(candidate)<=targetColumn&&column(candidate)+candidate.colSpan>targetColumn)
      const candidates=targetCell?fields(targetCell):[]
      if(candidates.length){next=candidates[Math.min(withinCell,candidates.length-1)];break}
    }
  }
  if(next){next.focus();next.select()}
}

/** Cancel the browser's number-step default, while retaining focus and normal table/page scrolling. */
export function protectNumberWheel(event:WheelEvent){
  const input=event.target
  if(event.ctrlKey||!(input instanceof HTMLInputElement)||input.type!=='number'||input.ownerDocument.activeElement!==input||!event.cancelable)return
  event.preventDefault()
  event.stopPropagation()
  const doc=input.ownerDocument,root=doc.scrollingElement
  let dx=event.deltaX*(event.deltaMode===1?16:event.deltaMode===2?window.innerWidth:1)
  let dy=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?window.innerHeight:1)
  if(event.shiftKey&&!dx){dx=dy;dy=0}
  for(let parent=input.parentElement;parent;parent=parent.parentElement){
    const style=getComputedStyle(parent),isRoot=parent===root
    if(dx&&(isRoot||/auto|scroll|overlay/.test(style.overflowX))&&parent.scrollWidth>parent.clientWidth){
      const before=parent.scrollLeft
      parent.scrollLeft+=dx;dx-=parent.scrollLeft-before
    }
    if(dy&&(isRoot||/auto|scroll|overlay/.test(style.overflowY))&&parent.scrollHeight>parent.clientHeight){
      const before=parent.scrollTop
      parent.scrollTop+=dy;dy-=parent.scrollTop-before
    }
    if(!dx&&!dy)break
  }
}

export function TableInputInteractions(){
  useEffect(()=>{
    document.addEventListener('wheel',protectNumberWheel,{capture:true,passive:false})
    document.addEventListener('keydown',navigateTableInput,true)
    return ()=>{
      document.removeEventListener('wheel',protectNumberWheel,true)
      document.removeEventListener('keydown',navigateTableInput,true)
    }
  },[])
  return null
}
