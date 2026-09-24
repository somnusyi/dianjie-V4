import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import ExcelJS from 'exceljs'
import { inventoryReportAccess } from './inventoryReports'
import { loadInventoryManagement, managementPages, managementQuerySchema } from '../services/inventoryManagement'

export const inventoryManagementRoutes: FastifyPluginAsync = async app => {
  app.get('/:page', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    if (!req.user?.tenantId || !inventoryReportAccess(req.user.role)) return reply.status(403).send({ error: '无权查看库存与盘点单据' })
    const page = managementPages.find(p => p.id === req.params.page)
    const query = managementQuerySchema.safeParse(req.query)
    if (!page || !query.success) return reply.status(400).send({ error: !query.success ? query.error.issues[0].message : '页面不存在' })
    const result = await prisma.$transaction(tx => loadInventoryManagement(tx, req.user.tenantId, page.id, query.data), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30000 })
    if (!query.data.export) return result
    if (!result.sourceAvailable) return reply.status(422).send({ error: result.note })
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet(result.title)
    sheet.columns = result.columns.map(c => ({ header: c.label, key: c.key, width: c.kind === 'number' ? 22 : 26 }))
    result.rows.forEach(row => sheet.addRow(row))
    sheet.views = [{ state: 'frozen', ySplit: 1 }]; sheet.getRow(1).font = { bold: true }
    workbook.addWorksheet('说明').addRows([[result.note], [`生成时间：${result.generatedAt}`]])
    return { filename: `${result.title}.xlsx`, fileBase64: Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64') }
  })
}
