import {it,expect} from 'vitest'
import {procurementDocumentReport} from './procurement-document-report'
it('prints frozen source identity, small stored amount and date-only values without recomputing',()=>{
 const report=procurementDocumentReport('RECEIPT',{no:'RC-TEST',organizationName:'采购机构',supplier:{name:'供应商'},warehouse:{name:'原仓'},note:'整单备注',lines:[{purchaseUnit:'箱',acceptedQty:0,unitPrice:12,payableAmount:'0.0001',manufactureDate:'2026-10-10T00:00:00.000Z',expiryDate:null,purchaseOrderLine:{productCodeSnapshot:'ORIGINAL',productNameSnapshot:'原名称',productSpecSnapshot:'原规格'},product:{code:'CURRENT',name:'现名称',spec:'现规格'}}]})
 expect(report.subtitle).toContain('采购机构');expect(report.subtitle).toContain('整单备注')
 expect(report.rows[0].slice(1,8)).toEqual(['ORIGINAL','原名称','原规格','箱',0,12,'0.0001'])
 expect(report.rows[0][9]).toBe('2026-10-10')
 expect(report.rows[0][10]).toBeUndefined()
})
it('return preview uses settlement fields and includes the original receipt and reason',()=>{
 const report=procurementDocumentReport('RETURN',{no:'RT-TEST',supplier:{name:'原供应商'},reason:'退回多送',lines:[{purchaseUnit:'袋',purchaseQuantity:'2',settlementUnitPrice:'10',settlementAmount:'20',acceptedQty:100,unitPrice:99,payableAmount:999,receiptLine:{receipt:{no:'RC-ORIGINAL'}},product:{code:'SKU',name:'物料'}}]})
 expect(report.headers).toContain('原收货单');expect(report.headers).not.toContain('生产日期')
 expect(report.rows[0].slice(5,9)).toEqual(['2','10','20','RC-ORIGINAL'])
 expect(report.subtitle).toContain('退货原因：退回多送')
})
