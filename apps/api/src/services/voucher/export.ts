/**
 * 凭证导出 — 好会计 Excel 模板
 *
 * 好会计/畅捷通 Excel 凭证导入要求列(标准 8 列):
 *   凭证日期 | 凭证字 | 凭证号 | 摘要 | 科目编码 | 科目名称 | 借方金额 | 贷方金额
 *
 * 一条分录一行, 同凭证的多分录用相同的 凭证字+凭证号
 * 借/贷金额二选一填, 另一列填 0 或留空
 */
import { prisma } from '@dianjie/db'
import ExcelJS from 'exceljs'
import dayjs from 'dayjs'

export interface ExportFilter {
  tenantId: string
  from?: Date | string         // 日期范围
  to?: Date | string
  status?: 'DRAFT' | 'POSTED' | 'ALL'
  voucherIds?: string[]        // 显式指定凭证 ID 列表 (前端勾选场景)
}

export async function exportVouchersExcel(filter: ExportFilter): Promise<Buffer> {
  const where: any = { tenantId: filter.tenantId }
  if (filter.voucherIds?.length) {
    where.id = { in: filter.voucherIds }
  } else {
    if (filter.from || filter.to) {
      where.date = {}
      if (filter.from) where.date.gte = typeof filter.from === 'string' ? new Date(filter.from) : filter.from
      if (filter.to)   where.date.lte = typeof filter.to === 'string' ? new Date(filter.to) : filter.to
    }
    if (filter.status && filter.status !== 'ALL') where.status = filter.status
  }

  const vouchers = await prisma.voucher.findMany({
    where,
    orderBy: [{ date: 'asc' }, { no: 'asc' }],
    include: { entries: { orderBy: { lineNo: 'asc' } } },
  })

  const wb = new ExcelJS.Workbook()
  wb.creator = '滇界云管'
  const ws = wb.addWorksheet('凭证')
  ws.columns = [
    { header: '凭证日期', key: 'date',        width: 12 },
    { header: '凭证字',   key: 'word',        width: 8  },
    { header: '凭证号',   key: 'no',          width: 18 },
    { header: '摘要',     key: 'summary',     width: 36 },
    { header: '科目编码', key: 'accountCode', width: 12 },
    { header: '科目名称', key: 'accountName', width: 24 },
    { header: '借方金额', key: 'debit',       width: 14 },
    { header: '贷方金额', key: 'credit',      width: 14 },
  ]
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]

  for (const v of vouchers) {
    for (const e of v.entries) {
      ws.addRow({
        date: dayjs(v.date).format('YYYY-MM-DD'),
        word: v.word,
        no: v.no,
        summary: e.summary || v.summary,
        accountCode: e.accountCode,
        accountName: e.accountName,
        debit: Number(e.debit) || '',
        credit: Number(e.credit) || '',
      })
    }
  }
  ws.getColumn('debit').numFmt = '#,##0.00'
  ws.getColumn('credit').numFmt = '#,##0.00'

  // 标记已导出 (审计) — 一次写入, 避免下次重复导入
  if (vouchers.length > 0) {
    await prisma.voucher.updateMany({
      where: { id: { in: vouchers.map((v) => v.id) } },
      data: { exportedAt: new Date() },
    })
  }

  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf)
}
