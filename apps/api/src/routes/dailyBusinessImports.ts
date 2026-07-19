import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { z } from 'zod'
import {
  normalizeDishName,
  normalizeVariantKey,
  partitionImportIssues,
  parseDailyFiles,
  sha256,
  storeNameMatches,
  type ImportIssue,
  type ParsedDailyFiles,
} from '../services/dailyBusinessImport'
import { isStoreScoped } from '../lib/auth-scope'
import { estimatedStoreInventory } from '../services/storeInventory'
import {
  bomCalculationSnapshot,
  calculateBomConsumptions,
  selectEffectiveBomVersion,
} from '../services/bomLifecycle'

const ALLOWED_ROLES = new Set(['MANAGER', 'KITCHEN_LEAD', 'ADMIN', 'SUPER_ADMIN', 'BOSS'])
const SOURCE = 'daily_pos_upload'
const CONSUMPTION_SOURCE = 'daily_pos'
const BOM_BACKFILL_SOURCE = 'daily_bom_backfill'
const MAX_FILE_BYTES = 5 * 1024 * 1024
const BOM_TASK_ROLES = new Set(['CHEF_DIRECTOR', 'CHEF', 'ADMIN', 'SUPER_ADMIN'])
const CONTROL_CENTER_ROLES = new Set([
  'MANAGER', 'KITCHEN_LEAD', 'CHEF', 'CHEF_DIRECTOR', 'ADMIN', 'SUPER_ADMIN', 'BOSS',
])

type PreviewDishSale = {
  dishId: string
  dishName: string
  quantity: number
  grossAmount: number
  netIncome: number
  variants: ParsedDailyFiles['sales']
}

type PreviewConsumption = {
  productId: string
  productCode: string
  productName: string
  unit: string
  quantity: number
  sources: string[]
  dishId: string
  dishName: string
  variantKey: string
  sourceLineKey: string
  bomVersionId: string
  bomVersionNo: number
  calculationSnapshot: ReturnType<typeof bomCalculationSnapshot>
}

type DeferredBomRow = {
  rawDishName: string
  spec: string
  variantKey: string
  reasonCode: 'DISH_UNMATCHED' | 'BOM_MISSING'
  dishId: string | null
  dishName: string | null
  quantity: number
  grossAmount: number
  netIncome: number
  saleRecorded: boolean
  variants: ParsedDailyFiles['sales']
}

type PreviewData = {
  businessDate: string
  metrics: ParsedDailyFiles['business']
  totals: ParsedDailyFiles['totals']
  dishSales: PreviewDishSale[]
  consumptions: PreviewConsumption[]
  returns: ParsedDailyFiles['returns']
  excludedDishes: Array<{ name: string; quantity: number; note: string | null }>
  deferredBomRows: DeferredBomRow[]
  existingConfirmedRevision: number | null
  existingRevenue: { amount: number; source: string } | null
  calculationFingerprint: string
}

function json<T>(value: T): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value))
}

function dateOnly(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const invalid = () => Object.assign(new Error(`日期格式错误：${value}`), { statusCode: 400 })
  if (!match) throw invalid()
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) throw invalid()
  return parsed
}

function dateText(value: Date) {
  return value.toISOString().slice(0, 10)
}

function round(value: number, digits = 4) {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableJson(item)]),
    )
  }
  return value
}

function calculationFingerprint(preview: Omit<PreviewData, 'calculationFingerprint'> | PreviewData) {
  return sha256(Buffer.from(JSON.stringify(stableJson({
    businessDate: preview.businessDate,
    metrics: {
      date: preview.metrics.date,
      storeName: preview.metrics.storeName,
      grossAmount: preview.metrics.grossAmount,
      discountAmount: preview.metrics.discountAmount,
      netRevenue: preview.metrics.netRevenue,
      orders: preview.metrics.orders,
      diners: preview.metrics.diners,
      tables: preview.metrics.tables,
    },
    dishSales: [...preview.dishSales]
      .map(row => ({
        dishId: row.dishId,
        quantity: row.quantity,
        grossAmount: row.grossAmount,
        netIncome: row.netIncome,
      }))
      .sort((a, b) => a.dishId.localeCompare(b.dishId)),
    consumptions: [...preview.consumptions]
      .map(row => ({
        productId: row.productId,
        quantity: row.quantity,
        sourceLineKey: row.sourceLineKey,
        bomVersionId: row.bomVersionId,
      }))
      .sort((a, b) => `${a.sourceLineKey}\u0000${a.productId}`.localeCompare(`${b.sourceLineKey}\u0000${b.productId}`)),
    deferredBomRows: [...preview.deferredBomRows]
      .map(row => ({
        rawDishName: row.rawDishName,
        variantKey: row.variantKey,
        dishId: row.dishId,
        quantity: row.quantity,
        grossAmount: row.grossAmount,
        netIncome: row.netIncome,
      }))
      .sort((a, b) => `${a.rawDishName}\u0000${a.variantKey}`.localeCompare(`${b.rawDishName}\u0000${b.variantKey}`)),
  }))))
}

function chinaClock(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const today = shifted.toISOString().slice(0, 10)
  const expected = new Date(`${today}T00:00:00.000Z`)
  expected.setUTCDate(expected.getUTCDate() - 1)
  return {
    today,
    expectedBusinessDate: expected.toISOString().slice(0, 10),
    dueAt: new Date(`${today}T03:00:00.000Z`), // 北京时间 11:00
  }
}

