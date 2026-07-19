/** Local-only E2E for preview -> confirm -> correction -> atomic replacement. */
import 'dotenv/config'
import ExcelJS from 'exceljs'
import { prisma } from '@dianjie/db'

const API = process.env.API_BASE_URL || 'http://127.0.0.1:4444'
const DATE = '2026-01-02'
const DISH_NAME = 'E2E日报测试菜'
const PRODUCT_CODE = 'E2E-DAILY-001'
const SOURCE = 'daily_pos_upload'

function assertLocal() {
  if (process.env.PREVIEW_MODE !== 'true' || !(process.env.DATABASE_URL || '').includes('dianjie_v4_local')) {
    throw new Error('此脚本仅允许 PREVIEW_MODE=true 的 dianjie_v4_local 本地库')
  }
}

async function businessBuffer(gross: number, discount: number, net: number, orders: number) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('综合营业统计')
  sheet.addRow(['综合营业统计'])
  sheet.addRow([`营业日期【${DATE.replaceAll('-', '/')}-${DATE.replaceAll('-', '/')}】`])
  sheet.addRow(['城市', '门店', '营业日', '营业额(元)', '优惠金额(元)', '营业收入(元)', '订单量', '用餐人数', '消费桌数'])
  sheet.addRow(['合肥市', '合肥瑶海店', DATE.replaceAll('-', '/'), gross, discount, net, orders, orders * 2, orders])
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

async function salesBuffer(quantity: number, gross: number, discount: number, net: number) {
  const workbook = new ExcelJS.Workbook()
  const sold = workbook.addWorksheet('已销售')
  sold.addRow(['菜品销售明细'])
  sold.addRow([`【结账时间】；【${DATE.replaceAll('-', '/')} 00:00 至 ${DATE.replaceAll('-', '/')} 23:59】`])
  sold.addRow(['城市', '门店', '营业日期', '菜品编码', '菜品名称', '规格', '单位', '菜品大类', '订单编号', '销售数量', '销售额（元）', '菜品优惠（元）', '菜品收入（元）'])
  sold.addRow(['合肥市', '合肥瑶海店', DATE.replaceAll('-', '/'), 'E2E001', DISH_NAME, '', '份', '测试', `ORDER-${quantity}`, quantity, gross, discount, net])
  const returned = workbook.addWorksheet('退菜')
  returned.addRow(['退菜'])
  returned.addRow([`【结账时间】；【${DATE.replaceAll('-', '/')} 00:00 至 ${DATE.replaceAll('-', '/')} 23:59】`])
  returned.addRow(['城市', '门店', '营业日期', '菜品编码', '菜品名称', '规格', '单位', '菜品大类', '订单编号', '销售数量', '销售额（元）', '菜品优惠（元）', '菜品收入（元）'])
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

async function login() {
  const response = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'manager@yaohai.test', password: 'yaohai@123', tenantSlug: 'yaohai-test' }),
  })
  if (!response.ok) throw new Error(`登录失败 ${response.status}: ${await response.text()}`)
  return (await response.json() as any).token as string
}

const payloadCache = new Map<number, Promise<{ business: Buffer; sales: Buffer }>>()

async function payloadFor(revision: 1 | 2) {
  const input = revision === 1
    ? { quantity: 2, gross: 100, discount: 20, net: 80, orders: 2 }
    : { quantity: 3, gross: 150, discount: 30, net: 120, orders: 3 }
  if (!payloadCache.has(revision)) {
    payloadCache.set(revision, Promise.all([
      businessBuffer(input.gross, input.discount, input.net, input.orders),
      salesBuffer(input.quantity, input.gross, input.discount, input.net),
    ]).then(([business, sales]) => ({ business, sales })))
  }
  return payloadCache.get(revision)!
}

