import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'

const fixed = (value: any, places: number) => value == null ? null : value.toFixed(places)
const date = (value: Date | null | undefined) => value ? value.toISOString() : null
const additionSourceLabel: Record<string, string> = {
  LEGACY: '历史数据', SYSTEM: '系统圈定', PLAN: '盘点方案', RECOUNT: '复盘补充', MANUAL: '手工添加', MERGED: '多人汇总',
}

export function warehouseStocktakePrintStatus(row: {
  printCount: number
  rowVersion: number
  lastPrintedRowVersion: number | null
}) {
  if (!row.printCount || row.lastPrintedRowVersion == null) return 'UNPRINTED' as const
  return row.lastPrintedRowVersion === row.rowVersion ? 'CURRENT' as const : 'STALE' as const
}

export function warehouseStocktakePrintDocument(row: any) {
  return {
    id: row.id,
    no: row.no,
    countDate: row.countDate.toISOString().slice(0, 10),
    rowVersion: row.rowVersion,
    documentType: row.documentType,
    countScope: row.countScope,
    status: row.status,
    reviewStatus: row.reviewStatus,
    warehouse: { id: row.warehouse.id, code: row.warehouse.code, name: row.warehouse.name },
    itemCount: row.itemCount,
    countedCount: row.countedCount,
    differenceCount: row.differenceCount,
    totalBookValue: fixed(row.totalBookValue, 4),
    totalCountedValue: fixed(row.totalCountedValue, 4),
    totalDifferenceValue: fixed(row.totalDifferenceValue, 4),
    note: row.note,
    createdAt: date(row.createdAt),
    createdBy: row.createdBy?.name || null,
    submittedAt: date(row.submittedAt),
    submittedBy: row.submittedBy?.name || null,
    auditedAt: date(row.auditedAt),
    auditedBy: row.auditedBy?.name || null,
    reviewedAt: date(row.reviewedAt),
    reviewedBy: row.reviewedBy?.name || null,
    items: row.sections.flatMap((section: any) => section.items.map((item: any) => ({
      id: item.id,
      section: section.name,
      assignee: section.assignedTo?.name || null,
      productCode: item.productCodeSnapshot,
      productName: item.productNameSnapshot,
      productSpec: item.productSpecSnapshot,
      storageLocation: item.storageLocationSnapshot,
      additionSource: item.additionSource,
      inventoryUnit: item.inventoryUnit,
      bookQuantity: fixed(item.bookQuantity, 6),
      bookValue: fixed(item.bookValue, 4),
      averageUnitCost: fixed(item.averageUnitCost, 6),
      countedQuantity: fixed(item.countedQuantity, 6),
      countedUnitCost: fixed(item.countedUnitCost, 6),
      countedValue: fixed(item.countedValue, 4),
      differenceQuantity: fixed(item.differenceQuantity, 6),
      differenceValue: fixed(item.differenceValue, 4),
      reason: item.reason,
    }))),
  }
}

export function warehouseStocktakeRenderFingerprint(row: any) {
  return createHash('sha256').update(JSON.stringify(warehouseStocktakePrintDocument(row))).digest('hex')
}

const scopeLabel: Record<string, string> = { ALL: '全部盘', DAILY: '日盘', WEEKLY: '周盘', SELECTED: '指定物品' }
const statusLabel: Record<string, string> = { DRAFT: '草稿', COUNTING: '盘点中', REVIEWING: '待审核', CONFIRMED: '已审核', CANCELLED: '已取消' }

export async function buildWarehouseStocktakeWorkbook(row: any) {
  const doc = warehouseStocktakePrintDocument(row)
  const workbook = new ExcelJS.Workbook()
  const header = workbook.addWorksheet('盘点单')
  header.columns = [
    { header: '单据编号', key: 'no', width: 24 }, { header: '盘点日期', key: 'countDate', width: 14 },
    { header: '仓库', key: 'warehouse', width: 20 }, { header: '盘点类型', key: 'scope', width: 14 },
    { header: '状态', key: 'status', width: 12 }, { header: '复审状态', key: 'review', width: 12 },
    { header: '物品数', key: 'itemCount', width: 12 }, { header: '账面金额', key: 'bookValue', width: 18 },
    { header: '实盘金额', key: 'countedValue', width: 18 }, { header: '差异金额', key: 'differenceValue', width: 18 },
    { header: '创建人', key: 'createdBy', width: 16 }, { header: '提交人', key: 'submittedBy', width: 16 },
    { header: '审核人', key: 'auditedBy', width: 16 }, { header: '复审人', key: 'reviewedBy', width: 16 },
    { header: '创建时间', key: 'createdAt', width: 24 }, { header: '提交时间', key: 'submittedAt', width: 24 },
    { header: '审核时间', key: 'auditedAt', width: 24 }, { header: '复审时间', key: 'reviewedAt', width: 24 },
    { header: '备注', key: 'note', width: 36 },
  ]
  header.addRow({
    no: doc.no, countDate: doc.countDate, warehouse: doc.warehouse.name,
    scope: scopeLabel[doc.countScope] || doc.countScope, status: statusLabel[doc.status] || doc.status,
    review: doc.reviewStatus === 'REVIEWED' ? '已复审' : '未复审', itemCount: doc.itemCount,
    bookValue: doc.totalBookValue, countedValue: doc.totalCountedValue, differenceValue: doc.totalDifferenceValue,
    createdBy: doc.createdBy, submittedBy: doc.submittedBy, auditedBy: doc.auditedBy, reviewedBy: doc.reviewedBy,
    createdAt: doc.createdAt, submittedAt: doc.submittedAt, auditedAt: doc.auditedAt, reviewedAt: doc.reviewedAt, note: doc.note,
  })

  const items = workbook.addWorksheet('盘点明细')
  items.columns = [
    { header: '分区', key: 'section', width: 18 }, { header: '负责人', key: 'assignee', width: 16 },
    { header: '商品编码', key: 'productCode', width: 18 }, { header: '商品名称', key: 'productName', width: 24 },
    { header: '规格', key: 'productSpec', width: 20 }, { header: '库位', key: 'storageLocation', width: 14 },
    { header: '添加方式', key: 'additionSourceLabel', width: 14 }, { header: '库存单位', key: 'inventoryUnit', width: 12 },
    { header: '账面数量', key: 'bookQuantity', width: 18 }, { header: '账面金额', key: 'bookValue', width: 18 },
    { header: '账面均价', key: 'averageUnitCost', width: 18 }, { header: '实盘数量', key: 'countedQuantity', width: 18 },
    { header: '实盘单价', key: 'countedUnitCost', width: 18 }, { header: '实盘金额', key: 'countedValue', width: 18 },
    { header: '差异数量', key: 'differenceQuantity', width: 18 }, { header: '差异金额', key: 'differenceValue', width: 18 },
    { header: '差异原因', key: 'reason', width: 36 },
  ]
  doc.items.forEach((item: any) => items.addRow({ ...item, additionSourceLabel: additionSourceLabel[item.additionSource] || item.additionSource }))
  for (const sheet of [header, items]) {
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
    sheet.getRow(1).font = { bold: true }
    for (const column of sheet.columns) if (['bookValue', 'countedValue', 'differenceValue', 'bookQuantity', 'averageUnitCost', 'countedQuantity', 'countedUnitCost', 'differenceQuantity'].includes(String(column.key))) column.numFmt = '@'
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}
