'use client'
import {useState,type CSSProperties} from 'react'
import {RECEIPT_TEMPLATE_FIELDS,RECEIPT_FIELD_LABELS,RECEIPT_OPTIONAL_HEADERS,readReceiptTemplate,resizeReceiptGrid,removeReceiptGridAxis,receiptGridCellText,receiptDetailColumns,moveReceiptDetailColumn,addReceiptExtraColumn,type ReceiptPrintTemplate,type ReceiptTemplateFields,type ReceiptTemplateField} from '@/lib/receipt-print-template'

type DesignerProps={value:ReceiptPrintTemplate;onChange:(value:ReceiptPrintTemplate)=>void;headers:string[];onSave:()=>void;onReset:()=>void;notice?:string}
const inputClass='rounded border border-border bg-white px-2 py-1.5 text-caption'
const buttonClass='rounded border border-border bg-white px-3 py-1.5 text-caption disabled:opacity-40'
export function ReceiptTemplateDesigner({value,onChange,headers,onSave,onReset,notice}:DesignerProps){
  const template=readReceiptTemplate(value),grid=template.grid
  const [selected,setSelected]=useState({row:0,column:0})
  const row=Math.min(selected.row,Math.max(0,grid.cells.length-1)),column=Math.min(selected.column,Math.max(0,grid.widths.length-1)),cell=grid.cells[row]?.[column]
  const change=(next:ReceiptPrintTemplate)=>onChange(readReceiptTemplate(next))
  const patchCell=(patch:{text?:string;field?:ReceiptTemplateField|''})=>change({...template,grid:{...grid,cells:grid.cells.map((cells,r)=>cells.map((item,c)=>r===row&&c===column?{...item,...patch}:item))}})
  const columns=receiptDetailColumns(headers,template)
  return <section aria-label="采购入库单打印模板设计器" className="report-controls mb-5 space-y-4 rounded-xl border border-border bg-bg p-4">
    <div><h2 className="font-semibold">打印模板设计</h2><p className="mt-1 text-caption text-gray2">先设置抬头表格，再调整商品明细。只改变打印样式，保存到当前账号的本浏览器。</p></div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="grid gap-1 text-caption">打印标题<input aria-label="入库单打印标题" className={inputClass} maxLength={80} value={template.title} placeholder="采购入库单" onChange={event=>change({...template,title:event.target.value})}/></label>
      <label className="grid gap-1 text-caption">字号<select aria-label="入库单打印字号" className={inputClass} value={template.fontSize} onChange={event=>change({...template,fontSize:Number(event.target.value) as 9|10|11})}>{[9,10,11].map(size=><option key={size} value={size}>{size} 磅</option>)}</select></label>
      <label className="grid gap-1 text-caption">纸张方向<select aria-label="入库单打印方向" className={inputClass} value={template.orientation} onChange={event=>change({...template,orientation:event.target.value as ReceiptPrintTemplate['orientation']})}><option value="landscape">A4 横向</option><option value="portrait">A4 纵向</option></select></label>
      <label className="grid gap-1 text-caption">打印说明<input aria-label="入库单打印说明" className={inputClass} maxLength={200} value={template.note} onChange={event=>change({...template,note:event.target.value})}/></label>
    </div>
    <fieldset className="space-y-3 rounded-lg border border-border bg-white p-3"><legend className="px-1 font-semibold">抬头自由表格</legend>
      <div className="flex flex-wrap items-center gap-2">
        {!cell?<button type="button" className={buttonClass} onClick={()=>change(resizeReceiptGrid(template,2,3))}>添加抬头表格</button>:<>
          <button type="button" className={buttonClass} disabled={grid.cells.length>=8} onClick={()=>change(resizeReceiptGrid(template,grid.cells.length+1,grid.widths.length))}>添加一行</button>
          <button type="button" className={buttonClass} disabled={grid.widths.length>=8} onClick={()=>change(resizeReceiptGrid(template,grid.cells.length,grid.widths.length+1))}>添加一列</button>
          <button type="button" className={buttonClass} onClick={()=>change(removeReceiptGridAxis(template,'row',row))}>删除选中行</button>
          <button type="button" className={buttonClass} onClick={()=>change(removeReceiptGridAxis(template,'column',column))}>删除选中列</button>
          <button type="button" className={buttonClass} onClick={()=>change(resizeReceiptGrid(template,0,0))}>移除抬头表格</button>
        </>}
        <label className="flex items-center gap-2 text-caption">边框<select aria-label="抬头表格边框" className={inputClass} value={grid.border} onChange={event=>change({...template,grid:{...grid,border:event.target.value as typeof grid.border}})}><option value="all">完整边框</option><option value="horizontal">横线</option><option value="three-line">三线表</option><option value="none">无边框</option></select></label>
        <span className="text-micro text-gray3">最多 8 行 × 8 列，点选格子编辑。</span>
      </div>
      {cell&&<><div role="group" aria-label="抬头单元格选择" className="grid gap-1" style={{gridTemplateColumns:grid.widths.map(width=>`${width}fr`).join(' ')}}>{grid.cells.flatMap((cells,r)=>cells.map((item,c)=><button type="button" key={`${r}:${c}`} aria-label={`编辑第${r+1}行第${c+1}列`} aria-pressed={r===row&&c===column} className={`min-w-0 whitespace-pre-wrap break-words rounded border p-2 text-left text-caption ${r===row&&c===column?'border-accent bg-accent/10':'border-border bg-bg'}`} onClick={()=>setSelected({row:r,column:c})}>{item.text||item.field?item.text+(item.field?`【${RECEIPT_FIELD_LABELS[item.field]}】`:''):'空白格'}</button>))}</div>
        <div className="grid gap-3 sm:grid-cols-3"><label className="grid gap-1 text-caption">第{row+1}行第{column+1}列文字<textarea aria-label="单元格文字" maxLength={120} rows={2} className={inputClass} value={cell.text} onChange={event=>patchCell({text:event.target.value})}/></label>
          <label className="grid gap-1 text-caption">后接单据字段<select aria-label="单元格绑定字段" className={inputClass} value={cell.field} onChange={event=>patchCell({field:event.target.value as ReceiptTemplateField|''})}><option value="">仅文字</option>{RECEIPT_TEMPLATE_FIELDS.map(field=><option key={field} value={field}>{RECEIPT_FIELD_LABELS[field]}</option>)}</select></label>
          <label className="grid gap-1 text-caption">第{column+1}列相对宽度<input aria-label="选中列宽" type="number" min={1} max={20} step={1} className={inputClass} value={grid.widths[column]} onWheel={event=>event.currentTarget.blur()} onChange={event=>change({...template,grid:{...grid,widths:grid.widths.map((width,index)=>index===column?Math.max(1,Math.min(20,Number(event.target.value)||1)):width)}})}/><span className="text-micro text-gray3">如 1、2、1，则中列为两侧的两倍宽。</span></label></div>
      </>}
    </fieldset>
    <fieldset className="space-y-2 rounded-lg border border-border bg-white p-3"><legend className="px-1 font-semibold">商品明细列</legend><p className="text-micro text-gray3">上移、下移调整打印顺序；商品、单位、数量、单价和金额必须保留。自定义列仅重复打印说明文字。</p>
      <div className="space-y-2">{columns.map((item,index)=>{const extra=item.sourceIndex===null?template.extraColumns.find(column=>`custom:${column.id}`===item.key):null;return <div key={item.key} className="flex flex-wrap items-center gap-2 rounded border border-border bg-bg p-2">
        <span className="w-6 text-micro text-gray3">{index+1}</span>
        <button type="button" aria-label={`上移${item.label}`} className={buttonClass} disabled={index===0} onClick={()=>change(moveReceiptDetailColumn(template,headers,item.key,-1))}>上移</button>
        <button type="button" aria-label={`下移${item.label}`} className={buttonClass} disabled={index===columns.length-1} onClick={()=>change(moveReceiptDetailColumn(template,headers,item.key,1))}>下移</button>
        {extra?<><input aria-label={`自定义列${extra.id}名称`} className={inputClass} maxLength={40} value={extra.label} onChange={event=>change({...template,extraColumns:template.extraColumns.map(column=>column.id===extra.id?{...column,label:event.target.value}:column)})}/><input aria-label={`自定义列${extra.id}文字`} className={`${inputClass} min-w-40 flex-1`} maxLength={200} value={extra.text} placeholder="每行打印的说明" onChange={event=>change({...template,extraColumns:template.extraColumns.map(column=>column.id===extra.id?{...column,text:event.target.value}:column)})}/><button type="button" className={buttonClass} onClick={()=>change({...template,extraColumns:template.extraColumns.filter(column=>column.id!==extra.id),columnOrder:template.columnOrder.filter(key=>key!==item.key)})}>删除说明列</button></>:<><span className="min-w-24 text-caption">{item.label}</span>{RECEIPT_OPTIONAL_HEADERS.includes(item.label)?<label className="flex items-center gap-1 text-caption"><input type="checkbox" checked={!template.hiddenHeaders.includes(item.label)} onChange={event=>change({...template,hiddenHeaders:event.target.checked?template.hiddenHeaders.filter(header=>header!==item.label):[...template.hiddenHeaders,item.label]})}/>显示</label>:<span className="text-micro text-gray3">必须保留</span>}</>}
      </div>})}</div>
      <button type="button" className={buttonClass} disabled={template.extraColumns.length>=8} onClick={()=>change(addReceiptExtraColumn(template))}>添加自定义说明列</button>
    </fieldset>
    <div className="flex flex-wrap items-center gap-3"><button type="button" className="rounded-lg bg-ink px-4 py-2 text-white" onClick={onSave}>保存模板设置</button><button type="button" className={buttonClass} onClick={onReset}>恢复默认</button>{notice&&<span role="status" className="text-caption">{notice}</span>}</div>
  </section>
}

