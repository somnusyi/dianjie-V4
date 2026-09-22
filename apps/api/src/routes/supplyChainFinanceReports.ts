import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { hasInternalSupplyChainCapability, isInternalSupplyChainRole } from '../lib/internal-supply-chain-access'
import { loadFinanceReport, financeReportIds, financeQuerySchema } from '../services/supplyChainFinanceReports'

export function supplyChainFinanceAccess(role: string) {
  if (isInternalSupplyChainRole(role)) return hasInternalSupplyChainCapability(role, 'finance.read')
  return ['SUPER_ADMIN', 'ADMIN', 'FINANCE'].includes(role)
}
export const supplyChainFinanceReportRoutes: FastifyPluginAsync = async app => {
  app.get('/:report', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    if (!req.user?.tenantId || !supplyChainFinanceAccess(req.user.role)) return reply.status(403).send({ error: '无权查看财务报表' })
    const id = z.enum(financeReportIds).safeParse(req.params.report)
    const query = financeQuerySchema.safeParse(req.query)
    if (!id.success || !query.success) return reply.status(400).send({ error: !query.success ? query.error.issues[0].message : '报表不存在' })
    const result = await prisma.$transaction(tx => loadFinanceReport(tx, req.user.tenantId, id.data, query.data), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30000 })
    if (query.data.export !== '1') return result
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet(result.title)
    sheet.columns = result.columns.map(c => ({ header: c.label, key: c.key, width: c.kind ? 20 : 26 }))
    for (const row of result.rows) sheet.addRow(Object.fromEntries(result.columns.map(c => [c.key, row[c.key] ?? null])))
    result.columns.forEach((c, i) => { if (c.kind) sheet.getColumn(i + 1).numFmt = c.kind === 'percent' ? '0.00%' : c.kind === 'money' ? '#,##0.00' : '#,##0.######' })
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
    sheet.getRow(1).font = { bold: true }
    sheet.autoFilter = { from: 'A1', to: { row: 1, column: result.columns.length } }
    workbook.addWorksheet('口径说明').addRows([[result.note], ...result.warnings.map(w => [w]), [`导出时间：${result.generatedAt}`], [`筛选条件：${JSON.stringify(query.data)}`]])
    const buffer = await workbook.xlsx.writeBuffer()
    return { filename: `${result.title}-${query.data.end}.xlsx`, fileBase64: Buffer.from(buffer).toString('base64'), total: result.total }
  })
}
