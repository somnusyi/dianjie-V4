import { FastifyPluginAsync } from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import {
  normalizeDishName,
  normalizeVariantKey,
  parseDailyFiles,
  sha256,
  storeNameMatches,
  type ImportIssue,
  type ParsedDailyFiles,
} from '../services/dailyBusinessImport'

const ALLOWED_ROLES = new Set(['MANAGER', 'KITCHEN_LEAD', 'ADMIN', 'SUPER_ADMIN', 'BOSS'])
const SOURCE = 'daily_pos_upload'
const CONSUMPTION_SOURCE = 'daily_pos'
const MAX_FILE_BYTES = 5 * 1024 * 1024

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
}

type PreviewData = {
  businessDate: string
  metrics: ParsedDailyFiles['business']
  totals: ParsedDailyFiles['totals']
  dishSales: PreviewDishSale[]
  consumptions: PreviewConsumption[]
  returns: ParsedDailyFiles['returns']
  excludedDishes: Array<{ name: string; quantity: number; note: string | null }>
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
      .map(row => ({ productId: row.productId, quantity: row.quantity }))
      .sort((a, b) => a.productId.localeCompare(b.productId)),
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

async function targetStore(user: any, requestedStoreId?: string | null) {
  const isStoreRole = user.role === 'MANAGER' || user.role === 'KITCHEN_LEAD'
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
  const names = [...new Set(parsed.sales.map(row => row.name))]
  const dishes = await prisma.dish.findMany({
    where: { tenantId: store.tenantId },
    include: { recipes: { include: { product: { select: { id: true, code: true, name: true, unit: true } } } } },
  })
  const normalizedDishes = new Map<string, typeof dishes>()
  for (const dish of dishes) {
    const key = normalizeDishName(dish.name)
    normalizedDishes.set(key, [...(normalizedDishes.get(key) || []), dish])
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
  const missingRecipeKeys = new Set<string>()
  for (const row of parsed.sales) {
    const dish = matched.get(row.name)
    if (!dish) continue
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
    const exact = dish.recipes.filter(recipe => recipe.variantKey === variantKey)
    const fallback = dish.recipes.filter(recipe => recipe.variantKey === '')
    const recipes = exact.length > 0 ? exact : fallback
    if (recipes.length === 0) {
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
    for (const recipe of recipes) {
      const quantity = row.quantity * Number(recipe.quantity) * (1 + Number(recipe.lossRate))
      if (quantity <= 0) continue
      const current = consumptionByProduct.get(recipe.productId) || {
        productId: recipe.product.id,
        productCode: recipe.product.code,
        productName: recipe.product.name,
        unit: recipe.product.unit,
        quantity: 0,
        sources: [],
      }
      current.quantity += quantity
      current.sources.push(`${row.name}${row.spec ? `(${row.spec})` : ''} ${row.quantity}份`)
      consumptionByProduct.set(recipe.productId, current)
    }
  }
  if (excludedDishes.length > 0) {
    warningIssues.push({ code: 'INVENTORY_EXCLUDED', message: `${excludedDishes.length} 个品项按已确认规则不扣库存` })
  }
  const businessDate = dateOnly(parsed.business.date)
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

  app.post('/preview', auth, async (req: any, reply: any) => {
    if (!ALLOWED_ROLES.has(req.user.role)) return reply.status(403).send({ error: '无权上传每日营业数据' })
    try {
      const upload = await readMultipart(req)
      const store = await targetStore(req.user, upload.storeId)
      const parsed = await parseDailyFiles(upload.business.buffer, upload.sales.buffer)
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
    const storedPreview = record.previewData as unknown as PreviewData
    const storedFingerprint = storedPreview.calculationFingerprint || calculationFingerprint(storedPreview)
    if (rebuilt.blockingIssues.length > 0) {
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
        error: `仍有 ${rebuilt.blockingIssues.length} 项阻断问题，请修复后重新预览`,
        issues: rebuilt.blockingIssues,
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
              createdById: req.user.userId,
            })),
          })
        }
        await tx.dailyBusinessImport.update({
          where: { id: record.id },
          data: { status: 'CONFIRMED', confirmedById: req.user.userId, confirmedAt: now },
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
