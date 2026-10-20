'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  collectReportPages,
  downloadTableReport,
  getServerTableReport,
  getTableReport,
  showTableReport,
  subscribeTableReport,
  type TableReport,
} from '@/lib/table-report'
import { notifyUser } from '@/lib/ui-dialogs'
import {getUser} from '@/lib/v2-auth'
import {DEFAULT_RECEIPT_TEMPLATE,readReceiptTemplate,receiptTemplateReport,type ReceiptPrintTemplate} from '@/lib/receipt-print-template'
import { prepareTablePrint } from '@/lib/table-print'
import { ReceiptTemplateDesigner, ReceiptTemplateGrid } from '@/components/v2/receipt-template-designer'

export { collectReportPages }

export function ReportActions({ loadReport, csv = false, printOnly = false, disabled = false }: {
  loadReport: () => TableReport | Promise<TableReport>
  csv?: boolean
  printOnly?: boolean
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const working = useRef(false)
  async function perform(print: boolean) {
    if (working.current) return
    working.current = true
    setBusy(true)
    try {
      const report = await loadReport()
      if (print) showTableReport(report)
      else await downloadTableReport(report, csv ? 'csv' : 'xlsx')
    } catch (reason: any) {
      void notifyUser(reason.message || '生成单据失败，请重试')
    } finally {
      working.current = false
      setBusy(false)
    }
  }
  return <span className="inline-flex flex-wrap gap-2 print:hidden">
    {!printOnly && <button type="button" disabled={disabled || busy} className="rounded-lg border border-border bg-white px-3 py-2 text-caption disabled:opacity-40" onClick={() => void perform(false)}>{busy ? '生成中…' : csv ? '导出 CSV' : '导出 Excel'}</button>}
    <button type="button" disabled={disabled || busy} className="rounded-lg border border-border bg-white px-3 py-2 text-caption disabled:opacity-40" onClick={() => void perform(true)}>{busy ? '生成中…' : '打印 / 保存 PDF'}</button>
  </span>
}

export function TableReportHost() {
  const report = useSyncExternalStore(subscribeTableReport, getTableReport, getServerTableReport)
  const printCleanup = useRef<(() => void) | null>(null)
  const [template,setTemplate]=useState<ReceiptPrintTemplate>(DEFAULT_RECEIPT_TEMPLATE)
  const [settingsOpen,setSettingsOpen]=useState(false)
  const [settingsNotice,setSettingsNotice]=useState('')
  const templateKey=()=>{let tenant='';try{tenant=JSON.parse(localStorage.getItem('tenant')||'null')?.id||''}catch{}return `receipt-print-template:${tenant}:${getUser()?.id||'anonymous'}`}
  useEffect(()=>{
    setSettingsOpen(false);setSettingsNotice('')
    if(!report?.printTemplate){setTemplate(DEFAULT_RECEIPT_TEMPLATE);return}
    try{setTemplate(readReceiptTemplate(JSON.parse(localStorage.getItem(templateKey())||'null')))}catch{setTemplate(DEFAULT_RECEIPT_TEMPLATE)}
  },[report])
  useEffect(() => {
    if (!report) return
    const prepare = () => {
      if (printCleanup.current) return
      const source = document.getElementById('print-report-host')
      if (source) printCleanup.current = prepareTablePrint(source, undefined, report.printTemplate ? template : {})
    }
    const finish = () => { printCleanup.current?.(); printCleanup.current = null }
    window.addEventListener('beforeprint', prepare)
    window.addEventListener('afterprint', finish)
    return () => { finish(); window.removeEventListener('beforeprint', prepare); window.removeEventListener('afterprint', finish) }
  }, [report,template])
  if (!report) return null
  const displayed=receiptTemplateReport(report,template)
  const print = () => {
    try {
      const source=document.getElementById('print-report-host')
      if(source&&!printCleanup.current)printCleanup.current=prepareTablePrint(source,undefined,report.printTemplate?template:{})
      window.print()
    }catch(error:any){printCleanup.current?.();printCleanup.current=null;void notifyUser(error?.message||'当前环境不支持打印，请使用浏览器打开本页')}

  }
  return <div id="print-report-host" role="dialog" aria-modal="true" aria-label={report.title} style={report.printTemplate?{fontFamily:'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'}:undefined} className={`fixed inset-0 z-[90] overflow-auto p-4 sm:p-8 ${report.printTemplate?'bg-[#e8e8e8]':'bg-white'}`}>
    <style>{`@media print { @page { size: A4 landscape; margin: 10mm; } body:not(:has([data-table-print-root])) > :not(#print-report-host) { display:none !important; } #print-report-host { position:static !important; overflow:visible !important; padding:0 !important; } #print-report-host .report-controls { display:none !important; } #print-report-host .overflow-x-auto { overflow:visible !important; } #print-report-host table { width:100%; font-size:10pt; } #print-report-host thead { display:table-header-group; } #print-report-host tr { break-inside:avoid; } #print-report-host td { overflow-wrap:anywhere; } }`}</style>
    <div className="report-controls mb-5 flex flex-wrap items-center gap-3">
      <button className="rounded-lg bg-ink px-4 py-2 text-white" onClick={print}>打印</button>
      <button className="rounded-lg border px-4 py-2" onClick={print}>保存 PDF</button>
      <button className="rounded-lg border px-4 py-2" onClick={() => showTableReport(null)}>关闭预览</button>
      {report.printTemplate && <button type="button" className="rounded-lg border px-4 py-2" onClick={()=>setSettingsOpen(open=>!open)}>编辑模板</button>}
      <span className="text-caption text-gray2">建议 A4、100% 缩放。保存 PDF：在系统打印窗口选择“存储为 PDF / 另存为 PDF”。</span>
    </div>
    {report.printTemplate&&settingsOpen&&<ReceiptTemplateDesigner value={template} onChange={setTemplate} headers={report.headers} notice={settingsNotice}
      onSave={()=>{try{localStorage.setItem(templateKey(),JSON.stringify(template));setSettingsNotice('已保存到当前账号的本浏览器')}catch{setSettingsNotice('浏览器未允许保存，当前预览仍可打印')}}}
      onReset={()=>{setTemplate(readReceiptTemplate(DEFAULT_RECEIPT_TEMPLATE));try{localStorage.removeItem(templateKey())}catch{}setSettingsNotice('已恢复默认模板')}}/>}
    <div data-receipt-paper={report.printTemplate?'':undefined} style={report.printTemplate?{boxSizing:'border-box',width:template.orientation==='portrait'?'210mm':'297mm',minHeight:template.orientation==='portrait'?'297mm':'210mm',maxWidth:'100%',margin:'0 auto',padding:'10mm',backgroundColor:'#fff',boxShadow:'0 1px 12px #0002'}:undefined}>
    {report.printTemplate ? <header data-receipt-letterhead style={{textAlign:'center',borderBottom:'2px solid #302d28',paddingBottom:12,marginBottom:16}}>
      <div style={{fontSize:20,fontWeight:700,letterSpacing:2}}>{report.printTemplate.fields?.organization||report.printTemplate.fields?.supplier||''}</div>
      <h1 style={{fontSize:26,fontWeight:700,margin:'8px 0 4px'}}>{template.title.trim()||'采 购 入 库 单'}</h1>
      <div style={{fontSize:10,color:'#666'}}>PURCHASE RECEIPT</div>
    </header> : <h1 className="text-h1">{displayed.title}</h1>}
    {report.subtitle && (!report.printTemplate || report.subtitle.includes('未保存预览')) && <p className="my-3 whitespace-pre-wrap text-caption">{report.printTemplate?'未保存预览':report.subtitle}</p>}
    {report.printTemplate&&<ReceiptTemplateGrid template={template} fields={{...report.printTemplate.fields,documentNo:report.printTemplate.documentNo}}/>}
    {!report.printTemplate&&<p className="my-2 text-micro text-gray3">共 {report.rows.length} 行 · 生成于 {new Date().toLocaleString('zh-CN')}</p>}
    {report.printTemplate&&template.note&&<p className="my-2 whitespace-pre-wrap text-caption">{template.note}</p>}
    <div className="overflow-x-auto"><table style={report.printTemplate?{fontSize:`${template.fontSize}pt`}:undefined} className="w-full border-collapse text-left text-caption">
      {report.printTemplate&&<colgroup>{displayed.headers.map((header,index)=><col key={index} style={header==='序号'?{width:'8%'}:header==='物品名称'?{width:'24%'}:header==='规格'?{width:'20%'}:header==='单位'?{width:'8%'}:{}}/>)}</colgroup>}
      <thead><tr>{displayed.headers.map((header, index) => <th key={index} className="border border-gray3 bg-bg p-2">{header}</th>)}</tr></thead>
      <tbody>{displayed.rows.map((row, index) => <tr key={index}>{displayed.headers.map((_, column) => <td key={column} className="border border-border p-2 align-top">{row[column] ?? '—'}</td>)}</tr>)}</tbody>
      {(displayed.footerRows?.length||displayed.footerNote)&&<tfoot>{displayed.footerRows?.map((row,index)=><tr key={index}>{displayed.headers.map((_,column)=><td key={column} className="border border-border p-2 font-semibold">{row[column]??''}</td>)}</tr>)}{displayed.footerNote&&<tr><td colSpan={displayed.headers.length} className="border border-border p-3 whitespace-pre-wrap">{report.printTemplate?<><div data-receipt-signature style={{width:'45%',marginLeft:'auto',padding:'32px 8px 20px'}}><div style={{height:24,borderBottom:'1px solid #302d28'}}/><div style={{textAlign:'center',paddingTop:6,fontSize:12}}>收货人签字 / 日期</div></div><div style={{borderTop:'1px solid #ddd',paddingTop:8,fontSize:9,color:'#777'}}>共 {report.rows.length} 项商品</div></>:displayed.footerNote}</td></tr>}</tfoot>}
    </table></div>
    </div>
  </div>
}
