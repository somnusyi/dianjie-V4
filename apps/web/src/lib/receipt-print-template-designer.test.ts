import {describe,it,expect} from 'vitest'
import {DEFAULT_RECEIPT_TEMPLATE,readReceiptTemplate,resizeReceiptGrid,removeReceiptGridAxis,receiptGridCellText,receiptDetailColumns,moveReceiptDetailColumn,addReceiptExtraColumn,receiptTemplateReport} from './receipt-print-template'
describe('receipt print grid and detail customization',()=>{
 it('migrates previous browser settings to the default header without changing detail order',()=>{
  const value=readReceiptTemplate({title:'旧标题',hiddenHeaders:['规格'],fontSize:11,orientation:'portrait'})
  expect(value).toMatchObject({title:'旧标题',hiddenHeaders:['规格'],fontSize:11,orientation:'portrait',grid:{widths:[1,3,1,3]},columnOrder:[],extraColumns:[]});expect(value.grid.cells).toHaveLength(3)
 })
 it('bounds cells, widths, text, fields, and duplicate extras from untrusted storage',()=>{
  const raw={grid:{widths:[0,100,NaN,...Array(12).fill(1)],cells:Array.from({length:12},()=>Array.from({length:12},()=>({text:'x'.repeat(300),field:'<script>'}))),border:'evil'},extraColumns:[{id:'a',label:'自定义',text:'x'.repeat(300)},{id:'a'},{id:'<script>'}],hiddenHeaders:['数量','金额','规格']}
  const value=readReceiptTemplate(raw)
  expect(value.grid.widths).toEqual([1,20,1,1,1,1,1,1]);expect(value.grid.cells).toHaveLength(8);expect(value.grid.cells[0]).toHaveLength(8)
  expect(value.grid.cells[0][0]).toEqual({text:'x'.repeat(120),field:''});expect(value.grid.border).toBe('all');expect(value.extraColumns).toHaveLength(1);expect(value.extraColumns[0].text).toHaveLength(200);expect(value.hiddenHeaders).toEqual(['规格'])
 })
 it('grows and shrinks the grid without mutating previous cells',()=>{
  const first=resizeReceiptGrid(DEFAULT_RECEIPT_TEMPLATE,2,2);first.grid.cells[0][0]={text:'供应商：',field:'supplier'};first.grid.widths[0]=3
  const second=resizeReceiptGrid(first,3,4)
  expect(second.grid.cells[0][0]).toEqual(first.grid.cells[0][0]);expect(second.grid.widths).toEqual([3,3,1,1]);expect(first.grid.cells).toHaveLength(2)
  second.grid.cells[0][0].text='新';expect(first.grid.cells[0][0].text).toBe('供应商：')
  expect(resizeReceiptGrid(second,1,1).grid.cells).toHaveLength(1);expect(resizeReceiptGrid(second,0,1).grid.cells).toEqual([])
 })
 it('removes a selected middle row or column while keeping aligned widths and fields',()=>{
  const template=resizeReceiptGrid(DEFAULT_RECEIPT_TEMPLATE,2,3);template.grid.widths=[1,2,3];template.grid.cells[0]=[{text:'A',field:''},{text:'B',field:''},{text:'C',field:''}]
  const result=removeReceiptGridAxis(template,'column',1);expect(result.grid.widths).toEqual([1,3]);expect(result.grid.cells[0].map(cell=>cell.text)).toEqual(['A','C']);expect(template.grid.widths).toEqual([1,2,3])
  expect(removeReceiptGridAxis(result,'row',0).grid.cells).toHaveLength(1)
 })
 it('binds only explicit fields and uses a clear missing marker rather than guessing',()=>{
  expect(receiptGridCellText({text:'供应商：',field:'supplier'},{supplier:'甲公司'})).toBe('供应商：甲公司')
  expect(receiptGridCellText({text:'仓库：',field:'warehouse'},{})).toBe('仓库：—')
  expect(receiptGridCellText({text:'<script>alert(1)</script>',field:''},{})).toBe('<script>alert(1)</script>')
 })
 it('moves original values and constant columns together, retaining required columns despite unsafe configuration',()=>{
  const report={printTemplate:{key:'purchase-receipt' as const,documentNo:'RC1'},title:'原单',headers:['物品名称','规格','单位','数量','单价','金额'],rows:[['土豆','大','kg',3,'33.333333',100]]}
  let template=addReceiptExtraColumn({...DEFAULT_RECEIPT_TEMPLATE,hiddenHeaders:['规格','数量','金额']})
  template.extraColumns[0].text='双方签收';template=moveReceiptDetailColumn(template,report.headers,'custom:note-1',-1)
  const result=receiptTemplateReport(report,template)
  expect(result.headers).toEqual(['物品名称','单位','数量','单价','自定义说明','金额']);expect(result.rows[0]).toEqual(['土豆','kg',3,'33.333333','双方签收',100]);expect(report.rows[0]).toHaveLength(6)
 })
 it('maps the footer total to its reordered amount column and keeps its hidden label',()=>{
  const report={printTemplate:{key:'purchase-receipt' as const,documentNo:'RC1'},title:'单据',headers:['序号','物品名称','单位','数量','单价','金额'],rows:[[1,'土豆','kg',3,10,30]],footerRows:[['合计','','','','',30]],footerNote:'签字'}
  let template=addReceiptExtraColumn({...DEFAULT_RECEIPT_TEMPLATE,hiddenHeaders:['序号']});template.extraColumns[0].text='每行说明'
  template=moveReceiptDetailColumn(template,report.headers,'custom:note-1',-1)
  const result=receiptTemplateReport(report,template)
  expect(result.headers).toEqual(['物品名称','单位','数量','单价','自定义说明','金额']);expect(result.footerRows?.[0]).toEqual(['合计','','','','',30]);expect(result.footerNote).toBe('签字');expect(report.footerRows[0][0]).toBe('合计')
 })
 it('keeps duplicate original headers as separate stable columns',()=>{
  expect(receiptDetailColumns(['备注','备注'],DEFAULT_RECEIPT_TEMPLATE).map(column=>column.key)).toEqual(['base:0:备注','base:1:备注'])
 })
 it('limits custom columns and allocates unused identifiers after deletion',()=>{
  let template=readReceiptTemplate(null);for(let i=0;i<12;i++)template=addReceiptExtraColumn(template)
  expect(template.extraColumns).toHaveLength(8);expect(new Set(template.extraColumns.map(column=>column.id)).size).toBe(8)
 })
})