function addUtcDays(dateText: string, days: number) {
  const value = dateOnly(dateText)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function dateRange(endDate: string, days: number) {
  return Array.from({ length: days }, (_, index) => addUtcDays(endDate, index - days + 1))
}

function countByStatus(rows: Array<{ status: string }>) {
  return rows.reduce<Record<string, number>>((result, row) => {
    result[row.status] = (result[row.status] || 0) + 1
    return result
  }, {})
}

async function targetStore(user: any, requestedStoreId?: string | null) {
  const isStoreRole = isStoreScoped(user.role)
  if (isStoreRole && requestedStoreId && requestedStoreId !== user.storeId) {
    throw Object.assign(new Error('只能操作当前账号绑定的门店'), { statusCode: 403 })
  }
  const storeId = isStoreRole ? user.storeId : (requestedStoreId || user.storeId)
  if (!storeId) throw Object.assign(new Error('当前账号没有绑定门店'), { statusCode: 400 })
  const store = await prisma.store.findFirst({ where: { id: storeId, tenantId: user.tenantId } })
  if (!store) throw Object.assign(new Error('门店不存在或不属于当前租户'), { statusCode: 404 })
  return store
}

async function readMultipart(req: any) {
  const files = new Map<string, { filename: string; buffer: Buffer }>()
  const fields = new Map<string, string>()
  for await (const part of req.parts()) {
    if (part.type === 'field') {
      fields.set(part.fieldname, String(part.value || ''))
      continue
    }
    const filename = String(part.filename || '')
    if (!filename.toLowerCase().endsWith('.xlsx')) {
      part.file.resume()
      throw Object.assign(new Error('只支持 .xlsx 文件，请从收银后台导出 Excel'), { statusCode: 400 })
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of part.file) {
      size += chunk.length
      if (size > MAX_FILE_BYTES) throw Object.assign(new Error('单个文件不能超过 5MB'), { statusCode: 400 })
      chunks.push(chunk)
    }
    if (part.file.truncated) throw Object.assign(new Error('文件过大，上传已被截断'), { statusCode: 400 })
    files.set(part.fieldname, { filename, buffer: Buffer.concat(chunks) })
  }
  const business = files.get('businessFile')
  const sales = files.get('salesFile')
  if (!business || !sales) throw Object.assign(new Error('请同时上传综合营业统计和菜品销售明细'), { statusCode: 400 })
  return { business, sales, storeId: fields.get('storeId') || null }
}

function addDeferredRow(
  target: Map<string, DeferredBomRow>,
  row: ParsedDailyFiles['sales'][number],
  dish: { id: string; name: string } | null,
  reasonCode: DeferredBomRow['reasonCode'],
  saleRecorded: boolean,
) {
  const variantKey = normalizeVariantKey(row.spec)
  const key = `${normalizeDishName(row.name)}\u0000${variantKey}`
  const current = target.get(key) || {
    rawDishName: row.name,
    spec: row.spec,
    variantKey,
    reasonCode,
    dishId: dish?.id || null,
    dishName: dish?.name || null,
    quantity: 0,
    grossAmount: 0,
    netIncome: 0,
    saleRecorded,
    variants: [],
  }
  current.quantity += row.quantity
  current.grossAmount += row.grossAmount
  current.netIncome += row.netIncome
  current.variants.push(row)
  target.set(key, current)
}

async function buildPreview(store: { id: string; tenantId: string }, parsed: ParsedDailyFiles) {
  const blockingIssues: ImportIssue[] = [...parsed.blockingIssues]
  const warningIssues: ImportIssue[] = [...parsed.warningIssues]
  const storeRecord = await prisma.store.findFirst({
    where: { id: store.id, tenantId: store.tenantId },
    select: { name: true },
  })
  if (!storeRecord || !storeNameMatches(storeRecord.name, parsed.business.storeName)) {
    blockingIssues.push({
      code: 'TARGET_STORE_MISMATCH',
      message: '报表门店与当前操作门店不一致',
      detail: `当前门店：${storeRecord?.name || '未知'}；报表门店：${parsed.business.storeName}`,
    })
  }
  const businessDate = dateOnly(parsed.business.date)
  const names = [...new Set(parsed.sales.map(row => row.name))]
  const dishes = await prisma.dish.findMany({
    where: { tenantId: store.tenantId },
    include: {
      aliases: { where: { source: 'daily_pos', isActive: true } },
      bomVersions: {
        where: { status: 'PUBLISHED' },
        include: { items: { include: { product: { select: { id: true, code: true, name: true, unit: true } } } } },
      },
    },
  })
  const normalizedDishes = new Map<string, typeof dishes>()
  for (const dish of dishes) {
    const keys = new Set([normalizeDishName(dish.name), ...dish.aliases.map(alias => alias.normalizedName)])
    for (const key of keys) {
      const candidates = normalizedDishes.get(key) || []
      if (!candidates.some(candidate => candidate.id === dish.id)) normalizedDishes.set(key, [...candidates, dish])
    }
  }
  const matched = new Map<string, (typeof dishes)[number]>()
  for (const name of names) {
    const candidates = normalizedDishes.get(normalizeDishName(name)) || []
    if (candidates.length === 0) {
      blockingIssues.push({ code: 'DISH_UNMATCHED', message: `菜品未建档：${name}`, detail: '请先在菜品档案中建立或关联该菜品' })
    } else if (candidates.length > 1) {
      blockingIssues.push({ code: 'DISH_AMBIGUOUS', message: `菜品匹配不唯一：${name}` })
    } else {
      matched.set(name, candidates[0])
    }
  }

  const saleByDish = new Map<string, PreviewDishSale>()
  const consumptionByProduct = new Map<string, PreviewConsumption>()
  const excludedDishes: PreviewData['excludedDishes'] = []
  const deferredByDishVariant = new Map<string, DeferredBomRow>()
  const missingRecipeKeys = new Set<string>()
  for (const row of parsed.sales) {
    const dish = matched.get(row.name)
    if (!dish) {
      addDeferredRow(deferredByDishVariant, row, null, 'DISH_UNMATCHED', false)
      continue
    }
    const currentSale = saleByDish.get(dish.id) || {
      dishId: dish.id, dishName: dish.name, quantity: 0, grossAmount: 0, netIncome: 0, variants: [],
    }
    currentSale.quantity += row.quantity
    currentSale.grossAmount += row.grossAmount
    currentSale.netIncome += row.netIncome
    currentSale.variants.push(row)
    saleByDish.set(dish.id, currentSale)

    if (dish.inventoryPolicy === 'EXCLUDE') {
      excludedDishes.push({ name: row.name, quantity: row.quantity, note: dish.inventoryPolicyNote })
      continue
    }
    const variantKey = normalizeVariantKey(row.spec)
    const bomVersion = selectEffectiveBomVersion(dish.bomVersions, businessDate, variantKey)
    if (!bomVersion || bomVersion.items.length === 0) {
      addDeferredRow(deferredByDishVariant, row, dish, 'BOM_MISSING', true)
      const issueKey = `${row.name}\u0000${row.spec}`
      if (!missingRecipeKeys.has(issueKey)) {
        missingRecipeKeys.add(issueKey)
        blockingIssues.push({
          code: 'BOM_MISSING',
          message: `缺少可执行 BOM：${row.name}${row.spec ? `（${row.spec}）` : ''}`,
          detail: '未确认配方的菜品不会静默跳过，补齐后请重新预览',
        })
      }
      continue
    }
    const calculationSnapshot = bomCalculationSnapshot({
      dishId: dish.id,
      dishName: dish.name,
      variantKey,
      saleQuantity: row.quantity,
      version: bomVersion,
    })
    const sourceLineKey = sha256(Buffer.from(`${dish.id}\u0000${variantKey}\u0000${bomVersion.id}`)).slice(0, 32)
    for (const recipe of bomVersion.items) {
      const quantity = row.quantity * Number(recipe.quantity) * (1 + Number(recipe.lossRate))
      if (quantity <= 0) continue
      const consumptionKey = `${sourceLineKey}\u0000${recipe.productId}`
      const current = consumptionByProduct.get(consumptionKey) || {
        productId: recipe.product.id,
        productCode: recipe.product.code,
        productName: recipe.product.name,
        unit: recipe.product.unit,
        quantity: 0,
        sources: [],
        dishId: dish.id,
        dishName: dish.name,
        variantKey,
        sourceLineKey,
        bomVersionId: bomVersion.id,
        bomVersionNo: bomVersion.versionNo,
        calculationSnapshot: { ...calculationSnapshot, saleQuantity: 0 },
      }
      current.quantity += quantity
      current.calculationSnapshot.saleQuantity += row.quantity
      current.sources.push(`${row.name}${row.spec ? `(${row.spec})` : ''} ${row.quantity}份`)
      consumptionByProduct.set(consumptionKey, current)
    }
  }
  if (excludedDishes.length > 0) {
    warningIssues.push({ code: 'INVENTORY_EXCLUDED', message: `${excludedDishes.length} 个品项按已确认规则不扣库存` })
  }
  const [previous, existingRevenue] = await Promise.all([
    prisma.dailyBusinessImport.findFirst({
      where: { storeId: store.id, businessDate, status: 'CONFIRMED' },
      orderBy: { revision: 'desc' }, select: { revision: true },
    }),
    prisma.revenueRecord.findUnique({
      where: { storeId_date: { storeId: store.id, date: businessDate } },
      select: { amount: true, source: true },
    }),
  ])
  if (previous) warningIssues.push({ code: 'CORRECTION_MODE', message: `该日已有第 ${previous.revision} 版，确认后将原子替换并保留旧版审计` })
  else if (existingRevenue) warningIssues.push({ code: 'REVENUE_REPLACE', message: `该日已有 ${existingRevenue.source} 营业记录，确认后将以本次文件为准` })

  const previewBase: Omit<PreviewData, 'calculationFingerprint'> = {
    businessDate: parsed.business.date,
    metrics: parsed.business,
    totals: parsed.totals,
    dishSales: [...saleByDish.values()].map(row => ({
      ...row,
      quantity: round(row.quantity),
      grossAmount: round(row.grossAmount, 2),
      netIncome: round(row.netIncome, 2),
    })),
    consumptions: [...consumptionByProduct.values()].map(row => ({ ...row, quantity: round(row.quantity, 6) })),
    returns: parsed.returns,
    excludedDishes,
    deferredBomRows: [...deferredByDishVariant.values()].map(row => ({
      ...row,
      quantity: round(row.quantity),
      grossAmount: round(row.grossAmount, 2),
      netIncome: round(row.netIncome, 2),
    })),
    existingConfirmedRevision: previous?.revision || null,
    existingRevenue: existingRevenue ? { amount: Number(existingRevenue.amount), source: existingRevenue.source } : null,
  }
  const preview: PreviewData = {
    ...previewBase,
    calculationFingerprint: calculationFingerprint(previewBase),
  }
  return { preview, blockingIssues, warningIssues }
}

function publicImport(row: any) {
  return {
    ...row,
    grossAmount: Number(row.grossAmount),
    discountAmount: Number(row.discountAmount),
    netRevenue: Number(row.netRevenue),
  }
}

function publicDeferredTask(row: any) {
  const bomVersion = row.dish
    ? selectEffectiveBomVersion(row.dish.bomVersions || [], row.businessDate, row.variantKey)
    : null
  return {
    ...row,
    quantity: Number(row.quantity),
    grossAmount: Number(row.grossAmount),
    netIncome: Number(row.netIncome),
    recipeReady: Boolean(bomVersion?.items?.length),
    bomVersion: bomVersion ? {
      id: bomVersion.id,
      versionNo: bomVersion.versionNo,
      variantKey: bomVersion.variantKey,
      effectiveFrom: bomVersion.effectiveFrom,
    } : null,
  }
}

export const dailyBusinessImportRoutes: FastifyPluginAsync = async app => {
  const auth = { preHandler: [(app as any).authenticate] }

  app.get('/status', auth, async (req: any, reply: any) => {
    if (!ALLOWED_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权查看每日营业上传' })
    const store = await targetStore(req.user, req.query?.storeId)
    const clock = chinaClock()
    const requestedDate = String(req.query?.date || clock.expectedBusinessDate)
    const [confirmed, latest, history] = await Promise.all([
      prisma.dailyBusinessImport.findFirst({
        where: { storeId: store.id, businessDate: dateOnly(requestedDate), status: 'CONFIRMED' },
        orderBy: { revision: 'desc' },
      }),
      prisma.dailyBusinessImport.findFirst({
        where: { storeId: store.id, businessDate: dateOnly(requestedDate) },
        orderBy: [{ revision: 'desc' }, { createdAt: 'desc' }],
      }),
      prisma.dailyBusinessImport.findMany({
        where: { storeId: store.id }, orderBy: [{ businessDate: 'desc' }, { revision: 'desc' }], take: 12,
        select: {
          id: true, businessDate: true, revision: true, status: true, grossAmount: true,
          discountAmount: true, netRevenue: true, orderCount: true, dishRowCount: true,
          blockingIssues: true, warningIssues: true, previewData: true,
          createdAt: true, confirmedAt: true, businessFileName: true, salesFileName: true,
        },
      }),
    ])
    const isExpectedDate = requestedDate === clock.expectedBusinessDate
    return {
      store: { id: store.id, name: store.name, no: store.no },
      requestedDate,
      expectedBusinessDate: clock.expectedBusinessDate,
      dueAt: clock.dueAt.toISOString(),
      state: confirmed ? 'CONFIRMED' : (isExpectedDate && new Date() >= clock.dueAt ? 'OVERDUE' : 'PENDING'),
      latest: latest ? publicImport(latest) : null,
      history: history.map(publicImport),
    }
  })

  // 每日运营控制中心：把日报、销量、BOM 待办和门店预计库存放在同一份只读状态中。
  // 页面只是角色视图，状态口径仍来自日报、BOM 和库存三个权威模块。
  app.get('/control-center', auth, async (req: any, reply: any) => {
    if (!CONTROL_CENTER_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权查看每日运营控制中心' })
    const parsedQuery = z.object({
      days: z.coerce.number().int().min(1).max(31).default(7),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      storeId: z.string().trim().min(1).optional(),
    }).safeParse(req.query || {})
    if (!parsedQuery.success) return reply.status(400).send({ error: parsedQuery.error.issues[0].message })

    try {
      const clock = chinaClock()
      const endDate = parsedQuery.data.endDate || clock.expectedBusinessDate
      dateOnly(endDate)
      if (endDate > clock.expectedBusinessDate) {
        return reply.status(400).send({ error: '运营控制中心只能查看已结束的营业日' })
      }
      const dates = dateRange(endDate, parsedQuery.data.days)
      const start = dateOnly(dates[0])
      const end = dateOnly(endDate)

      let stores: Array<{ id: string; name: string; no: string }>
      if (isStoreScoped(req.user.role)) {
        const store = await targetStore(req.user, parsedQuery.data.storeId)
        stores = [{ id: store.id, name: store.name, no: store.no }]
      } else if (parsedQuery.data.storeId) {
        const store = await targetStore(req.user, parsedQuery.data.storeId)
        stores = [{ id: store.id, name: store.name, no: store.no }]
      } else {
        stores = await prisma.store.findMany({
          where: { tenantId: req.user.tenantId, status: 'ENABLED' },
          select: { id: true, name: true, no: true },
          orderBy: [{ no: 'asc' }, { id: 'asc' }],
        })
      }
      const storeIds = stores.map(store => store.id)
      if (storeIds.length === 0) {
        return {
          generatedAt: new Date().toISOString(), expectedBusinessDate: clock.expectedBusinessDate,
          dueAt: clock.dueAt.toISOString(), dates, summary: { storeCount: 0, missingDays: 0, pendingBomTasks: 0, negativeStockSkus: 0 }, stores: [],
        }
      }

      const [imports, deferredTasks, inventoryByStore] = await Promise.all([
        prisma.dailyBusinessImport.findMany({
          where: { tenantId: req.user.tenantId, storeId: { in: storeIds }, businessDate: { gte: start, lte: end } },
          orderBy: [{ businessDate: 'desc' }, { revision: 'desc' }, { createdAt: 'desc' }],
          select: {
            id: true, storeId: true, businessDate: true, revision: true, status: true,
            grossAmount: true, discountAmount: true, netRevenue: true, orderCount: true,
            dishRowCount: true, previewData: true, blockingIssues: true, warningIssues: true,
            businessFileName: true, salesFileName: true, confirmedAt: true, createdAt: true,
          },
        }),
        prisma.deferredBomTask.findMany({
          where: { tenantId: req.user.tenantId, storeId: { in: storeIds }, businessDate: { gte: start, lte: end } },
          select: { dailyBusinessImportId: true, storeId: true, businessDate: true, status: true },
        }),
        Promise.all(stores.map(async store => {
          const inventory = await estimatedStoreInventory(req.user.tenantId, store.id)
          return [store.id, inventory] as const
        })),
      ])

      const importsByStoreDate = new Map<string, typeof imports>()
      for (const row of imports) {
        const key = `${row.storeId}:${row.businessDate.toISOString().slice(0, 10)}`
        const values = importsByStoreDate.get(key) || []
        values.push(row)
        importsByStoreDate.set(key, values)
      }
      const tasksByImport = new Map<string, Array<{ status: string }>>()
      for (const task of deferredTasks) {
        const values = tasksByImport.get(task.dailyBusinessImportId) || []
        values.push(task)
        tasksByImport.set(task.dailyBusinessImportId, values)
      }
      const inventoryMap = new Map(inventoryByStore)
      const now = new Date()
      const storeRows = stores.map(store => {
        const inventory = inventoryMap.get(store.id)!
        const rows = [...dates].reverse().map(businessDate => {
          const versions = importsByStoreDate.get(`${store.id}:${businessDate}`) || []
          const latest = versions[0] || null
          const confirmed = versions.find(row => row.status === 'CONFIRMED') || null
          const taskCounts = confirmed ? countByStatus(tasksByImport.get(confirmed.id) || []) : {}
          const preview = (confirmed?.previewData || latest?.previewData || {}) as any
          const missingState = businessDate < clock.expectedBusinessDate || now >= clock.dueAt ? 'OVERDUE' : 'PENDING'
          return {
            businessDate,
            state: confirmed ? 'CONFIRMED' : (latest ? latest.status : missingState),
            revision: confirmed?.revision || latest?.revision || null,
            correctionPending: Boolean(confirmed && latest && latest.revision > confirmed.revision && latest.status !== 'SUPERSEDED'),
            metrics: confirmed ? {
              grossAmount: Number(confirmed.grossAmount), discountAmount: Number(confirmed.discountAmount),
              netRevenue: Number(confirmed.netRevenue), orderCount: confirmed.orderCount,
            } : null,
            dishSaleCount: Array.isArray(preview?.dishSales) ? preview.dishSales.length : (confirmed?.dishRowCount || latest?.dishRowCount || 0),
            consumptionSkuCount: Array.isArray(preview?.consumptions) ? preview.consumptions.length : 0,
            deferredBom: {
              pending: taskCounts.PENDING || 0,
              backfilled: taskCounts.BACKFILLED || 0,
              superseded: taskCounts.SUPERSEDED || 0,
            },
            issueCount: Array.isArray(latest?.blockingIssues) ? latest!.blockingIssues.length : 0,
            warningCount: Array.isArray(confirmed?.warningIssues || latest?.warningIssues)
              ? ((confirmed?.warningIssues || latest?.warningIssues) as any[]).length
              : 0,
            files: latest ? { business: latest.businessFileName, sales: latest.salesFileName } : null,
            confirmedAt: confirmed?.confirmedAt?.toISOString() || null,
          }
        })
        const inventoryItems = inventory.items || []
        return {
          store,
          inventory: {
            ...inventory.summary,
            negativeStockCount: inventoryItems.filter((item: any) => item.hasDataIssue).length,
            expiringCount: inventoryItems.filter((item: any) => item.isExpired || item.isExpiringSoon).length,
          },
          rows,
        }
      })
      const allRows = storeRows.flatMap(store => store.rows)
      return {
        generatedAt: new Date().toISOString(),
        expectedBusinessDate: clock.expectedBusinessDate,
        dueAt: clock.dueAt.toISOString(),
        dates,
        summary: {
          storeCount: stores.length,
          missingDays: allRows.filter(row => row.state === 'PENDING' || row.state === 'OVERDUE').length,
          overdueDays: allRows.filter(row => row.state === 'OVERDUE').length,
          pendingBomTasks: allRows.reduce((sum, row) => sum + row.deferredBom.pending, 0),
          negativeStockSkus: storeRows.reduce((sum, row) => sum + row.inventory.negativeStockCount, 0),
          baselineIssueStores: storeRows.filter(row => row.inventory.status !== 'AVAILABLE' || row.inventory.unmatchedCount > 0 || row.inventory.normalizationPendingCount > 0).length,
        },
        stores: storeRows,
      }
    } catch (error: any) {
      req.log.error({ error }, 'daily operations control center failed')
      return reply.status(error.statusCode || 400).send({ error: error.message || '运营控制中心加载失败' })
    }
  })

  app.post('/preview', auth, async (req: any, reply: any) => {
    if (!ALLOWED_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权上传每日营业数据' })
    try {
      const upload = await readMultipart(req)
      const store = await targetStore(req.user, upload.storeId)
      const parsed = await parseDailyFiles(
        upload.business.buffer,
        upload.sales.buffer,
        { targetStoreName: store.name },
      )
      const businessDate = dateOnly(parsed.business.date)
      if (businessDate > dateOnly(chinaClock().expectedBusinessDate)) {
        return reply.status(400).send({ error: '只能导入已结束的营业日，不能导入当天或未来数据' })
      }
      const businessHash = sha256(upload.business.buffer)
      const salesHash = sha256(upload.sales.buffer)
      const built = await buildPreview(store, parsed)
      const allocated = await prisma.$transaction(async tx => {
        const lockKey = `daily-import:${store.tenantId}:${store.id}:${parsed.business.date}`
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`)
        const existing = await tx.dailyBusinessImport.findUnique({
          where: {
            daily_import_version_uk: {
              storeId: store.id,
              businessDate,
              businessFileHash: businessHash,
              salesFileHash: salesHash,
              calculationFingerprint: built.preview.calculationFingerprint,
            },
          },
        })
        if (existing) return { existing, created: null }
        const latest = await tx.dailyBusinessImport.aggregate({
          where: { storeId: store.id, businessDate }, _max: { revision: true },
        })
        const created = await tx.dailyBusinessImport.create({
          data: {
            tenantId: store.tenantId,
            storeId: store.id,
            businessDate,
            revision: (latest._max.revision || 0) + 1,
            status: 'PREVIEWED',
            businessFileName: upload.business.filename,
            businessFileHash: businessHash,
            salesFileName: upload.sales.filename,
            salesFileHash: salesHash,
            calculationFingerprint: built.preview.calculationFingerprint,
            grossAmount: parsed.business.grossAmount,
            discountAmount: parsed.business.discountAmount,
            netRevenue: parsed.business.netRevenue,
            orderCount: parsed.business.orders,
            dishRowCount: parsed.sales.length,
            parsedData: json(parsed),
            previewData: json(built.preview),
            blockingIssues: json(built.blockingIssues),
            warningIssues: json(built.warningIssues),
            createdById: req.user.userId,
          },
        })
        await tx.dailyBusinessImport.updateMany({
          where: {
            id: { not: created.id },
            storeId: store.id,
            businessDate,
            businessFileHash: businessHash,
            salesFileHash: salesHash,
            status: 'PREVIEWED',
          },
          data: { status: 'SUPERSEDED', supersededAt: new Date() },
        })
        return { existing: null, created }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 })
      if (allocated.existing?.status === 'PREVIEWED' || allocated.existing?.status === 'CONFIRMED') {
        return reply.send(publicImport(allocated.existing))
      }
      if (allocated.existing) {
        return reply.status(409).send({
          error: allocated.existing.status === 'SUPERSEDED'
            ? '这组文件已被后续更正版本替代，请上传新的更正文件'
            : `这组文件当前状态为 ${allocated.existing.status}，请稍后刷新`,
        })
      }
      return reply.status(201).send(publicImport(allocated.created!))
    } catch (error: any) {
      req.log.warn({ error }, 'daily import preview failed')
      return reply.status(error.statusCode || 400).send({ error: error.message || '文件解析失败' })
    }
  })

  app.get('/bom-tasks', auth, async (req: any, reply: any) => {
    if (!BOM_TASK_ROLES.has(req.user.role)) return reply.status(403).send({ error: '仅总厨/管理员可处理菜品 BOM 待办' })
    const status = String(req.query?.status || 'PENDING')
    if (!['PENDING', 'BACKFILLED', 'SUPERSEDED', 'ALL'].includes(status)) {
      return reply.status(400).send({ error: '待办状态无效' })
    }
    const tasks = await prisma.deferredBomTask.findMany({
      where: { tenantId: req.user.tenantId, ...(status === 'ALL' ? {} : { status: status as any }) },
      include: {
        store: { select: { id: true, name: true, no: true } },
        dish: {
          select: {
            id: true, name: true, status: true,
            bomVersions: {
              where: { status: 'PUBLISHED' },
              select: {
                id: true, variantKey: true, versionNo: true, status: true, effectiveFrom: true, effectiveTo: true,
                items: {
                  select: {
                    productId: true, quantity: true, unit: true, lossRate: true,
                    product: { select: { id: true, name: true, code: true, unit: true } },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [{ businessDate: 'asc' }, { createdAt: 'asc' }],
      take: 500,
    })
    return tasks.map(publicDeferredTask)
  })

  app.put('/bom-tasks/:taskId/dish', auth, async (req: any, reply: any) => {
    if (!BOM_TASK_ROLES.has(req.user.role)) return reply.status(403).send({ error: '仅总厨/管理员可关联菜品' })
    const dishId = String(req.body?.dishId || '')
    if (!dishId) return reply.status(400).send({ error: '请选择菜品' })
    const [task, dish] = await Promise.all([
      prisma.deferredBomTask.findFirst({ where: { id: req.params.taskId, tenantId: req.user.tenantId, status: 'PENDING' } }),
      prisma.dish.findFirst({ where: { id: dishId, tenantId: req.user.tenantId } }),
    ])
    if (!task) return reply.status(404).send({ error: '待办不存在或已处理' })
    if (!dish) return reply.status(400).send({ error: '菜品不存在或不属于当前品牌' })
    const normalizedName = normalizeDishName(task.rawDishName)
    const updated = await prisma.$transaction(async tx => {
      const existingAlias = await tx.dishAlias.findUnique({
        where: { tenantId_source_normalizedName: { tenantId: req.user.tenantId, source: 'daily_pos', normalizedName } },
      })
      if (existingAlias && existingAlias.dishId !== dish.id) {
        throw Object.assign(new Error('该收银菜名已关联到其他菜品，请先处理别名冲突'), { statusCode: 409 })
      }
      if (existingAlias) {
        await tx.dishAlias.update({ where: { id: existingAlias.id }, data: { isActive: true, rawName: task.rawDishName } })
      } else if (normalizeDishName(dish.name) !== normalizedName) {
        await tx.dishAlias.create({
          data: {
            tenantId: req.user.tenantId, dishId: dish.id, source: 'daily_pos',
            rawName: task.rawDishName, normalizedName, createdById: req.user.userId,
          },
        })
      }
      return tx.deferredBomTask.update({ where: { id: task.id }, data: { dishId: dish.id } })
    })
    return publicDeferredTask(updated)
  })

  app.post('/bom-tasks/:taskId/backfill', auth, async (req: any, reply: any) => {
    if (!BOM_TASK_ROLES.has(req.user.role)) return reply.status(403).send({ error: '仅总厨/管理员可回补库存消耗' })
    const task = await prisma.deferredBomTask.findFirst({
      where: { id: req.params.taskId, tenantId: req.user.tenantId },
      include: {
        dish: {
          include: {
            bomVersions: { where: { status: 'PUBLISHED' }, include: { items: true } },
          },
        },
      },
    })
    if (!task) return reply.status(404).send({ error: 'BOM 待办不存在' })
    if (task.status === 'BACKFILLED') return reply.send(publicDeferredTask(task))
    if (task.status !== 'PENDING') return reply.status(409).send({ error: `当前状态 ${task.status} 不能回补` })
    if (!task.dish) return reply.status(409).send({ error: '请先关联或新建菜品' })
    const dish = task.dish
    const bomVersion = selectEffectiveBomVersion(dish.bomVersions, task.businessDate, task.variantKey)
    if (!bomVersion || bomVersion.items.length === 0) {
      return reply.status(409).send({ error: `菜品“${task.dish.name}”仍缺少${task.spec ? `“${task.spec}”规格或默认` : '默认'} BOM` })
    }
    const now = new Date()
    try {
      await prisma.$transaction(async tx => {
        const locked = await tx.deferredBomTask.updateMany({
          where: { id: task.id, status: 'PENDING' },
          data: { status: 'BACKFILLED', resolvedById: req.user.userId, backfilledAt: now },
        })
        if (locked.count !== 1) throw Object.assign(new Error('该待办已被其他操作处理，请刷新'), { statusCode: 409 })
        const consumptions = calculateBomConsumptions(Number(task.quantity), bomVersion.items)
        if (consumptions.length > 0) {
          const snapshot = bomCalculationSnapshot({
            dishId: dish.id,
            dishName: dish.name,
            variantKey: task.variantKey,
            saleQuantity: Number(task.quantity),
            version: bomVersion,
          })
          await tx.stockConsumption.createMany({
            data: consumptions.map(({ productId, quantity }) => ({
              tenantId: task.tenantId,
              storeId: task.storeId,
              productId,
              date: task.businessDate,
              quantity,
              note: `总厨补齐 BOM 后回补；${task.rawDishName}${task.spec ? `(${task.spec})` : ''} ${Number(task.quantity)}份`,
              sourceType: BOM_BACKFILL_SOURCE,
              sourceId: task.id,
              sourceLineKey: bomVersion.id,
              dishId: dish.id,
              variantKey: task.variantKey,
              bomVersionId: bomVersion.id,
              calculationSnapshot: json(snapshot),
              createdById: req.user.userId,
            })),
          })
        }
        if (!task.saleRecorded) {
          await tx.dishSale.upsert({
            where: {
              storeId_dishId_date_source: {
                storeId: task.storeId, dishId: dish.id, date: task.businessDate, source: SOURCE,
              },
            },
            update: {
              quantity: { increment: task.quantity },
              grossAmount: { increment: task.netIncome },
            },
            create: {
              tenantId: task.tenantId,
              storeId: task.storeId,
              dishId: dish.id,
              date: task.businessDate,
              quantity: task.quantity,
              grossAmount: task.netIncome,
              source: SOURCE,
              channel: '收银POS日报',
              rawData: json({ deferredBomTaskId: task.id, grossAmount: Number(task.grossAmount), netIncome: Number(task.netIncome) }),
              createdById: req.user.userId,
            },
          })
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 })
      const completed = await prisma.deferredBomTask.findUniqueOrThrow({
        where: { id: task.id },
        include: {
          dish: { include: { bomVersions: { where: { status: 'PUBLISHED' }, include: { items: true } } } },
          store: true,
        },
      })
      return reply.send(publicDeferredTask(completed))
    } catch (error: any) {
      req.log.error({ error, taskId: task.id }, 'deferred BOM backfill failed')
      return reply.status(error.statusCode || 500).send({ error: error.message || '回补失败，库存未发生部分扣减' })
    }
  })

  // 历史 BOM 纠错必须先看影响，再由总厨明确确认。按原日报快照整日重算，避免只修一道菜时破坏聚合消耗。
  app.get('/bom-recalculation-impact', auth, async (req: any, reply: any) => {
    if (!BOM_TASK_ROLES.has(req.user.role)) return reply.status(403).send({ error: '仅总厨/管理员可查看历史重算影响' })
    const versionId = String(req.query?.versionId || '')
    if (!versionId) return reply.status(400).send({ error: '缺少 BOM 版本' })
    const version = await prisma.dishBomVersion.findFirst({
      where: { id: versionId, tenantId: req.user.tenantId, status: 'PUBLISHED' },
      include: { dish: { select: { id: true, name: true } } },
    })
    if (!version || !version.effectiveFrom) return reply.status(404).send({ error: '已发布 BOM 版本不存在' })
    if (version.changeType !== 'HISTORICAL_CORRECTION') return reply.status(409).send({ error: '只有历史配方纠错需要重算历史日报' })
    const end = version.effectiveTo || dateOnly(chinaClock().expectedBusinessDate)
    const [imports, sales] = await Promise.all([
      prisma.dailyBusinessImport.findMany({
        where: { tenantId: req.user.tenantId, status: 'CONFIRMED', businessDate: { gte: version.effectiveFrom, lte: end } },
        select: { id: true, businessDate: true, store: { select: { id: true, name: true } } },
        orderBy: { businessDate: 'asc' },
      }),
      prisma.dishSale.aggregate({
        where: { tenantId: req.user.tenantId, dishId: version.dishId, date: { gte: version.effectiveFrom, lte: end } },
        _sum: { quantity: true, grossAmount: true }, _count: true,
      }),
    ])
    return {
      version: { id: version.id, versionNo: version.versionNo, dish: version.dish, variantKey: version.variantKey, effectiveFrom: version.effectiveFrom, effectiveTo: version.effectiveTo },
      importCount: imports.length,
      stores: [...new Map(imports.map(row => [row.store.id, row.store])).values()],
      from: version.effectiveFrom,
      to: end,
      saleDays: sales._count,
      saleQuantity: Number(sales._sum.quantity || 0),
      saleRevenue: Number(sales._sum.grossAmount || 0),
    }
  })

  app.post('/bom-recalculation', auth, async (req: any, reply: any) => {
    if (!BOM_TASK_ROLES.has(req.user.role)) return reply.status(403).send({ error: '仅总厨/管理员可重算历史日报' })
    const parsed = z.object({ versionId: z.string().min(1), confirm: z.literal(true) }).safeParse(req.body || {})
    if (!parsed.success) return reply.status(400).send({ error: '必须明确确认历史重算' })
    const version = await prisma.dishBomVersion.findFirst({
      where: { id: parsed.data.versionId, tenantId: req.user.tenantId, status: 'PUBLISHED', changeType: 'HISTORICAL_CORRECTION' },
      include: { dish: { select: { name: true } } },
    })
    if (!version?.effectiveFrom) return reply.status(404).send({ error: '历史纠错 BOM 版本不存在' })
    const end = version.effectiveTo || dateOnly(chinaClock().expectedBusinessDate)
    const imports = await prisma.dailyBusinessImport.findMany({
      where: { tenantId: req.user.tenantId, status: 'CONFIRMED', businessDate: { gte: version.effectiveFrom, lte: end } },
      orderBy: { businessDate: 'asc' },
    })
    const rebuilt = [] as Array<{ record: typeof imports[number]; result: Awaited<ReturnType<typeof buildPreview>> }>
    for (const record of imports) {
      const result = await buildPreview({ id: record.storeId, tenantId: record.tenantId }, record.parsedData as unknown as ParsedDailyFiles)
      const hard = partitionImportIssues(result.blockingIssues).hard
      if (hard.length > 0) {
        return reply.status(409).send({
          error: `${dateText(record.businessDate)} 日报存在阻断问题，历史数据未发生任何改动`,
          issues: hard,
        })
      }
      rebuilt.push({ record, result })
    }
    try {
      await prisma.$transaction(async tx => {
        for (const { record, result } of rebuilt) {
          await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`daily-bom-recalc:${record.id}`}))`)
          const preview = result.preview
          const tasks = await tx.deferredBomTask.findMany({
            where: { dailyBusinessImportId: record.id }, select: { id: true, rawDishName: true, variantKey: true, status: true },
          })
          const unresolved = new Set(preview.deferredBomRows.map(row => `${normalizeDishName(row.rawDishName)}\u0000${row.variantKey}`))
          const nowResolved = tasks.filter(task => task.status !== 'SUPERSEDED'
            && !unresolved.has(`${normalizeDishName(task.rawDishName)}\u0000${task.variantKey}`))
          if (nowResolved.length > 0) {
            await tx.stockConsumption.deleteMany({
              where: { sourceType: BOM_BACKFILL_SOURCE, sourceId: { in: nowResolved.map(task => task.id) } },
            })
            await tx.deferredBomTask.updateMany({
              where: { id: { in: nowResolved.map(task => task.id) } }, data: { status: 'SUPERSEDED' },
            })
          }
          await tx.stockConsumption.deleteMany({
            where: { tenantId: record.tenantId, storeId: record.storeId, sourceType: CONSUMPTION_SOURCE, sourceId: record.id },
          })
          if (preview.consumptions.length > 0) {
            await tx.stockConsumption.createMany({
              data: preview.consumptions.map(row => ({
                tenantId: record.tenantId, storeId: record.storeId, productId: row.productId,
                date: record.businessDate, quantity: row.quantity,
                note: `历史 BOM 纠错重算；${row.sources.join('；')}`.slice(0, 1000),
                sourceType: CONSUMPTION_SOURCE, sourceId: record.id, sourceLineKey: row.sourceLineKey,
                dishId: row.dishId, variantKey: row.variantKey, bomVersionId: row.bomVersionId,
                calculationSnapshot: json(row.calculationSnapshot), createdById: req.user.userId,
              })),
            })
          }
          await tx.dishSale.deleteMany({
            where: { tenantId: record.tenantId, storeId: record.storeId, date: record.businessDate, source: SOURCE },
          })
          if (preview.dishSales.length > 0) {
            await tx.dishSale.createMany({
              data: preview.dishSales.map(row => ({
                tenantId: record.tenantId, storeId: record.storeId, dishId: row.dishId,
                date: record.businessDate, quantity: row.quantity, grossAmount: row.netIncome,
                source: SOURCE, channel: '收银POS日报',
                rawData: json({ importId: record.id, grossAmount: row.grossAmount, netIncome: row.netIncome, variants: row.variants }),
                createdById: req.user.userId,
              })),
            })
          }
          await tx.dailyBusinessImport.update({
            where: { id: record.id },
            data: {
              previewData: json(preview), calculationFingerprint: preview.calculationFingerprint,
              blockingIssues: json(result.blockingIssues), warningIssues: json([
                ...result.warningIssues,
                { code: 'HISTORICAL_BOM_RECALCULATED', message: `按 ${version.dish.name} BOM v${version.versionNo} 完成历史消耗重算` },
              ]),
            },
          })
        }
        await tx.opLog.create({
          data: {
            tenantId: req.user.tenantId, userId: req.user.userId, role: req.user.role,
            action: `历史 BOM 重算 ${rebuilt.length} 个营业日`, target: version.dish.name,
            targetId: version.id, entityType: 'DishBomVersion',
            metadata: { versionNo: version.versionNo, from: dateText(version.effectiveFrom!), to: dateText(end), importIds: imports.map(row => row.id) },
          },
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 })
      return { ok: true, recalculatedImportCount: rebuilt.length, from: version.effectiveFrom, to: end }
    } catch (error: any) {
      req.log.error({ error, versionId: version.id }, 'historical BOM recalculation failed')
      return reply.status(error.statusCode || 500).send({ error: error.message || '历史重算失败，数据未发生部分写入' })
    }
  })

  app.get('/:id', auth, async (req: any, reply: any) => {
    if (!ALLOWED_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权' })
    const row = await prisma.dailyBusinessImport.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } })
    if (!row) return reply.status(404).send({ error: '预览记录不存在' })
    await targetStore(req.user, row.storeId)
    return publicImport(row)
  })

  app.post('/:id/confirm', auth, async (req: any, reply: any) => {
    if (!ALLOWED_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权确认每日营业数据' })
    const record = await prisma.dailyBusinessImport.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } })
    if (!record) return reply.status(404).send({ error: '预览记录不存在' })
    await targetStore(req.user, record.storeId)
    if (record.status === 'CONFIRMED') return reply.send(publicImport(record))
    if (record.status !== 'PREVIEWED') return reply.status(409).send({ error: `当前状态 ${record.status} 不能确认` })
    const parsed = record.parsedData as unknown as ParsedDailyFiles
    const store = await prisma.store.findUniqueOrThrow({ where: { id: record.storeId } })
    const rebuilt = await buildPreview(store, parsed)
    const deferBomIssues = req.body?.deferBomIssues === true
    const partitionedIssues = partitionImportIssues(rebuilt.blockingIssues)
    const storedPreview = record.previewData as unknown as PreviewData
    const storedFingerprint = storedPreview.calculationFingerprint || calculationFingerprint(storedPreview)
    if (partitionedIssues.hard.length > 0 || (partitionedIssues.deferrable.length > 0 && !deferBomIssues)) {
      await prisma.dailyBusinessImport.update({
        where: { id: record.id },
        data: {
          previewData: json(rebuilt.preview),
          calculationFingerprint: rebuilt.preview.calculationFingerprint,
          blockingIssues: json(rebuilt.blockingIssues),
          warningIssues: json(rebuilt.warningIssues),
        },
      })
      return reply.status(409).send({
        error: partitionedIssues.hard.length > 0
          ? `仍有 ${partitionedIssues.hard.length} 项不可暂缓的问题，请修复后重新预览`
          : `仍有 ${partitionedIssues.deferrable.length} 项菜品/BOM待处理，可选择“暂缓并确认”转交总厨`,
        issues: rebuilt.blockingIssues,
        deferrableCount: partitionedIssues.deferrable.length,
      })
    }
    if (storedFingerprint !== rebuilt.preview.calculationFingerprint) {
      const refreshed = await prisma.dailyBusinessImport.update({
        where: { id: record.id },
        data: {
          previewData: json(rebuilt.preview),
          calculationFingerprint: rebuilt.preview.calculationFingerprint,
          blockingIssues: json(rebuilt.blockingIssues),
          warningIssues: json(rebuilt.warningIssues),
        },
      })
      return reply.status(409).send({
        error: 'BOM 或菜品规则在预览后发生变化，系统已刷新扣减结果，请核对后再次确认',
        code: 'PREVIEW_REFRESHED',
        import: publicImport(refreshed),
      })
    }
    const preview = rebuilt.preview
    const now = new Date()
    try {
      await prisma.$transaction(async tx => {
        const locked = await tx.dailyBusinessImport.updateMany({
          where: { id: record.id, status: 'PREVIEWED' },
          data: { status: 'CONFIRMING' },
        })
        if (locked.count !== 1) throw Object.assign(new Error('该预览已被其他操作处理，请刷新'), { statusCode: 409 })
        const previous = await tx.dailyBusinessImport.findMany({
          where: { storeId: record.storeId, businessDate: record.businessDate, status: 'CONFIRMED' },
          select: { id: true },
        })
        const previousIds = previous.map(item => item.id)
        if (previousIds.length > 0) {
          const previousTasks = await tx.deferredBomTask.findMany({
            where: { dailyBusinessImportId: { in: previousIds } }, select: { id: true },
          })
          if (previousTasks.length > 0) {
            await tx.stockConsumption.deleteMany({
              where: { sourceType: BOM_BACKFILL_SOURCE, sourceId: { in: previousTasks.map(item => item.id) } },
            })
            await tx.deferredBomTask.updateMany({
              where: { id: { in: previousTasks.map(item => item.id) } }, data: { status: 'SUPERSEDED' },
            })
          }
          await tx.stockConsumption.deleteMany({
            where: { tenantId: record.tenantId, storeId: record.storeId, sourceType: CONSUMPTION_SOURCE, sourceId: { in: previousIds } },
          })
          await tx.dailyBusinessImport.updateMany({
            where: { id: { in: previousIds } }, data: { status: 'SUPERSEDED', supersededAt: now },
          })
        }
        await tx.dishSale.deleteMany({
          where: { tenantId: record.tenantId, storeId: record.storeId, date: record.businessDate, source: SOURCE },
        })
        await tx.revenueRecord.upsert({
          where: { storeId_date: { storeId: record.storeId, date: record.businessDate } },
          update: {
            amount: preview.metrics.netRevenue,
            source: SOURCE,
            rawData: json({
              importId: record.id, revision: record.revision,
              grossAmount: preview.metrics.grossAmount,
              discountAmount: preview.metrics.discountAmount,
              netRevenue: preview.metrics.netRevenue,
              orders: preview.metrics.orders,
              diners: preview.metrics.diners,
              tables: preview.metrics.tables,
              sourceFiles: { business: record.businessFileName, sales: record.salesFileName },
              posReturns: parsed.returns,
            }),
          },
          create: {
            storeId: record.storeId, date: record.businessDate,
            amount: preview.metrics.netRevenue, source: SOURCE,
            rawData: json({
              importId: record.id, revision: record.revision,
              grossAmount: preview.metrics.grossAmount,
              discountAmount: preview.metrics.discountAmount,
              netRevenue: preview.metrics.netRevenue,
              orders: preview.metrics.orders,
              diners: preview.metrics.diners,
              tables: preview.metrics.tables,
              sourceFiles: { business: record.businessFileName, sales: record.salesFileName },
              posReturns: parsed.returns,
            }),
          },
        })
        if (preview.dishSales.length > 0) {
          await tx.dishSale.createMany({
            data: preview.dishSales.map(row => ({
              tenantId: record.tenantId,
              storeId: record.storeId,
              dishId: row.dishId,
              date: record.businessDate,
              quantity: row.quantity,
              grossAmount: row.netIncome,
              source: SOURCE,
              channel: '收银POS日报',
              rawData: json({ importId: record.id, grossAmount: row.grossAmount, netIncome: row.netIncome, variants: row.variants }),
              createdById: req.user.userId,
            })),
          })
        }
        if (preview.consumptions.length > 0) {
          await tx.stockConsumption.createMany({
            data: preview.consumptions.map(row => ({
              tenantId: record.tenantId,
              storeId: record.storeId,
              productId: row.productId,
              date: record.businessDate,
              quantity: row.quantity,
              note: `每日销量×BOM；${row.sources.join('；')}`.slice(0, 1000),
              sourceType: CONSUMPTION_SOURCE,
              sourceId: record.id,
              sourceLineKey: row.sourceLineKey,
              dishId: row.dishId,
              variantKey: row.variantKey,
              bomVersionId: row.bomVersionId,
              calculationSnapshot: json(row.calculationSnapshot),
              createdById: req.user.userId,
            })),
          })
        }
        if (preview.deferredBomRows.length > 0) {
          await tx.deferredBomTask.createMany({
            data: preview.deferredBomRows.map(row => ({
              tenantId: record.tenantId,
              storeId: record.storeId,
              dailyBusinessImportId: record.id,
              businessDate: record.businessDate,
              rawDishName: row.rawDishName,
              spec: row.spec,
              variantKey: row.variantKey,
              reasonCode: row.reasonCode,
              quantity: row.quantity,
              grossAmount: row.grossAmount,
              netIncome: row.netIncome,
              rawData: json({ variants: row.variants }),
              saleRecorded: row.saleRecorded,
              dishId: row.dishId,
            })),
          })
        }
        const confirmedWarnings = preview.deferredBomRows.length > 0
          ? [...rebuilt.warningIssues, {
              code: 'BOM_DEFERRED',
              message: `${preview.deferredBomRows.length} 个菜品/规格已转交总厨，补齐 BOM 后自动回补本日库存消耗`,
            }]
          : rebuilt.warningIssues
        await tx.dailyBusinessImport.update({
          where: { id: record.id },
          data: {
            status: 'CONFIRMED', confirmedById: req.user.userId, confirmedAt: now,
            previewData: json(preview),
            blockingIssues: json(rebuilt.blockingIssues),
            warningIssues: json(confirmedWarnings),
          },
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 })
      const confirmed = await prisma.dailyBusinessImport.findUniqueOrThrow({ where: { id: record.id } })
      return reply.send(publicImport(confirmed))
    } catch (error: any) {
      req.log.error({ error, importId: record.id }, 'daily import confirmation failed')
      if (error.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      return reply.status(500).send({ error: '确认失败，所有数据均未改动，请重试' })
    }
  })
}
