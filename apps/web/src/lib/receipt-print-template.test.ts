import {describe,it,expect} from 'vitest'
import {readReceiptTemplate,receiptTemplateReport,DEFAULT_RECEIPT_TEMPLATE} from './receipt-print-template'
describe('采购入库打印设置不改变单据数据',()=>{
 it('仅接受有限字号方向和非必要列，非法配置恢复默认',()=>{expect(readReceiptTemplate({fontSize:90,orientation:'any',hiddenHeaders:['数量','金额','规格']})).toMatchObject({fontSize:10,orientation:'portrait',hiddenHeaders:['规格']});expect(readReceiptTemplate(null)).toEqual(DEFAULT_RECEIPT_TEMPLATE)})
 it('保留单号和核心列，值按原列映射，不改原报表/导出',()=>{const report={printTemplate:{key:'purchase-receipt' as const,documentNo:'RC001'},title:'采购入库单 RC001',headers:['物品名称','规格','单位','数量','单价','金额'],rows:[['土豆','大','kg','3','33.333333','100']]};const result=receiptTemplateReport(report,{...DEFAULT_RECEIPT_TEMPLATE,title:'收货凭证',hiddenHeaders:['规格','数量','金额']});expect(result.title).toBe('收货凭证 RC001');expect(result.headers).toEqual(['物品名称','单位','数量','单价','金额']);expect(result.rows[0]).toEqual(['土豆','kg','3','33.333333','100']);expect(report.rows[0]).toHaveLength(6)})
 it('采购入库以外报表保持原样',()=>{const report={title:'退货',headers:['金额'],rows:[[100]]};expect(receiptTemplateReport(report,DEFAULT_RECEIPT_TEMPLATE)).toBe(report)})
})