/** Add above the single detail HTML table; this deliberately renders no table/thead/tbody. */
export function ReceiptTemplateGrid({template,fields}:{template:ReceiptPrintTemplate;fields:ReceiptTemplateFields}){
  const safe=readReceiptTemplate(template),grid=safe.grid
  if(!grid.cells.length||!grid.widths.length)return null
  const style:CSSProperties={display:'grid',gridTemplateColumns:grid.widths.map(width=>`${width}fr`).join(' '),fontSize:`${safe.fontSize}pt`,width:'100%',margin:'8px 0',color:'#111',
    ...(grid.border==='three-line'?{borderTop:'2px solid #111',borderBottom:'2px solid #111'}:{})}
  return <div data-receipt-template-grid aria-label="单据抬头表格" style={style}>{grid.cells.flatMap((cells,row)=>cells.map((cell,column)=>{
    const borders:CSSProperties=grid.border==='all'?{border:'1px solid #666'}:grid.border==='horizontal'?{borderBottom:'1px solid #777'}:grid.border==='three-line'&&row===0?{borderBottom:'1px solid #111'}:{}
    return <div key={`${row}:${column}`} style={{minWidth:0,padding:'6px 8px',backgroundColor:column%2===0?'#f7f7f5':'#fff',whiteSpace:'pre-wrap',overflowWrap:'anywhere',...borders}}>{receiptGridCellText(cell,fields)||'\u00a0'}</div>
  }))}</div>
}