async function preview(token: string, revision: 1 | 2) {
  const payload = await payloadFor(revision)
  const form = new FormData()
  form.append('businessFile', new Blob([payload.business]), `business-v${revision}.xlsx`)
  form.append('salesFile', new Blob([payload.sales]), `sales-v${revision}.xlsx`)
  const response = await fetch(`${API}/api/daily-business-imports/preview`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form })
  const body = await response.json() as any
  if (!response.ok) throw new Error(`预览失败 ${response.status}: ${JSON.stringify(body)}`)
  if (body.blockingIssues.length !== 0) throw new Error(`预览存在阻断: ${JSON.stringify(body.blockingIssues)}`)
  return body
}

async function confirm(token: string, id: string) {
  const response = await fetch(`${API}/api/daily-business-imports/${id}/confirm`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  const body = await response.json() as any
  if (!response.ok) throw new Error(`确认失败 ${response.status}: ${JSON.stringify(body)}`)
  if (body.status !== 'CONFIRMED') throw new Error(`确认状态异常: ${body.status}`)
  return body
}

async function expectPreviewRefresh(token: string, id: string) {
  const response = await fetch(`${API}/api/daily-business-imports/${id}/confirm`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  const body = await response.json() as any
  if (response.status !== 409 || body.code !== 'PREVIEW_REFRESHED') {
    throw new Error(`BOM 变化未阻止旧预览确认 ${response.status}: ${JSON.stringify(body)}`)
  }
  return body.import
}

async function main() {
  assertLocal()
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'yaohai-test' } })
  const store = await prisma.store.findFirstOrThrow({ where: { tenantId: tenant.id, no: 'YH001' } })
  const manager = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: 'MANAGER', storeId: store.id } })
  const product = await prisma.product.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: PRODUCT_CODE } },
    update: { name: 'E2E日报测试食材', unit: 'kg', status: 'ENABLED' },
    create: {
      tenantId: tenant.id, code: PRODUCT_CODE, name: 'E2E日报测试食材', category: '测试', unit: 'kg',
      price: 10, stock: 0, minStock: 0, shelfDays: 1, status: 'ENABLED',
    },
  })
  const dish = await prisma.dish.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: DISH_NAME } },
    update: { inventoryPolicy: 'BOM', salePrice: 50 },
    create: { tenantId: tenant.id, name: DISH_NAME, category: '测试', unit: '份', salePrice: 50, createdById: manager.id },
  })
  await prisma.dishBomVersion.deleteMany({ where: { dishId: dish.id } })
  const firstVersion = await prisma.dishBomVersion.create({
    data: {
      tenantId: tenant.id, dishId: dish.id, variantKey: '', versionNo: 1,
      status: 'PUBLISHED', changeType: 'INITIAL', changeReason: '日报 E2E 初始版本',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), createdById: manager.id,
      publishedById: manager.id, publishedAt: new Date(),
      items: { create: [{ productId: product.id, quantity: 0.25, unit: 'kg', lossRate: 0, isMain: true }] },
    },
  })
  const date = new Date(`${DATE}T00:00:00.000Z`)
  try {
    const token = await login()
    const concurrentPreviews = await Promise.all([preview(token, 1), preview(token, 1)])
    if (concurrentPreviews[0].id !== concurrentPreviews[1].id) {
      throw new Error('相同文件并发预览没有命中同一幂等记录')
    }
    const firstPreview = concurrentPreviews[0]
    const duplicatePreview = await preview(token, 1)
    if (duplicatePreview.id !== firstPreview.id) throw new Error('相同文件对未命中幂等记录')
    await prisma.$transaction([
      prisma.dishBomVersion.update({ where: { id: firstVersion.id }, data: { effectiveTo: new Date('2026-01-01T00:00:00.000Z') } }),
      prisma.dishBomVersion.create({
        data: {
          tenantId: tenant.id, dishId: dish.id, variantKey: '', versionNo: 2,
          status: 'PUBLISHED', changeType: 'BUSINESS_CHANGE', changeReason: '日报 E2E 预览刷新',
          effectiveFrom: date, createdById: manager.id, publishedById: manager.id, publishedAt: new Date(),
          items: { create: [{ productId: product.id, quantity: 0.3, unit: 'kg', lossRate: 0, isMain: true }] },
        },
      }),
    ])
    const refreshed = await expectPreviewRefresh(token, firstPreview.id)
    if (Number(refreshed.previewData.consumptions[0]?.quantity) !== 0.6) {
      throw new Error(`BOM 刷新后的扣减异常: ${JSON.stringify(refreshed.previewData.consumptions)}`)
    }
    await confirm(token, firstPreview.id)
    const secondVersion = await prisma.dishBomVersion.findFirstOrThrow({
      where: { dishId: dish.id, variantKey: '', versionNo: 2 },
    })
    await prisma.$transaction([
      prisma.dishBomVersion.update({ where: { id: secondVersion.id }, data: { status: 'RETIRED' } }),
      prisma.dishBomVersion.create({
        data: {
          tenantId: tenant.id, dishId: dish.id, variantKey: '', versionNo: 3,
          status: 'PUBLISHED', changeType: 'HISTORICAL_CORRECTION', changeReason: '日报 E2E 历史纠错',
          effectiveFrom: date, createdById: manager.id, publishedById: manager.id, publishedAt: new Date(),
          items: { create: [{ productId: product.id, quantity: 0.25, unit: 'kg', lossRate: 0, isMain: true }] },
        },
      }),
    ])
    const sameFileCorrection = await preview(token, 1)
    if (sameFileCorrection.id === firstPreview.id || sameFileCorrection.revision !== firstPreview.revision + 1) {
      throw new Error('同一文件在 BOM 更新后没有生成新的更正版本')
    }
    if (!sameFileCorrection.warningIssues.some((issue: any) => issue.code === 'CORRECTION_MODE')) {
      throw new Error('同文件 BOM 更正预览未提示替换旧版')
    }
    await confirm(token, sameFileCorrection.id)
    const secondPreview = await preview(token, 2)
    if (!secondPreview.warningIssues.some((issue: any) => issue.code === 'CORRECTION_MODE')) throw new Error('更正预览未提示替换旧版')
    await confirm(token, secondPreview.id)

    const [revenue, sales, consumptions, imports] = await Promise.all([
      prisma.revenueRecord.findUnique({ where: { storeId_date: { storeId: store.id, date } } }),
      prisma.dishSale.findMany({ where: { storeId: store.id, date, source: SOURCE } }),
      prisma.stockConsumption.findMany({ where: { storeId: store.id, date, sourceType: 'daily_pos' } }),
      prisma.dailyBusinessImport.findMany({ where: { storeId: store.id, businessDate: date }, orderBy: { revision: 'asc' } }),
    ])
    const report = {
      revenue: Number(revenue?.amount),
      saleRows: sales.length,
      saleQuantity: Number(sales[0]?.quantity),
      consumptionRows: consumptions.length,
      consumptionQuantity: Number(consumptions[0]?.quantity),
      importStatuses: imports.map(item => item.status),
    }
    if (JSON.stringify(report) !== JSON.stringify({
      revenue: 120, saleRows: 1, saleQuantity: 3, consumptionRows: 1,
      consumptionQuantity: 0.75, importStatuses: ['SUPERSEDED', 'SUPERSEDED', 'CONFIRMED'],
    })) throw new Error(`更正结果不符合预期: ${JSON.stringify(report)}`)
    console.log(JSON.stringify({ ok: true, ...report }, null, 2))
  } finally {
    await prisma.stockConsumption.deleteMany({ where: { storeId: store.id, date, sourceType: 'daily_pos' } })
    await prisma.dishSale.deleteMany({ where: { storeId: store.id, date, source: SOURCE } })
    await prisma.revenueRecord.deleteMany({ where: { storeId: store.id, date, source: SOURCE } })
    await prisma.dailyBusinessImport.deleteMany({ where: { storeId: store.id, businessDate: date } })
    await prisma.dish.deleteMany({ where: { id: dish.id } })
    await prisma.product.deleteMany({ where: { id: product.id } })
  }
}

main().then(() => prisma.$disconnect()).catch(async error => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
