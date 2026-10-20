import type {TableReport} from './table-report'
export const RECEIPT_TEMPLATE_FIELDS=['documentNo','supplier','organization','warehouse','date','note'] as const
export type ReceiptTemplateField=typeof RECEIPT_TEMPLATE_FIELDS[number]
export type ReceiptTemplateFields=Partial<Record<ReceiptTemplateField,string>>
export type ReceiptGridCell={text:string;field:ReceiptTemplateField|''}
export type ReceiptGrid={widths:number[];cells:ReceiptGridCell[][];border:'all'|'horizontal'|'three-line'|'none'}
export type ReceiptExtraColumn={id:string;label:string;text:string}
export type ReceiptPrintTemplate={title:string;note:string;fontSize:9|10|11;orientation:'landscape'|'portrait';hiddenHeaders:string[];grid:ReceiptGrid;columnOrder:string[];extraColumns:ReceiptExtraColumn[]}
export const DEFAULT_RECEIPT_TEMPLATE:ReceiptPrintTemplate={title:'',note:'',fontSize:10,orientation:'portrait',hiddenHeaders:['物品编码','批次号','生产日期','到期日期','备注'],grid:{widths:[1,3,1,3],cells:[[{text:'单据编号',field:''},{text:'',field:'documentNo'},{text:'日期',field:''},{text:'',field:'date'}],[{text:'供应商',field:''},{text:'',field:'supplier'},{text:'仓库',field:''},{text:'',field:'warehouse'}],[{text:'机构',field:''},{text:'',field:'organization'},{text:'备注',field:''},{text:'',field:'note'}]],border:'all'},columnOrder:[],extraColumns:[]}
export const RECEIPT_OPTIONAL_HEADERS=['序号','物品编码','规格','批次号','生产日期','到期日期','备注']
export const RECEIPT_FIELD_LABELS:Record<ReceiptTemplateField,string>={documentNo:'单号',supplier:'供应商',organization:'机构',warehouse:'仓库',date:'日期',note:'备注'}
const record=(raw:unknown):Record<string,unknown>=>raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{}
const text=(raw:unknown,max:number)=>typeof raw==='string'?raw.slice(0,max):''
const bounded=(raw:unknown,min:number,max:number,fallback:number)=>typeof raw==='number'&&Number.isFinite(raw)?Math.min(max,Math.max(min,raw)):fallback
const emptyCell=():ReceiptGridCell=>({text:'',field:''})
export function readReceiptTemplate(raw:unknown):ReceiptPrintTemplate {
  const value=record(raw),gridValue=Object.prototype.hasOwnProperty.call(value,'grid')?record(value.grid):DEFAULT_RECEIPT_TEMPLATE.grid
  const rows=Array.isArray(gridValue.cells)?gridValue.cells.slice(0,8):[]
  const widths=Array.isArray(gridValue.widths)&&rows.length?gridValue.widths.slice(0,8).map(value=>bounded(value,1,20,1)):[]
  const cells=widths.length?rows.map(row=>widths.map((_,index)=>{
    const cell=record(Array.isArray(row)?row[index]:null)
    return {text:text(cell.text,120),field:RECEIPT_TEMPLATE_FIELDS.includes(cell.field as ReceiptTemplateField)?cell.field as ReceiptTemplateField:'' as const}
  })):[]
  const extras:ReceiptExtraColumn[]=[]
  if(Array.isArray(value.extraColumns))for(const raw of value.extraColumns){
    const item=record(raw),id=text(item.id,40)
    if(!/^[a-zA-Z0-9_-]+$/.test(id)||extras.some(existing=>existing.id===id))continue
    extras.push({id,label:text(item.label,40).trim()||'自定义说明',text:text(item.text,200)})
    if(extras.length===8)break
  }
  return {
    title:text(value.title,80),note:text(value.note,200),fontSize:[9,10,11].includes(Number(value.fontSize))?Number(value.fontSize) as 9|10|11:10,
    orientation:value.orientation==='landscape'?'landscape':'portrait',hiddenHeaders:Array.isArray(value.hiddenHeaders)?RECEIPT_OPTIONAL_HEADERS.filter(header=>(value.hiddenHeaders as unknown[]).includes(header)):[...DEFAULT_RECEIPT_TEMPLATE.hiddenHeaders],
    grid:{widths,cells,border:['all','horizontal','three-line','none'].includes(String(gridValue.border))?gridValue.border as ReceiptGrid['border']:'all'},
    columnOrder:Array.isArray(value.columnOrder)?Array.from(new Set(value.columnOrder.filter((key):key is string=>typeof key==='string'&&key.length>0&&key.length<=180))).slice(0,80):[],extraColumns:extras,
  }
}
export function resizeReceiptGrid(raw:ReceiptPrintTemplate,rowCount:number,columnCount:number):ReceiptPrintTemplate {
  const template=readReceiptTemplate(raw),rows=Math.trunc(bounded(rowCount,0,8,0)),columns=Math.trunc(bounded(columnCount,0,8,0))
  if(!rows||!columns)return {...template,grid:{widths:[],cells:[],border:template.grid.border}}
  return {...template,grid:{...template.grid,widths:Array.from({length:columns},(_,index)=>template.grid.widths[index]||1),
    cells:Array.from({length:rows},(_,row)=>Array.from({length:columns},(_,column)=>({...template.grid.cells[row]?.[column]||emptyCell()})))}}
}
export function removeReceiptGridAxis(raw:ReceiptPrintTemplate,axis:'row'|'column',index:number):ReceiptPrintTemplate {
  const template=readReceiptTemplate(raw),grid=template.grid
  if(!Number.isInteger(index)||index<0||index>=(axis==='row'?grid.cells.length:grid.widths.length))return template
  if(axis==='row')grid.cells.splice(index,1)
  else {grid.widths.splice(index,1);grid.cells.forEach(row=>row.splice(index,1))}
  return !grid.cells.length||!grid.widths.length?resizeReceiptGrid(template,0,0):template
}
export function receiptGridCellText(cell:ReceiptGridCell,fields:ReceiptTemplateFields):string {
  return cell.text+(cell.field?(fields[cell.field]||'—'):'')
}
export type ReceiptDetailColumn={key:string;label:string;sourceIndex:number|null;constant?:string}
export function receiptDetailColumns(headers:string[],raw:ReceiptPrintTemplate):ReceiptDetailColumn[]{
  const settings=readReceiptTemplate(raw)
  const base:ReceiptDetailColumn[]=headers.map((header,index)=>({key:`base:${index}:${header}`,label:header,sourceIndex:index}))
  const extras:ReceiptDetailColumn[]=settings.extraColumns.map(column=>({key:`custom:${column.id}`,label:column.label,sourceIndex:null,constant:column.text}))
  const all=[...base,...extras],positions=new Map(settings.columnOrder.map((key,index)=>[key,index]))
  return all.map((column,index)=>({column,index})).sort((a,b)=>(positions.get(a.column.key)??settings.columnOrder.length+a.index)-(positions.get(b.column.key)??settings.columnOrder.length+b.index)).map(({column})=>column)
}
export function moveReceiptDetailColumn(raw:ReceiptPrintTemplate,headers:string[],key:string,direction:-1|1):ReceiptPrintTemplate {
  const template=readReceiptTemplate(raw),columns=receiptDetailColumns(headers,template),index=columns.findIndex(column=>column.key===key),target=index+direction
  if(index<0||target<0||target>=columns.length)return template
  ;[columns[index],columns[target]]=[columns[target],columns[index]]
  return {...template,columnOrder:columns.map(column=>column.key)}
}
export function addReceiptExtraColumn(raw:ReceiptPrintTemplate):ReceiptPrintTemplate {
  const template=readReceiptTemplate(raw)
  if(template.extraColumns.length>=8)return template
  let index=1;while(template.extraColumns.some(column=>column.id===`note-${index}`))index++
  return {...template,extraColumns:[...template.extraColumns,{id:`note-${index}`,label:'自定义说明',text:''}]}
}
export function receiptTemplateReport(report:TableReport,settings:ReceiptPrintTemplate):TableReport {
  if(!report.printTemplate)return report
  const safe=readReceiptTemplate(settings)
  const visible=receiptDetailColumns(report.headers,safe).filter(column=>column.sourceIndex===null||!safe.hiddenHeaders.includes(column.label)||!RECEIPT_OPTIONAL_HEADERS.includes(column.label))
  const footerRows=report.footerRows?.map(row=>{
    const mapped=visible.map(column=>column.sourceIndex===null?'':row[column.sourceIndex])
    if(row.some(cell=>cell==='合计')&&!mapped.some(cell=>cell==='合计')&&mapped.length) mapped[0]=mapped[0]==null||mapped[0]===''?'合计':`合计 ${mapped[0]}`
    return mapped
  })
  return {...report,title:`${safe.title.trim()||'采购入库单'} ${report.printTemplate.documentNo}`,headers:visible.map(column=>column.label),rows:report.rows.map(row=>visible.map(column=>column.sourceIndex===null?column.constant:row[column.sourceIndex])),...(footerRows?{footerRows}:{})}
}
