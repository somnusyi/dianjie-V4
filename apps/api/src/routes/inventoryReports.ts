import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import { hasInternalSupplyChainCapability, isInternalSupplyChainRole } from '../lib/internal-supply-chain-access'
import { loadInventoryReport, reportIds, reportQuerySchema } from '../services/inventoryReports'

export function inventoryReportAccess(role: string, write = false) {
  if (isInternalSupplyChainRole(role)) return hasInternalSupplyChainCapability(role, write ? 'inventory.write' : 'inventory.read')
  return (write ? ['SUPER_ADMIN', 'ADMIN', 'PURCHASER'] : ['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'PURCHASER']).includes(role)
}
export const inventoryReportRoutes: FastifyPluginAsync = async app => {
  app.get('/:report', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    if (!req.user?.tenantId || !inventoryReportAccess(req.user.role)) return reply.status(403).send({ error: '无权查看库存报表' })
    const id = z.enum(reportIds).safeParse(req.params.report)
    const query = reportQuerySchema.safeParse(req.query)
    if (!id.success || !query.success) return reply.status(400).send({ error: !query.success ? query.error.issues[0].message : '报表不存在' })
    const result = await prisma.$transaction(tx => loadInventoryReport(tx, req.user.tenantId, id.data, query.data), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30000 })
    if (query.data.export !== '1') return result
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet(result.title)
    sheet.columns = result.columns.map(c => ({ header: c.group ? `${c.group} · ${c.label}` : c.label, key: c.key, width: c.kind === 'number' ? 20 : 26 }))
    for (const row of result.rows) sheet.addRow(Object.fromEntries(result.columns.map(c => [c.key, row[c.key] ?? null])))
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
    sheet.getRow(1).font = { bold: true }
    sheet.autoFilter = { from: 'A1', to: { row: 1, column: result.columns.length } }
    workbook.addWorksheet('口径说明').addRows([[result.note], [`导出时间：${result.generatedAt}`], [`筛选条件：${JSON.stringify(query.data)}`]])
    const buffer = await workbook.xlsx.writeBuffer()
    return { filename: `${result.title}-${query.data.end}.xlsx`, fileBase64: Buffer.from(buffer).toString('base64'), total: result.total }
  })
}
