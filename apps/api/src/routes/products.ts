import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '@dianjie/db'
import { cached, invalidatePattern } from '../lib/cache'
import { isStoreScoped, isSupplierRole } from '../lib/auth-scope'
import { requireSupplierCapability, SupplierCapability } from '../lib/supplier-access'
import { parseBoundedInteger, parsePagination } from '../lib/pagination'
import { signOssKey } from './upload'
import { nextDocumentNo } from '../services/documentNo'
import { mergeSupplierCategory } from '../services/supplierCategory'
import { createId } from '@paralleldrive/cuid2'
import { getSupplierReservedStock, stockAvailability } from '../services/supplierStockReservation'
import { createSupplierStockBatchIncrease } from '../services/supplierStockBatch'
import { fireAndForget } from '../services/notify'
import {
  fireAndForgetNotifyProductChange,
  type ProductChangeAction,
} from '../services/notify/productChange'
import {
  isValidProductUnitFactor,
  PRODUCT_UNIT_NAME_MAX_LENGTH,
} from '../services/inventoryUnits'
import crypto from 'crypto'

const auth = (app: any) => ({ preHandler: [app.authenticate] })

export function productCatalogCacheScope(role: string, supplierId?: string | null) {
  if (isSupplierRole(role)) return `supplier:${supplierId || 'unbound'}`
  if (isStoreScoped(role)) return 'store:approved'
  return 'governance:all'
}

// CLAUDE.md 规约：所有写入用 zod 校验
// preprocess: 把 null/空字符串/NaN 统一转成 undefined, 让 .optional().default() 生效.
// 用户报价 Excel 里数字列经常出现 "—"/"无"/空格, 前端 Number() 转 NaN, JSON 序列化为 null.
// 不加这层 zod 直接 reject "Expected number, received null".
const PRODUCT_DECIMAL_MAX = 99_999_999.99
const PRODUCT_UNIT_FACTOR_API_MAX = 1_000_000_000
const FOUR_UNIT_FIELDS = [
  'purchaseUnit',
  'inventoryUnit',
  'orderUnit',
  'costUnit',
  'inventoryUnitsPerPurchaseUnit',
  'inventoryUnitsPerOrderUnit',
  'inventoryUnitsPerCostUnit',
] as const

const productUnitNameSchema = (label: string) => z.string().trim().min(1, `${label}不能为空`)
  .max(PRODUCT_UNIT_NAME_MAX_LENGTH, `${label}不能超过 ${PRODUCT_UNIT_NAME_MAX_LENGTH} 个字符`)
  .refine(value => !/^\d/.test(value), `${label}不能以数字开头`)

const productUnitFactorSchema = (label: string) => z.number()
  .positive(`${label}必须大于 0`)
  .max(PRODUCT_UNIT_FACTOR_API_MAX, `${label}超过商品单位换算上限`)
  .refine(isValidProductUnitFactor, `${label}最多支持 6 位小数`)

const numNullable = (def: number) =>
  z.preprocess(v => (v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) ? undefined : v,
               z.number().nonnegative().max(PRODUCT_DECIMAL_MAX, '数值超过商品字段上限').optional().default(def))

const productCreateSchema = z.object({
  // code 可选: 上传时若缺失, 后端用 "<supplierId 前缀>-<五位序号>" 自动生成
  code:      z.string().trim().max(40).optional(),
  name:      z.string().trim().min(1, '品项名称必填').max(80),
  spec:      z.string().trim().max(80).optional().nullable(),
  category:  z.string().trim().max(40).optional(),
  imageKey:  z.string().trim().max(500).optional().nullable(),
  // unit 必须是干净计量单位 (kg/件/瓶...), 不能含数字 ("5kg" / "2包起订" 是数据脏的常见来源)
  unit:      z.string().trim().max(PRODUCT_UNIT_NAME_MAX_LENGTH)
                .refine(v => !/^\d/.test(v), { message: '单位不能以数字开头, 数字应记到 spec / 起订量字段' })
                .optional().default('件'),
  purchaseUnit: productUnitNameSchema('采购单位').optional(),
  inventoryUnit: productUnitNameSchema('库存基础单位').optional(),
  orderUnit: productUnitNameSchema('订货单位').optional(),
  costUnit: productUnitNameSchema('成本单位').optional(),
  inventoryUnitsPerPurchaseUnit: productUnitFactorSchema('每采购单位库存数量').optional(),
  inventoryUnitsPerOrderUnit: productUnitFactorSchema('每订货单位库存数量').optional(),
  inventoryUnitsPerCostUnit: productUnitFactorSchema('每成本单位库存数量').optional(),
  unitConversionStatus: z.enum(['PENDING', 'INFERRED', 'VERIFIED']).optional(),
  unitConversionNote: z.string().trim().max(500).optional().nullable(),
  // 价格可选, 缺省 0. 仓库库存初始化场景常常没价格 (供应商内部物品), 先建 SKU 后续单条改价
  price:     z.preprocess(v => (v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) ? 0 : v,
                          z.number().nonnegative('金额不能为负').max(PRODUCT_DECIMAL_MAX, '金额超过商品字段上限').optional().default(0)),
  stock:     numNullable(0),
  minStock:  numNullable(0),
  // 起订量 (默认 1, 最小 0.01)
  minOrderQty: z.preprocess(v => (v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) ? undefined : v,
                            z.number().positive('起订量必须大于 0').max(PRODUCT_DECIMAL_MAX, '起订量超过商品字段上限').optional().default(1)),
  // 订量步长 (默认 1, 0/缺省视作 1)
  stepQty:   z.preprocess(v => (v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v)) || v === 0) ? undefined : v,
                          z.number().positive('步长必须大于 0').max(PRODUCT_DECIMAL_MAX, '步长超过商品字段上限').optional().default(1)),
  shelfDays: z.preprocess(v => (v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) ? undefined : v,
                          z.number().int().min(0).max(3650).optional().default(7)),
  supplierId: z.string().optional(),
  status:    z.enum(['PENDING_APPROVAL', 'PENDING_DISABLE', 'ENABLED', 'DISABLED']).optional(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.inventoryUnit) !== Boolean(value.inventoryUnitsPerPurchaseUnit)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['inventoryUnit'],
      message: '库存基础单位与每采购单位换算数量必须同时填写',
    })
  }
})

export const productListFilterSchema = z.object({
  category: z.string().trim().max(40).optional(),
  categoryId: z.string().trim().optional(),
  supplierId: z.string().trim().min(1).max(64).optional(),
  status: z.preprocess(
    value => value === '' ? undefined : value,
    z.enum(['PENDING_APPROVAL', 'PENDING_DISABLE', 'ENABLED', 'DISABLED']).optional(),
  ),
  q: z.string().trim().max(80).optional(),
}).passthrough()

const productPatchSchema = z.object({
  code: z.string().trim().min(1).max(40).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  spec: z.string().trim().max(80).nullable().optional(),
  category: z.string().trim().min(1).max(40).optional(),
  imageKey: z.string().trim().max(500).nullable().optional(),
  unit: z.string().trim().min(1).max(PRODUCT_UNIT_NAME_MAX_LENGTH)
    .refine(value => !/^\d/.test(value), '单位不能以数字开头').optional(),
  purchaseUnit: productUnitNameSchema('采购单位').optional(),
  inventoryUnit: productUnitNameSchema('库存基础单位').nullable().optional(),
  orderUnit: productUnitNameSchema('订货单位').optional(),
  costUnit: productUnitNameSchema('成本单位').optional(),
  inventoryUnitsPerPurchaseUnit: productUnitFactorSchema('每采购单位库存数量').nullable().optional(),
  inventoryUnitsPerOrderUnit: productUnitFactorSchema('每订货单位库存数量').optional(),
  inventoryUnitsPerCostUnit: productUnitFactorSchema('每成本单位库存数量').optional(),
  unitConversionStatus: z.enum(['PENDING', 'INFERRED', 'VERIFIED']).optional(),
  unitConversionNote: z.string().trim().max(500).nullable().optional(),
  price: z.number().nonnegative().max(PRODUCT_DECIMAL_MAX).optional(),
  minOrderQty: z.number().positive().max(PRODUCT_DECIMAL_MAX).optional(),
  stepQty: z.number().positive().max(PRODUCT_DECIMAL_MAX).optional(),
  shelfDays: z.number().int().min(0).max(3650).optional(),
  status: z.enum(['PENDING_APPROVAL', 'PENDING_DISABLE', 'ENABLED', 'DISABLED']).optional(),
  shipUpperPct: z.number().min(1).max(10).optional(),
  shipUpperBuffer: z.number().min(0).max(10_000).optional(),
}).strict()

/** 自动生成商品 code: 供应商短码 + 随机短 ID，避免同毫秒批量导入互撞。 */
function autoCode(supplierId: string | undefined): string {
  const sup = supplierId ? supplierId.slice(-4).toUpperCase() : 'TEN0'
  return `${sup}-${createId().slice(-10).toUpperCase()}`
}

function jsonSafe(value: unknown): any {
  return JSON.parse(JSON.stringify(value))
}

function hashEventPayload(payload: unknown): string {
  const serialized = JSON.stringify(payload)
  return crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16)
}

function buildProductChangeSummary(record: any, fields: string[]): Record<string, any> {
  const summary: Record<string, any> = { name: record?.name }
  for (const field of fields) {
    if (record && Object.prototype.hasOwnProperty.call(record, field)) {
      const value = record[field]
      summary[field] = typeof value === 'object' && value !== null && 'toJSON' in value
        ? Number(value)
        : value
    }
  }
  return summary
}

function productFieldEquals(current: unknown, requested: unknown): boolean {
  if (current === requested) return true
  if (current == null || requested == null) return current == null && requested == null
  if (current instanceof Date || requested instanceof Date) {
    const currentTime = current instanceof Date ? current.getTime() : new Date(String(current)).getTime()
    const requestedTime = requested instanceof Date ? requested.getTime() : new Date(String(requested)).getTime()
    return Number.isFinite(currentTime) && currentTime === requestedTime
  }
  if (typeof current === 'object' && current !== null && 'toString' in current) {
    return String(current) === String(requested)
  }
  return false
}

function fourUnitIdentityError(record: Record<string, any>): string | null {
  const roles: Array<[string, unknown]> = [
    [String(record.purchaseUnit || '').trim(), record.inventoryUnitsPerPurchaseUnit],
    [String(record.inventoryUnit || '').trim(), record.inventoryUnit ? 1 : null],
    [String(record.orderUnit || '').trim(), record.inventoryUnitsPerOrderUnit],
    [String(record.costUnit || '').trim(), record.inventoryUnitsPerCostUnit],
  ]
  const factorByUnit = new Map<string, number>()
  for (const [unit, rawFactor] of roles) {
    if (!unit || rawFactor == null) continue
    const factor = Number(rawFactor)
    if (!Number.isFinite(factor)) continue
    const existing = factorByUnit.get(unit)
    if (existing !== undefined && existing !== factor) {
      return `同名单位「${unit}」必须使用相同的库存换算因子`
    }
    factorByUnit.set(unit, factor)
  }
  return null
}

function resolveProductChangeAction(data: any): ProductChangeAction {
  if (data.status === 'DISABLED') return 'DISABLE'
  if (data.status === 'ENABLED') return 'ENABLE'
  if (data.price != null) return 'PRICE_CHANGE'
  return 'UPDATE'
}

const categoryNameSchema = z.string().trim().min(1, '分类名称必填').max(40)

function supplierScopeOrReply(req: any, reply: any, capability: SupplierCapability): string | null {
  const { role, supplierId } = req.user
  try {
    return requireSupplierCapability(role, supplierId, capability)
  } catch (error: any) {
    reply.status(error?.statusCode || 403).send({ error: error?.message || '无权限' })
    return null
  }
}

async function lockActiveSupplierCategory(
  tx: any,
  tenantId: string,
  supplierId: string,
  categoryName: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier-categories:${tenantId}:${supplierId}`}))`
  const category = await tx.supplierProductCategory.findUnique({
    where: { tenantId_supplierId_name: { tenantId, supplierId, name: categoryName } },
    select: { isActive: true },
  })
  if (!category?.isActive) {
    throw Object.assign(new Error('商品分类状态已变化，请刷新后重试'), { statusCode: 409 })
  }
}

export async function buildProductListWhere(req: any): Promise<{ where?: any; filters?: any; error?: { statusCode: number; message: string } }> {
  const parsedFilters = productListFilterSchema.safeParse(req.query || {})
  if (!parsedFilters.success) {
    return { error: { statusCode: 400, message: parsedFilters.error.issues[0].message } }
  }
  const { category, categoryId, supplierId: requestedSupplierId, status, q } = parsedFilters.data as any
  const { tenantId, role, supplierId } = req.user
  const where: any = { tenantId }
  if (status) where.status = status
  if (requestedSupplierId && !isSupplierRole(role) && !isStoreScoped(role)) {
    where.supplierId = requestedSupplierId
  }

  // categoryId 显式解析为分类名；未找到则报错，不能静默忽略
  if (categoryId) {
    const categoryWhere: any = { id: categoryId, tenantId }
    if (isSupplierRole(role) && supplierId) categoryWhere.supplierId = supplierId
    const categoryRecord = await prisma.supplierProductCategory.findFirst({ where: categoryWhere })
    if (!categoryRecord) return { error: { statusCode: 400, message: '商品分类不存在' } }
    where.category = categoryRecord.name
  } else if (category) {
    where.category = category
  }

  const tokens = parseProductQueryTokens(q)
  const keywordWhere = buildProductKeywordWhere(tokens)
  if (keywordWhere) where.AND = [keywordWhere]

  // 供应商账号只能看自己的商品
  if (isSupplierRole(role)) {
    try {
      requireSupplierCapability(role, supplierId, 'catalog.read')
    } catch (error: any) {
      return { error: { statusCode: error?.statusCode || 403, message: error?.message || '无权限' } }
    }
    if (!supplierId) return { error: { statusCode: 403, message: '账号未绑定供应商' } }
    where.supplierId = supplierId
  } else if (isStoreScoped(role)) {
    // Approved offers are tenant-wide for every store. Pending/disabled
    // supplier catalog data is governance-only and must not leak to stores.
    where.status = 'ENABLED'
  }
  return { where, filters: parsedFilters.data }
}

export function escapeCsv(value: unknown): string {
  const str = value == null ? '' : String(value)
  // RFC 4180: quote fields containing comma, quote, or line break
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

/** 前缀匹配 CSV/Excel 公式注入风险字符（= + - @、tab、CR/LF）或前导空白后的危险字符。 */
const CSV_FORMULA_PREFIX_RE = /^[\s]*[\t\r\n=+\-@]/

/** 在 RFC4180 转义前对文本单元格做公式注入防护；Excel 中前导单引号会强制按文本显示。 */
export function sanitizeCsvCell(value: unknown): string {
  let str = value == null ? '' : String(value)
  if (CSV_FORMULA_PREFIX_RE.test(str)) str = "'" + str
  return escapeCsv(str)
}

/** 商品 PC 页搜索框：空格分词，每个 token 命中名称/规格/编码，全部 token 必须命中。 */
export function parseProductQueryTokens(q: string | undefined | null): string[] {
  return (q || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
}

export function buildProductKeywordWhere(tokens: string[]): { OR: any[] } | { AND: any[] } | undefined {
  if (tokens.length === 0) return undefined
  const tokenClause = (token: string) => ({
    OR: [
      { name: { contains: token, mode: 'insensitive' } },
      { code: { contains: token, mode: 'insensitive' } },
      { spec: { contains: token, mode: 'insensitive' } },
    ],
  })
  if (tokens.length === 1) return tokenClause(tokens[0])
  return { AND: tokens.map(tokenClause) }
}

/** 允许导出商品报价表的角色 allowlist。 */
const PRODUCT_EXPORT_ROLES = new Set(['SUPPLY_CHAIN', 'SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'SUPPLIER_SUB'])
export function canExportProductCatalog(role: string | undefined | null): boolean {
  return !!role && PRODUCT_EXPORT_ROLES.has(role)
}

/** 单次导出的硬上限；超过后必须提示用户缩小筛选范围。 */
export const PRODUCT_EXPORT_MAX_ROWS = 10_000

export function formatProductStatus(status: string): string {
  const map: Record<string, string> = {
    ENABLED: '供应中',
    DISABLED: '已停售',
    PENDING_APPROVAL: '上架待审',
    PENDING_DISABLE: '停售待审',
  }
  return map[status] || status
}

export function productExportFilename(date = new Date()): string {
  const china = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
  return `商品报价表_${china.replace(/\//g, '-')}.csv`
}

export type ExportableProduct = {
  code: string
  name: string
  category: string | null
  spec: string | null
  unit: string | null
  inventoryUnit: string | null
  price: number | string | unknown
  status: string
}

export function buildProductExportCsv(rows: ExportableProduct[]): string {
  const headers = ['商品编码', '名称', '分类', '规格', '采购单位', '库存单位', '采购价', '状态']
  const lines = [
    headers.map(escapeCsv).join(','),
    ...rows.map(row => [
      row.code,
      row.name,
      row.category || '',
      row.spec || '',
      row.unit || '',
      row.inventoryUnit || row.unit || '',
      Number(row.price).toFixed(2),
      formatProductStatus(row.status),
    ].map(sanitizeCsvCell).join(',')),
  ]
  return lines.join('\r\n')
}

export const productRoutes: FastifyPluginAsync = async (app) => {
  async function withAvailability<T extends { id: string; stock: unknown }>(tenantId: string, rows: T[]) {
    const reserved = await getSupplierReservedStock({ tenantId, productIds: rows.map(row => row.id) })
    return rows.map(product => ({
      ...product,
      ...stockAvailability(Number(product.stock || 0), reserved.get(product.id) || 0),
      imageUrl: signOssKey((product as any).imageKey),
    }))
  }

  app.get('/', auth(app), async (req: any, reply: any) => {
    const listResult = await buildProductListWhere(req)
    if (listResult.error) return reply.status(listResult.error.statusCode).send({ error: listResult.error.message })
    const { where, filters } = listResult
    const { category, q, page, pageSize = '20' } = filters as any
    const { tenantId, role, supplierId } = req.user

    // 不传 page 时返回全量（兼容下拉框），缓存 10 分钟
    // 注意 cache key 加上 supplier scope，避免供应商之间互相污染
    //
    // 设计决策 (2026-05-28): API 返回所有 status (含 DISABLED), 让前端透明展示「已停售」
    // 而不是把 DISABLED 商品悄悄藏掉. chef 下单选品页负责显示 chip + 禁用加入按钮,
    // orders.ts:298 做 server-side 兜底拦截.
    if (!page && !q) {
      const scopeKey = productCatalogCacheScope(role, supplierId)
      const effectiveStatus = typeof where.status === 'string' ? where.status : 'all'
      const rows = await cached(`products:full:${tenantId}:${scopeKey}:${category || 'all'}:${effectiveStatus}`, 600, () =>
        prisma.product.findMany({
          where,
          include: { supplier: { select: { id: true, name: true } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      )
      return withAvailability(tenantId, rows as any[])
    }
    if (!page) {
      const rows = await prisma.product.findMany({
        where,
        include: { supplier: { select: { id: true, name: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      return withAvailability(tenantId, rows)
    }
    const pagination = parsePagination({ page, pageSize }, { defaultPageSize: 20, maxPageSize: 100 })
    if (!pagination) return reply.status(400).send({ error: '分页参数格式不正确' })
    const { page: p, pageSize: ps } = pagination
    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: { supplier: { select: { id: true, name: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (p - 1) * ps,
        take: ps,
      }),
      prisma.product.count({ where }),
    ])
    return {
      items: await withAvailability(tenantId, items),
      total, page: p, pageSize: ps,
    }
  })

  app.get('/export.csv', auth(app), async (req: any, reply: any) => {
    if (!canExportProductCatalog(req.user.role)) {
      return reply.status(403).send({ error: '当前角色无权导出商品报价表' })
    }
    const exportResult = await buildProductListWhere(req)
    if (exportResult.error) return reply.status(exportResult.error.statusCode).send({ error: exportResult.error.message })

    const cappedRows = await prisma.product.findMany({
      where: exportResult.where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PRODUCT_EXPORT_MAX_ROWS + 1,
      select: {
        code: true, name: true, category: true, spec: true,
        unit: true, inventoryUnit: true, price: true, status: true,
      },
    })
    if (cappedRows.length > PRODUCT_EXPORT_MAX_ROWS) {
      return reply.status(400).send({ error: `导出结果超过 ${PRODUCT_EXPORT_MAX_ROWS} 行上限，请缩小筛选范围后重试` })
    }

    const csv = buildProductExportCsv(cappedRows as ExportableProduct[])
    const filename = productExportFilename()
    return reply
      .status(200)
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .send(Buffer.from('\uFEFF' + csv, 'utf-8'))
  })

  // 建/改商品仅限总部管理员
  // 集团方写权限 + 供应商所有角色都可改/建自己 SKU
  const PRODUCT_WRITE_ROLES = new Set([
    'ADMIN', 'SUPER_ADMIN', 'PURCHASER',
    'SUPPLY_CHAIN', // 内部供应链直接维护商品
    'SUPPLIER_OWNER', 'SUPPLIER_STAFF', 'SUPPLIER_SUB',
  ])
  const UNIT_GOVERNANCE_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'SUPPLY_CHAIN'])

  /** 当前租户/供应商实际使用的分类主数据，供筛选和下拉选择。 */
  app.get('/categories', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    const where: any = { tenantId }
    let categorySupplierId: string | null = null
    if (isSupplierRole(role)) {
      const scopedSupplierId = supplierScopeOrReply(req, reply, 'catalog.read')
      if (!scopedSupplierId) return
      where.supplierId = scopedSupplierId
      categorySupplierId = scopedSupplierId
    } else if (role === 'SUPPLY_CHAIN' && req.query?.supplierId !== undefined) {
      const parsedSupplierId = z.string().trim().min(1).max(64).safeParse(req.query.supplierId)
      if (!parsedSupplierId.success) return reply.status(400).send({ error: '供应商筛选无效' })
      const supplier = await prisma.supplier.findFirst({
        where: { id: parsedSupplierId.data, tenantId },
        select: { id: true },
      })
      if (!supplier) return reply.status(404).send({ error: '供应商不存在' })
      categorySupplierId = supplier.id
      where.supplierId = supplier.id
    } else if (isStoreScoped(role)) {
      where.status = 'ENABLED'
    }
    const rows = await prisma.product.groupBy({
      by: ['category'],
      where,
      _count: { _all: true },
      orderBy: { category: 'asc' },
    })
    if (!categorySupplierId) {
      return rows.map(row => ({ name: row.category || '其他', count: row._count._all }))
    }

    const masters = await prisma.supplierProductCategory.findMany({
      where: { tenantId, supplierId: categorySupplierId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
    const counts = new Map(rows.map(row => [row.category || '其他', row._count._all]))
    const result = masters.map(category => ({
      id: category.id,
      name: category.name,
      count: counts.get(category.name) || 0,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      isSystem: category.isSystem,
    }))
    // 兼容尚未执行迁移、或历史脏数据形成的孤立分类；管理页可见但不丢数据。
    for (const row of rows) {
      const name = row.category || '其他'
      if (!masters.some(category => category.name === name)) {
        result.push({
          id: null as any, name, count: row._count._all,
          sortOrder: result.length, isActive: true, isSystem: name === '其他',
        })
      }
    }
    return result
  })

  /** 新增供应商商品/库存分类。 */
  app.post('/categories', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId, supplierId } = req.user
    const scopedSupplierId = supplierScopeOrReply(req, reply, 'catalog.manage')
    if (!scopedSupplierId) return
    const parsed = z.object({ name: categoryNameSchema }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    let category: any
    try {
      category = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier-categories:${tenantId}:${scopedSupplierId}`}))`
        const duplicate = await tx.supplierProductCategory.findUnique({
          where: { tenantId_supplierId_name: { tenantId, supplierId: scopedSupplierId, name: parsed.data.name } },
        })
        if (duplicate) throw Object.assign(new Error('分类名称已存在'), { statusCode: 409 })
        const max = await tx.supplierProductCategory.aggregate({
          where: { tenantId, supplierId: scopedSupplierId }, _max: { sortOrder: true },
        })
        const created = await tx.supplierProductCategory.create({
          data: {
            tenantId, supplierId: scopedSupplierId, name: parsed.data.name,
            sortOrder: (max._max.sortOrder ?? -1) + 1,
            isSystem: parsed.data.name === '其他',
          },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId, role,
            action: `新增商品分类「${created.name}」`,
            entityType: 'ProductCategory', target: created.name, targetId: created.id,
            metadata: { supplierId: scopedSupplierId, after: { name: created.name, sortOrder: created.sortOrder, isActive: true } },
          },
        })
        return created
      })
    } catch (error: any) {
      if (error?.code === 'P2002' || error?.statusCode === 409) {
        return reply.status(409).send({ error: '分类名称已存在' })
      }
      throw error
    }
    return reply.status(201).send({ ...category, count: 0 })
  })

  /** 改名、停用或恢复分类。改名会同步更新该分类下全部商品，库存自动联动。 */
  app.patch('/categories/:id', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId, supplierId } = req.user
    const scopedSupplierId = supplierScopeOrReply(req, reply, 'catalog.manage')
    if (!scopedSupplierId) return
    const parsed = z.object({
      name: categoryNameSchema.optional(),
      isActive: z.boolean().optional(),
    }).refine(value => value.name !== undefined || value.isActive !== undefined, '没有需要修改的字段').safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    let result: { id: string; name: string; isActive: boolean; productCount: number }
    try {
      result = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier-categories:${tenantId}:${scopedSupplierId}`}))`
        const current = await tx.supplierProductCategory.findFirst({
          where: { id: req.params.id, tenantId, supplierId: scopedSupplierId },
        })
        if (!current) throw Object.assign(new Error('分类不存在'), { statusCode: 404 })
        if (current.isSystem && parsed.data.name && parsed.data.name !== current.name) {
          throw Object.assign(new Error('系统兜底分类不能改名'), { statusCode: 400 })
        }
        if (current.isSystem && parsed.data.isActive === false) {
          throw Object.assign(new Error('系统兜底分类不能停用'), { statusCode: 400 })
        }
        const nextName = parsed.data.name || current.name
        const nextActive = parsed.data.isActive ?? current.isActive
        if (nextName !== current.name) {
          const duplicate = await tx.supplierProductCategory.findUnique({
            where: { tenantId_supplierId_name: { tenantId, supplierId: scopedSupplierId, name: nextName } },
          })
          if (duplicate) throw Object.assign(new Error('分类名称已存在'), { statusCode: 409 })
        }
        const updatedProducts = nextName === current.name
          ? { count: 0 }
          : await tx.product.updateMany({
              where: { tenantId, supplierId: scopedSupplierId, category: current.name },
              data: { category: nextName },
            })
        await tx.supplierProductCategory.update({
          where: { id: current.id },
          data: { name: nextName, isActive: nextActive },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId, role,
            action: nextName !== current.name
              ? `商品分类改名「${current.name}」→「${nextName}」，同步 ${updatedProducts.count} 个 SKU`
              : `${nextActive ? '恢复' : '停用'}商品分类「${current.name}」`,
            entityType: 'ProductCategory', target: nextName, targetId: current.id,
            metadata: {
              supplierId: scopedSupplierId,
              before: { name: current.name, isActive: current.isActive },
              after: { name: nextName, isActive: nextActive },
              productCount: updatedProducts.count,
            },
          },
        })
        return { id: current.id, name: nextName, isActive: nextActive, productCount: updatedProducts.count }
      })
    } catch (error: any) {
      if (error?.code === 'P2002') return reply.status(409).send({ error: '分类名称已存在' })
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
    void invalidatePattern(`products:full:${tenantId}:*`)
    return { ok: true, ...result }
  })

  /**
   * 合并分类：将来源分类中的全部商品移动到目标分类，并停用来源分类。
   * 使用供应商级事务锁，避免改名、合并和批量归类并发时产生孤立分类。
   */
  app.post('/categories/:id/merge', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId } = req.user
    const scopedSupplierId = supplierScopeOrReply(req, reply, 'catalog.manage')
    if (!scopedSupplierId) return
    const parsed = z.object({ targetId: z.string().trim().min(1) }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const sourceId = String(req.params.id)
    try {
      const result = await mergeSupplierCategory({
        tenantId,
        supplierId: scopedSupplierId,
        userId,
        role,
        sourceId,
        targetId: parsed.data.targetId,
      })
      void invalidatePattern(`products:full:${tenantId}:*`)
      return {
        ok: true,
        source: { id: result.source.id, name: result.source.name, isActive: false },
        target: { id: result.target.id, name: result.target.name },
        productCount: result.productCount,
      }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
  })

  /** 保存分类顺序；必须一次提交当前供应商全部分类，防止越权/遗漏。 */
  app.patch('/categories-order', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId, supplierId } = req.user
    const scopedSupplierId = supplierScopeOrReply(req, reply, 'catalog.manage')
    if (!scopedSupplierId) return
    const parsed = z.object({ ids: z.array(z.string()).min(1).max(200) }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const ids = [...new Set(parsed.data.ids)]
    try {
      await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier-categories:${tenantId}:${scopedSupplierId}`}))`
        const existing = await tx.supplierProductCategory.findMany({
          where: { tenantId, supplierId: scopedSupplierId }, select: { id: true },
        })
        if (ids.length !== existing.length || existing.some(row => !ids.includes(row.id))) {
          throw Object.assign(new Error('分类顺序必须包含当前全部分类'), { statusCode: 400 })
        }
        for (let i = 0; i < ids.length; i++) {
          const updated = await tx.supplierProductCategory.updateMany({
            where: { id: ids[i], tenantId, supplierId: scopedSupplierId }, data: { sortOrder: i },
          })
          if (updated.count !== 1) {
            throw Object.assign(new Error('分类状态已变化，请刷新后重试'), { statusCode: 409 })
          }
        }
        await tx.opLog.create({
          data: {
            tenantId, userId, role,
            action: `调整商品分类顺序：${ids.length} 类`,
            entityType: 'ProductCategory', targetId: scopedSupplierId,
            metadata: { supplierId: scopedSupplierId, categoryIds: ids },
          },
        })
      })
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      throw error
    }
    return { ok: true, count: ids.length }
  })

  /** 商品关键操作记录；供应商只能查看自家商品相关日志。 */
  app.get('/history', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    const limit = parseBoundedInteger((req.query as any)?.limit, { defaultValue: 50, max: 200 })
    if (limit === null) return reply.status(400).send({ error: 'limit 必须是 1 至 200 的整数' })
    let productIds: string[] | undefined
    if (isSupplierRole(role)) {
      if (!supplierScopeOrReply(req, reply, 'catalog.read')) return
      if (!supplierId) return reply.status(403).send({ error: '账号未绑定供应商' })
      productIds = (await prisma.product.findMany({
        where: { tenantId, supplierId }, select: { id: true },
      })).map(product => product.id)
    }
    const rows = await prisma.opLog.findMany({
      where: {
        tenantId,
        entityType: { in: ['Product', 'ProductBatch', 'ProductCategory'] },
        ...(productIds ? {
          OR: [
            { targetId: { in: productIds } },
            { metadata: { path: ['supplierId'], equals: supplierId } },
          ],
        } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: { user: { select: { name: true } } },
    })
    return rows.map(row => ({
      id: row.id,
      action: row.action,
      target: row.target,
      targetId: row.targetId,
      entityType: row.entityType,
      metadata: row.metadata,
      operator: row.user?.name || '系统',
      createdAt: row.createdAt,
    }))
  })

  const bulkIdsSchema = z.object({
    ids: z.array(z.string()).min(1).max(200),
  })

  app.post('/batch-status/preview', auth(app), async (req: any, reply: any) => {
    const { role, tenantId, supplierId } = req.user
    if (!PRODUCT_WRITE_ROLES.has(role)) return reply.status(403).send({ error: '无权预览批量商品操作' })
    const parsed = bulkIdsSchema.extend({ status: z.enum(['ENABLED', 'DISABLED']) }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const uniqueIds = [...new Set(parsed.data.ids)]
    const where: any = { id: { in: uniqueIds }, tenantId }
    if (isSupplierRole(role)) {
      if (!supplierScopeOrReply(req, reply, 'catalog.manage')) return
      where.supplierId = supplierId
    }
    const products = await prisma.product.findMany({
      where,
      select: { id: true, name: true, status: true, stock: true, price: true },
      orderBy: { name: 'asc' },
    })
    if (products.length !== uniqueIds.length) {
      return reply.status(400).send({ error: '包含不存在或无权限的商品' })
    }
    const [reservations, recentOrderLines] = await Promise.all([
      prisma.supplierStockReservation.groupBy({
        by: ['productId'],
        where: { tenantId, productId: { in: uniqueIds }, status: 'ACTIVE' },
        _sum: { quantity: true },
      }),
      prisma.purchaseOrderItem.findMany({
        where: {
          productId: { in: uniqueIds },
          isActive: true,
          purchaseOrder: {
            tenantId,
            createdAt: { gte: new Date(Date.now() - 28 * 86_400_000) },
            status: { not: 'CANCELLED' },
          },
        },
        select: { purchaseOrderId: true, productId: true },
      }),
    ])
    const reservedByProduct = new Map(reservations.map(row => [row.productId, Number(row._sum.quantity || 0)]))
    const activeReservations = [...reservedByProduct.values()].reduce((sum, quantity) => sum + quantity, 0)
    const physicalStockValue = products.reduce((sum, product) => sum + Number(product.stock) * Number(product.price), 0)
    const impacted = products.filter(product =>
      parsed.data.status === 'DISABLED' ? product.status === 'ENABLED' : product.status === 'DISABLED'
    )
    return {
      requested: products.length,
      impacted: impacted.length,
      alreadyInTargetStatus: products.length - impacted.length,
      activeReservationSku: reservations.length,
      activeReservationQty: Number(activeReservations.toFixed(3)),
      recent28DayOrders: new Set(recentOrderLines.map(line => line.purchaseOrderId)).size,
      recent28DayOrderLines: recentOrderLines.length,
      physicalStockValue: Number(physicalStockValue.toFixed(2)),
      sample: impacted.slice(0, 10).map(product => ({
        id: product.id,
        name: product.name,
        stock: Number(product.stock),
        reserved: reservedByProduct.get(product.id) || 0,
      })),
    }
  })

  app.patch('/batch-category', auth(app), async (req: any, reply: any) => {
    const { role, tenantId, userId, supplierId } = req.user
    if (!PRODUCT_WRITE_ROLES.has(role)) return reply.status(403).send({ error: '无权批量修改商品' })
    const parsed = bulkIdsSchema.extend({ category: z.string().trim().min(1).max(40) }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const uniqueIds = [...new Set(parsed.data.ids)]
    const where: any = { id: { in: uniqueIds }, tenantId }
    if (isSupplierRole(role)) {
      if (!supplierScopeOrReply(req, reply, 'catalog.manage')) return
      if (!supplierId) return reply.status(403).send({ error: '账号未绑定供应商' })
      where.supplierId = supplierId
      const category = await prisma.supplierProductCategory.findUnique({
        where: { tenantId_supplierId_name: { tenantId, supplierId, name: parsed.data.category } },
      })
      if (!category?.isActive) return reply.status(400).send({ error: '请选择一个启用中的分类' })
    }
    const matched = await prisma.product.findMany({
      where,
      select: { id: true, category: true, code: true, name: true, supplierId: true },
    })
    if (matched.length !== uniqueIds.length) return reply.status(400).send({ error: '包含不存在或无权限的商品' })

    if (role === 'SUPPLY_CHAIN') {
      const supplierIds = [...new Set(matched.map(item => item.supplierId).filter((id): id is string => Boolean(id)))].sort()
      if (supplierIds.length !== new Set(matched.map(item => item.supplierId)).size) {
        return reply.status(400).send({ error: '所选商品包含未绑定供应商的商品，无法校验分类归属' })
      }
      const activeCategories = await prisma.supplierProductCategory.findMany({
        where: {
          tenantId,
          supplierId: { in: supplierIds },
          name: parsed.data.category,
          isActive: true,
        },
        select: { supplierId: true },
      })
      if (new Set(activeCategories.map(category => category.supplierId)).size !== supplierIds.length) {
        return reply.status(400).send({ error: `分类「${parsed.data.category}」必须在每个商品所属供应商下启用` })
      }

      const changed = matched.filter(item => item.category !== parsed.data.category)
      if (changed.length === 0) {
        return { ok: true, count: 0, category: parsed.data.category, message: '商品已是目标分类' }
      }
      await prisma.$transaction(async tx => {
        for (const scopedSupplierId of supplierIds) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier-categories:${tenantId}:${scopedSupplierId}`}))`
        }
        const lockedCategories = await tx.supplierProductCategory.findMany({
          where: {
            tenantId,
            supplierId: { in: supplierIds },
            name: parsed.data.category,
            isActive: true,
          },
          select: { supplierId: true },
        })
        if (new Set(lockedCategories.map((category: any) => category.supplierId)).size !== supplierIds.length) {
          throw Object.assign(new Error('商品分类状态已变化，请刷新后重试'), { statusCode: 409 })
        }
        for (const item of changed) {
          const updated = await tx.product.updateMany({
            where: {
              id: item.id,
              tenantId,
              supplierId: item.supplierId,
              category: item.category,
            },
            data: { category: parsed.data.category },
          })
          if (updated.count !== 1) {
            throw Object.assign(new Error('商品状态已变化，请刷新后重试'), { statusCode: 409 })
          }
          await tx.opLog.create({
            data: {
              tenantId, userId, role,
              action: `批量修改商品分类 ${item.name} (#${item.code})：${item.category} → ${parsed.data.category}`,
              entityType: 'Product', target: item.code, targetId: item.id,
              metadata: {
                supplierId: item.supplierId,
                fields: ['category'],
                before: { name: item.name, category: item.category },
                after: { name: item.name, category: parsed.data.category },
              },
            },
          })
        }
      })
      void invalidatePattern(`products:full:${tenantId}:*`)
      for (const item of changed) {
        const before = { name: item.name, category: item.category }
        const after = { name: item.name, category: parsed.data.category }
        fireAndForgetNotifyProductChange({
          tenantId,
          productId: item.id,
          action: 'UPDATE',
          operatorId: userId,
          eventKey: `PRODUCT:${item.id}:UPDATE:${userId}:${hashEventPayload({ before, after })}`,
          before,
          after,
        })
      }
      return { ok: true, count: changed.length, category: parsed.data.category }
    }

    await prisma.$transaction(async tx => {
      if (isSupplierRole(role)) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier-categories:${tenantId}:${supplierId}`}))`
        const category = await tx.supplierProductCategory.findUnique({
          where: { tenantId_supplierId_name: { tenantId, supplierId: supplierId!, name: parsed.data.category } },
        })
        if (!category?.isActive) {
          throw Object.assign(new Error('请选择一个启用中的分类'), { statusCode: 400 })
        }
      }
      await tx.product.updateMany({ where, data: { category: parsed.data.category } })
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `批量修改商品分类：${matched.length} 项 → ${parsed.data.category}`,
          entityType: 'ProductBatch', targetId: supplierId || null,
          metadata: {
            supplierId: supplierId || null,
            productIds: matched.map(item => item.id),
            before: matched.map(item => ({ id: item.id, code: item.code, category: item.category })),
            afterCategory: parsed.data.category,
          },
        },
      })
    })
    void invalidatePattern(`products:full:${tenantId}:*`)
    return { ok: true, count: matched.length, category: parsed.data.category }
  })

  app.patch('/batch-status', auth(app), async (req: any, reply: any) => {
    const { role, tenantId, userId, supplierId } = req.user
    if (!PRODUCT_WRITE_ROLES.has(role)) return reply.status(403).send({ error: '无权批量修改商品' })
    const parsed = bulkIdsSchema.extend({ status: z.enum(['ENABLED', 'DISABLED']) }).safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0].message })
    const uniqueIds = [...new Set(parsed.data.ids)]
    const where: any = { id: { in: uniqueIds }, tenantId }
    if (isSupplierRole(role)) {
      if (!supplierScopeOrReply(req, reply, 'catalog.manage')) return
      if (!supplierId) return reply.status(403).send({ error: '账号未绑定供应商' })
      where.supplierId = supplierId
    }
    const matched = await prisma.product.findMany({
      where,
      select: { id: true, code: true, name: true, status: true, supplierId: true },
    })
    if (matched.length !== uniqueIds.length) return reply.status(400).send({ error: '包含不存在或无权限的商品' })

    if (role === 'SUPPLY_CHAIN') {
      const targetStatus = parsed.data.status
      const changed = matched.filter(item => item.status !== targetStatus)
      if (changed.length === 0) {
        return { ok: true, count: 0, status: targetStatus, message: '商品已是目标状态' }
      }
      await prisma.$transaction(async tx => {
        for (const item of changed) {
          const updated = await tx.product.updateMany({
            where: { id: item.id, tenantId, status: item.status },
            data: { status: targetStatus },
          })
          if (updated.count !== 1) {
            throw Object.assign(new Error('商品状态已变化，请刷新后重试'), { statusCode: 409 })
          }
          await tx.opLog.create({
            data: {
              tenantId, userId, role,
              action: `批量${targetStatus === 'ENABLED' ? '恢复供应' : '停售'} ${item.name} (#${item.code})`,
              entityType: 'Product', target: item.code, targetId: item.id,
              metadata: {
                supplierId: item.supplierId,
                fields: ['status'],
                before: { name: item.name, status: item.status },
                after: { name: item.name, status: targetStatus },
              },
            },
          })
        }
      })
      void invalidatePattern(`products:full:${tenantId}:*`)
      const action: ProductChangeAction = targetStatus === 'ENABLED' ? 'ENABLE' : 'DISABLE'
      for (const item of changed) {
        const before = { name: item.name, status: item.status }
        const after = { name: item.name, status: targetStatus }
        fireAndForgetNotifyProductChange({
          tenantId,
          productId: item.id,
          action,
          operatorId: userId,
          eventKey: `PRODUCT:${item.id}:${action}:${userId}:${hashEventPayload({ before, after })}`,
          before,
          after,
        })
      }
      return { ok: true, count: changed.length, status: targetStatus }
    }

    if (isSupplierRole(role) && parsed.data.status === 'DISABLED') {
      const eligible = matched.filter(item => item.status === 'ENABLED')
      if (eligible.length === 0) return reply.status(400).send({ error: '所选商品没有可提交停售的启用项' })
      const supplierName = supplierId
        ? (await prisma.supplier.findFirst({ where: { id: supplierId, tenantId }, select: { name: true } }))?.name
        : null
      const documentNo = await prisma.$transaction(async tx => {
        const claimed = await tx.product.updateMany({
          where: { ...where, id: { in: eligible.map(item => item.id) }, status: 'ENABLED' },
          data: { status: 'PENDING_DISABLE' },
        })
        if (claimed.count !== eligible.length) {
          throw Object.assign(new Error('商品状态已变化，请刷新后重试'), { statusCode: 409 })
        }
        const no = await nextDocumentNo(tx, tenantId)
        await tx.document.create({
          data: {
            tenantId, no, type: 'SUPPLIER_OFFER_DISABLE',
            title: `批量停售：${supplierName || '供应商'} ${eligible.length} 个 SKU`,
            amount: null, isOverThreshold: false, thresholdRule: '批量 SKU 停售 直送总厨',
            payload: {
              action: 'BATCH_DISABLE', productIds: eligible.map(item => item.id),
              count: eligible.length, supplierId, supplierName: supplierName || null,
            },
            initiatorId: userId, status: 'PENDING',
            steps: { create: [{ seq: 1, approverRole: 'CHEF_DIRECTOR', status: 'PENDING' }] },
          },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId, role,
            action: `批量停售申请：${eligible.length} 项，审批单 ${no}`,
            entityType: 'ProductBatch', target: no, targetId: supplierId || null,
            metadata: { supplierId: supplierId || null, productIds: eligible.map(item => item.id) },
          },
        })
        return no
      })
      void invalidatePattern(`products:full:${tenantId}:*`)
      return { ok: true, count: eligible.length, statusChange: 'PENDING_APPROVAL', documentNo }
    }

    const targetStatus = parsed.data.status
    if (isSupplierRole(role) && targetStatus === 'ENABLED') {
      const ineligible = matched.filter(item => item.status !== 'DISABLED')
      if (ineligible.length > 0) {
        return reply.status(400).send({ error: '供应商只能恢复已停用商品，待审批商品不能直接启用' })
      }
    }
    await prisma.$transaction(async tx => {
      const updated = await tx.product.updateMany({
        where: isSupplierRole(role) && targetStatus === 'ENABLED' ? { ...where, status: 'DISABLED' } : where,
        data: { status: targetStatus },
      })
      if (updated.count !== matched.length) {
        throw Object.assign(new Error('商品状态已变化，请刷新后重试'), { statusCode: 409 })
      }
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `批量${targetStatus === 'ENABLED' ? '恢复供应' : '停售'}：${matched.length} 项`,
          entityType: 'ProductBatch', targetId: supplierId || null,
          metadata: { supplierId: supplierId || null, productIds: matched.map(item => item.id), status: targetStatus },
        },
      })
    })
    void invalidatePattern(`products:full:${tenantId}:*`)
    return { ok: true, count: matched.length, status: targetStatus }
  })

  app.post('/', auth(app), async (req: any, reply: any) => {
    const { role, tenantId, userId, supplierId: userSupplierId } = req.user
    if (!PRODUCT_WRITE_ROLES.has(role)) {
      return reply.status(403).send({ error: '无权创建商品' })
    }
    if (isSupplierRole(role) && !supplierScopeOrReply(req, reply, 'catalog.manage')) return
    const requestBody = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as any : {}
    const parsed = productCreateSchema.safeParse(requestBody)
    if (!parsed.success) {
      const first = parsed.error.errors[0]
      return reply.status(400).send({ error: `${first.path.join('.')}: ${first.message}` })
    }
    const requestedUnitMapping = FOUR_UNIT_FIELDS.some(field => Object.prototype.hasOwnProperty.call(requestBody, field))
    if (requestedUnitMapping && !UNIT_GOVERNANCE_ROLES.has(role)) {
      return reply.status(403).send({ error: '只有内部单位治理角色可以确认四单位换算' })
    }
    // 供应商角色：忽略 body.supplierId，强制用当前账号绑定的 supplierId
    let data: any = { ...parsed.data }
    let supplierName: string | null = null
    if (isSupplierRole(role)) {
      if (!userSupplierId) return reply.status(403).send({ error: '账号未绑定供应商' })
      data.supplierId = userSupplierId
      const scopedSupplier = await prisma.supplier.findFirst({
        where: { id: userSupplierId, tenantId }, select: { id: true, name: true },
      })
      supplierName = scopedSupplier?.name || null
      if (!scopedSupplier) return reply.status(403).send({ error: '账号绑定的供应商不属于当前租户' })
      // 供应商新建 SKU 默认进入"待总厨审批"状态, 通过后才上架
      data.status = 'PENDING_APPROVAL'
      // 商品报价与供应商库存解耦；库存只能通过库存入库/调整接口形成流水。
      delete data.stock
      delete data.minStock
      delete data.inventoryUnit
      delete data.inventoryUnitsPerPurchaseUnit
      delete data.purchaseUnit
      delete data.orderUnit
      delete data.costUnit
      delete data.inventoryUnitsPerOrderUnit
      delete data.inventoryUnitsPerCostUnit
      delete data.unitConversionStatus
      delete data.unitConversionNote
    } else if (data.supplierId) {
      const scopedSupplier = await prisma.supplier.findFirst({
        where: { id: data.supplierId, tenantId }, select: { id: true, name: true },
      })
      if (!scopedSupplier) return reply.status(400).send({ error: '供应商不存在或不属于当前租户' })
      supplierName = scopedSupplier.name
      // 内部供应链：当指定供应商时，分类必须属于该供应商且启用，禁止跨租户/越权引用
      if (role === 'SUPPLY_CHAIN' && data.category) {
        const category = await prisma.supplierProductCategory.findUnique({
          where: { tenantId_supplierId_name: { tenantId, supplierId: data.supplierId, name: data.category } },
          select: { isActive: true },
        })
        if (!category?.isActive) {
          return reply.status(400).send({ error: `分类「${data.category}」不存在或已停用` })
        }
      }
    }
    // Legacy callers only send `unit`. Persist a deterministic four-unit
    // compatibility contract without guessing specification text or history.
    const compatibilityFactor = data.inventoryUnitsPerPurchaseUnit ?? 1
    data.purchaseUnit = data.purchaseUnit ?? data.unit
    data.inventoryUnit = data.inventoryUnit ?? data.unit
    data.orderUnit = data.orderUnit ?? data.unit
    data.costUnit = data.costUnit ?? data.unit
    data.inventoryUnitsPerPurchaseUnit = compatibilityFactor
    data.inventoryUnitsPerOrderUnit = data.inventoryUnitsPerOrderUnit ?? compatibilityFactor
    data.inventoryUnitsPerCostUnit = data.inventoryUnitsPerCostUnit ?? compatibilityFactor
    // V5 以订货单位作为 legacy unit 的兼容读写口径，避免新旧客户端看到不同单位。
    data.unit = data.orderUnit
    const unitIdentityError = fourUnitIdentityError(data)
    if (unitIdentityError) return reply.status(400).send({ error: unitIdentityError })
    if (requestedUnitMapping) {
      data.unitConversionStatus = data.unitConversionStatus === 'INFERRED' ? 'INFERRED' : 'VERIFIED'
      data.unitConversionVerifiedAt = data.unitConversionStatus === 'VERIFIED' ? new Date() : null
    } else {
      data.unitConversionStatus = 'PENDING'
    }
    if (data.imageKey && !String(data.imageKey).startsWith(`products/${tenantId}/`)) {
      return reply.status(400).send({ error: '商品图片不属于当前租户' })
    }
    if (!data.code) data.code = autoCode(data.supplierId)
    if (!data.category) data.category = '其他'
    // 内部供应链不进入任何待审批状态；新增商品默认直接上架，也允许明确建为停用。
    if (role === 'SUPPLY_CHAIN') {
      data.status = data.status === 'DISABLED' ? 'DISABLED' : 'ENABLED'
    }
    if (isSupplierRole(role)) {
      const existingCategory = await prisma.supplierProductCategory.findUnique({
        where: { tenantId_supplierId_name: { tenantId, supplierId: userSupplierId!, name: data.category } },
        select: { isActive: true },
      })
      if (existingCategory && !existingCategory.isActive) {
        return reply.status(400).send({ error: `分类「${data.category}」已停用，请先恢复后再使用` })
      }
    }
    try {
      const product = await prisma.$transaction(async tx => {
        if (isSupplierRole(role)) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier-categories:${tenantId}:${userSupplierId}`}))`
          const categoryWhere = {
            tenantId_supplierId_name: { tenantId, supplierId: userSupplierId!, name: data.category },
          }
          const currentCategory = await tx.supplierProductCategory.findUnique({
            where: categoryWhere, select: { isActive: true },
          })
          if (!currentCategory) {
            const max = await tx.supplierProductCategory.aggregate({
              where: { tenantId, supplierId: userSupplierId! }, _max: { sortOrder: true },
            })
            await tx.supplierProductCategory.createMany({
              data: [{
                tenantId, supplierId: userSupplierId!, name: data.category,
                sortOrder: (max._max.sortOrder ?? -1) + 1,
                isSystem: data.category === '其他',
              }],
              skipDuplicates: true,
            })
          }
          const activeCategory = await tx.supplierProductCategory.findUnique({
            where: categoryWhere, select: { isActive: true },
          })
          if (!activeCategory?.isActive) {
            throw Object.assign(new Error('商品分类状态已变化，请刷新后重试'), { statusCode: 409 })
          }
        } else if (role === 'SUPPLY_CHAIN' && data.supplierId) {
          await lockActiveSupplierCategory(tx, tenantId, data.supplierId, data.category)
        }
        const created = await tx.product.create({
          data: { tenantId, ...data } as any,
        })
        if (created.supplierId && Number(created.stock) > 0) {
          const movement = await tx.supplierStockMovement.create({
            data: {
              tenantId,
              supplierId: created.supplierId,
              productId: created.id,
              delta: created.stock,
              balanceAfter: created.stock,
              type: 'INITIAL',
              reason: '商品建档期初库存',
              sourceType: 'Product',
              sourceId: created.id,
              createdById: userId,
            },
          })
          await createSupplierStockBatchIncrease(tx, {
            tenantId,
            supplierId: created.supplierId,
            productId: created.id,
            quantity: created.stock,
            movementId: movement.id,
            createdById: userId,
            kind: 'OPENING',
            batchNo: `OPENING-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`,
          })
        }
        // 供应商创建 → 商品、审批单和操作日志原子提交。
        if (isSupplierRole(role)) {
          const no = await nextDocumentNo(tx, tenantId)
          await tx.document.create({
            data: {
              tenantId, no, type: 'SUPPLIER_OFFER_CREATE',
              title: `新品上架: ${created.name}${created.spec ? ' (' + created.spec + ')' : ''} ¥${Number(created.price)}`,
              amount: Number(created.price), isOverThreshold: false,
              thresholdRule: '新供应商商品 直送总厨',
              payload: {
                action: 'CREATE',
                productId: created.id, productName: created.name,
                productCode: created.code, spec: created.spec, unit: created.unit,
                price: Number(created.price), category: created.category,
                supplierId: created.supplierId, supplierName,
              },
              initiatorId: userId, status: 'PENDING',
              steps: { create: [{ seq: 1, approverRole: 'CHEF_DIRECTOR', status: 'PENDING' }] },
            },
          })
        }
        await tx.opLog.create({
          data: {
            tenantId, userId, role,
            action: `新建商品 ${created.name} (#${created.code})`,
            entityType: 'Product', target: created.code, targetId: created.id,
            metadata: {
              supplierId: created.supplierId,
              after: {
                code: created.code, name: created.name, spec: created.spec,
                category: created.category, unit: created.unit, price: Number(created.price),
                purchaseUnit: created.purchaseUnit, inventoryUnit: created.inventoryUnit,
                orderUnit: created.orderUnit, costUnit: created.costUnit,
                inventoryUnitsPerPurchaseUnit: Number(created.inventoryUnitsPerPurchaseUnit),
                inventoryUnitsPerOrderUnit: Number(created.inventoryUnitsPerOrderUnit),
                inventoryUnitsPerCostUnit: Number(created.inventoryUnitsPerCostUnit),
                status: created.status, imageKey: created.imageKey,
              },
            },
          },
        })
        return created
      })
      void invalidatePattern(`products:full:${tenantId}:*`)
      if (isSupplierRole(role)) {
        // 供应商上新已生成 SUPPLIER_OFFER_CREATE 审批单 → 企微通知总厨
        fireAndForget({
          tenantId,
          event: 'APPROVAL_PENDING',
          eventKey: `APPROVAL:PRODUCT:${(product as any).id}`,
          payload: {
            docTitle: `新品上架: ${(product as any).name}${(product as any).spec ? ' (' + (product as any).spec + ')' : ''} ¥${Number((product as any).price)}`,
            summary: `${supplierName || '供应商'} 提交新品,待审批上架`,
          },
        })
      } else if (role === 'SUPPLY_CHAIN') {
        // 内部供应链直接生效 → 系统消息 + 企微通知总厨
        const created = product as any
        const afterSummary = {
          name: created.name,
          code: created.code,
          spec: created.spec,
          category: created.category,
          unit: created.unit,
          purchaseUnit: created.purchaseUnit,
          inventoryUnit: created.inventoryUnit,
          orderUnit: created.orderUnit,
          costUnit: created.costUnit,
          inventoryUnitsPerPurchaseUnit: Number(created.inventoryUnitsPerPurchaseUnit),
          inventoryUnitsPerOrderUnit: Number(created.inventoryUnitsPerOrderUnit),
          inventoryUnitsPerCostUnit: Number(created.inventoryUnitsPerCostUnit),
          price: Number(created.price),
          status: created.status,
          supplierName: supplierName || undefined,
        }
        fireAndForgetNotifyProductChange({
          tenantId,
          productId: created.id,
          action: 'CREATE',
          operatorId: userId,
          eventKey: `PRODUCT:${created.id}:CREATE:${userId}:${hashEventPayload({ code: afterSummary.code, name: afterSummary.name, supplierId: created.supplierId })}`,
          before: {},
          after: afterSummary,
        })
      }
      return reply.status(201).send(product)
    } catch (e: any) {
      if (e.code === 'P2002') {
        return reply.status(409).send({ error: '商品编码已存在（请换一个 code）' })
      }
      if (e.statusCode === 409) return reply.status(409).send({ error: e.message })
      req.log.error({ err: e }, 'product create failed')
      return reply.status(500).send({ error: '创建失败（请检查日志）' })
    }
  })

  // ─── 批量创建 (Excel/CSV 上传场景) ────────────────
  app.post('/batch', auth(app), async (req: any, reply: any) => {
    const { role, tenantId, userId, supplierId: userSupplierId } = req.user
    if (!PRODUCT_WRITE_ROLES.has(role)) {
      return reply.status(403).send({ error: '无权创建商品' })
    }
    if (isSupplierRole(role) && !supplierScopeOrReply(req, reply, 'catalog.manage')) return
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as any : {}
    const items = Array.isArray(body?.items) ? body.items : null
    const parsedFilename = z.string().trim().max(255).nullable().optional().safeParse(body?.filename)
    if (!parsedFilename.success) {
      return reply.status(400).send({ error: 'filename 最多 255 个字符' })
    }
    const filename = parsedFilename.data || null
    if (!items || items.length === 0) {
      return reply.status(400).send({ error: 'items 必须是非空数组' })
    }
    if (items.length > 500) {
      return reply.status(400).send({ error: '单次最多 500 行' })
    }

    const failed: { row: number; code?: string; error: string }[] = []
    let candidates: { row: number; id: string; data: any }[] = []

    for (let i = 0; i < items.length; i++) {
      const raw = items[i]
      const parsed = productCreateSchema.safeParse(raw)
      if (!parsed.success) {
        const first = parsed.error.errors[0]
        failed.push({ row: i + 1, code: raw?.code, error: `${first.path.join('.')}: ${first.message}` })
        continue
      }
      let data: any = { ...parsed.data }
      const requestedUnitMapping = FOUR_UNIT_FIELDS.some(field =>
        raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, field),
      )
      if (requestedUnitMapping && !UNIT_GOVERNANCE_ROLES.has(role)) {
        failed.push({ row: i + 1, code: data.code, error: '只有内部单位治理角色可以确认四单位换算' })
        continue
      }
      if (isSupplierRole(role)) {
        if (!userSupplierId) {
          failed.push({ row: i + 1, code: data.code, error: '账号未绑定供应商' })
          continue
        }
        data.supplierId = userSupplierId
      }
      // 编码缺失自动生成
      if (!data.code) data.code = autoCode(data.supplierId || userSupplierId)
      // 类目缺失默认其他
      if (!data.category) data.category = '其他'
      // 解耦: 报价表 (products) 不再接受 stock/minStock, 库存只走库存模块
      delete data.stock
      delete data.minStock
      const compatibilityFactor = data.inventoryUnitsPerPurchaseUnit ?? 1
      data.purchaseUnit = data.purchaseUnit ?? data.unit
      data.inventoryUnit = data.inventoryUnit ?? data.unit
      data.orderUnit = data.orderUnit ?? data.unit
      data.costUnit = data.costUnit ?? data.unit
      data.inventoryUnitsPerPurchaseUnit = compatibilityFactor
      data.inventoryUnitsPerOrderUnit = data.inventoryUnitsPerOrderUnit ?? compatibilityFactor
      data.inventoryUnitsPerCostUnit = data.inventoryUnitsPerCostUnit ?? compatibilityFactor
      data.unit = data.orderUnit
      const unitIdentityError = fourUnitIdentityError(data)
      if (unitIdentityError) {
        failed.push({ row: i + 1, code: data.code, error: unitIdentityError })
        continue
      }
      data.unitConversionStatus = requestedUnitMapping
        ? data.unitConversionStatus === 'INFERRED' ? 'INFERRED' : 'VERIFIED'
        : 'PENDING'
      data.unitConversionVerifiedAt = data.unitConversionStatus === 'VERIFIED' ? new Date() : null
      // 供应商批量上传 → 默认 PENDING_APPROVAL, 一会儿一并起一个审批单
      if (isSupplierRole(role)) data.status = 'PENDING_APPROVAL'
      candidates.push({ row: i + 1, id: createId(), data })
    }

    if (isSupplierRole(role) && userSupplierId) {
      const categoryNames = [...new Set(candidates.map(candidate => candidate.data.category))]
      const categories = await prisma.supplierProductCategory.findMany({
        where: { tenantId, supplierId: userSupplierId, name: { in: categoryNames } },
        select: { name: true, isActive: true },
      })
      const inactive = new Set(categories.filter(category => !category.isActive).map(category => category.name))
      candidates = candidates.filter(candidate => {
        if (!inactive.has(candidate.data.category)) return true
        failed.push({ row: candidate.row, code: candidate.data.code, error: `分类「${candidate.data.category}」已停用，请先恢复后再使用` })
        return false
      })
    } else if (!isSupplierRole(role)) {
      // 总部账号可为商品指定供应商，但只能引用本租户供应商。
      const requestedSupplierIds = [...new Set(candidates.map(candidate => candidate.data.supplierId).filter(Boolean))] as string[]
      const allowedSuppliers = requestedSupplierIds.length > 0
        ? await prisma.supplier.findMany({
          where: { tenantId, id: { in: requestedSupplierIds } }, select: { id: true },
        })
        : []
      const allowedSupplierIds = new Set(allowedSuppliers.map(supplier => supplier.id))
      candidates = candidates.filter(candidate => {
        const candidateSupplierId = candidate.data.supplierId
        if (!candidateSupplierId || allowedSupplierIds.has(candidateSupplierId)) return true
        failed.push({ row: candidate.row, code: candidate.data.code, error: '供应商不存在或不属于当前租户' })
        return false
      })
    }

    const supplier = isSupplierRole(role) && userSupplierId
      ? await prisma.supplier.findFirst({ where: { id: userSupplierId, tenantId }, select: { name: true } })
      : null
    if (isSupplierRole(role) && userSupplierId && !supplier) {
      return reply.status(403).send({ error: '账号绑定的供应商不属于当前租户' })
    }

    try {
      const result = await prisma.$transaction(async tx => {
        const batch = await tx.productBatch.create({
          data: {
            tenantId,
            supplierId: isSupplierRole(role) ? userSupplierId || null : null,
            uploadedById: userId,
            filename,
            totalRows: items.length,
            createdCount: 0,
            failedCount: 0,
            failedRows: [] as any,
          },
        })

        if (isSupplierRole(role) && userSupplierId && candidates.length > 0) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`supplier-categories:${tenantId}:${userSupplierId}`}))`
          const categoryNames = [...new Set(candidates.map(candidate => candidate.data.category))]
          const existingCategories = await tx.supplierProductCategory.findMany({
            where: { tenantId, supplierId: userSupplierId, name: { in: categoryNames } },
            select: { name: true },
          })
          const existingNames = new Set(existingCategories.map(category => category.name))
          const missingNames = categoryNames.filter(name => !existingNames.has(name))
          if (missingNames.length > 0) {
            const max = await tx.supplierProductCategory.aggregate({
              where: { tenantId, supplierId: userSupplierId }, _max: { sortOrder: true },
            })
            await tx.supplierProductCategory.createMany({
              data: missingNames.map((name, index) => ({
                tenantId, supplierId: userSupplierId, name,
                sortOrder: (max._max.sortOrder ?? -1) + index + 1,
                isSystem: name === '其他',
              })),
              skipDuplicates: true,
            })
          }
          const activeCategoryCount = await tx.supplierProductCategory.count({
            where: { tenantId, supplierId: userSupplierId, name: { in: categoryNames }, isActive: true },
          })
          if (activeCategoryCount !== categoryNames.length) {
            throw new Error('商品分类状态已变化，请刷新后重试')
          }
        }

        if (candidates.length > 0) {
          await tx.product.createMany({
            data: candidates.map(candidate => ({
              id: candidate.id, tenantId, batchId: batch.id, ...candidate.data,
            })) as any,
            skipDuplicates: true,
          })
        }
        const insertedProducts = candidates.length > 0
          ? await tx.product.findMany({
            where: { tenantId, id: { in: candidates.map(candidate => candidate.id) } },
            select: { id: true, code: true, name: true },
          })
          : []
        const insertedById = new Map(insertedProducts.map(product => [product.id, product]))
        const created = candidates.flatMap(candidate => {
          const product = insertedById.get(candidate.id)
          if (!product) {
            failed.push({ row: candidate.row, code: candidate.data.code, error: '编码已存在' })
            return []
          }
          return [{ row: candidate.row, id: product.id, code: product.code, name: product.name }]
        })
        failed.sort((a, b) => a.row - b.row)

        await tx.productBatch.update({
          where: { id: batch.id },
          data: {
            createdCount: created.length,
            failedCount: failed.length,
            failedRows: failed as any,
          },
        })

        let approvalDocNo: string | null = null
        if (isSupplierRole(role) && created.length > 0) {
          const no = await nextDocumentNo(tx, tenantId)
          const doc = await tx.document.create({
            data: {
              tenantId, no, type: 'SUPPLIER_OFFER_CREATE',
              title: `批量新品: ${supplier?.name || '供应商'} 上架 ${created.length} 个 SKU${filename ? ` (${filename})` : ''}`,
              amount: null, isOverThreshold: false,
              thresholdRule: '批量新供应商商品 直送总厨',
              payload: {
                action: 'BATCH', batchId: batch.id,
                productIds: created.map(product => product.id),
                count: created.length, filename: filename || null,
                supplierId: userSupplierId, supplierName: supplier?.name || null,
              },
              initiatorId: userId, status: 'PENDING',
              steps: { create: [{ seq: 1, approverRole: 'CHEF_DIRECTOR', status: 'PENDING' }] },
            },
          })
          approvalDocNo = doc.no
        }

        if (created.length > 0) {
          await tx.opLog.create({
            data: {
              tenantId, userId, role,
              action: `批量上传商品：成功 ${created.length}，失败 ${failed.length}`,
              entityType: 'ProductBatch', target: filename || undefined, targetId: batch.id,
              metadata: {
                supplierId: isSupplierRole(role) ? userSupplierId || null : null,
                productIds: created.map(item => item.id), filename,
                createdCount: created.length, failedCount: failed.length,
              },
            },
          })
        }
        return { batchId: batch.id, created, approvalDocNo }
      })
      void invalidatePattern(`products:full:${tenantId}:*`)
      return reply.status(201).send({
        batchId: result.batchId,
        total: items.length,
        createdCount: result.created.length,
        failedCount: failed.length,
        created: result.created,
        failed,
        approvalDocNo: result.approvalDocNo,
      })
    } catch (error: any) {
      req.log.error({ err: error }, 'product batch create failed')
      return reply.status(500).send({ error: '批量创建失败，未保存任何商品' })
    }
  })

  // ─── 上传历史列表 ─────────────────────────────────
  app.get('/batches', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, supplierId } = req.user
    if (!PRODUCT_WRITE_ROLES.has(role)) return reply.status(403).send({ error: '无权查看商品上传历史' })
    const where: any = { tenantId }
    if (isSupplierRole(role)) {
      if (!supplierScopeOrReply(req, reply, 'catalog.read')) return
      if (!supplierId) return []
      where.supplierId = supplierId
    }
    const list = await prisma.productBatch.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
      include: {
        _count: { select: { products: true } },
      },
    })
    const batchIds = list.map(batch => batch.id)
    const enabledCounts = batchIds.length > 0
      ? await prisma.product.groupBy({
          by: ['batchId'],
          where: { batchId: { in: batchIds }, tenantId, status: 'ENABLED' },
          _count: { _all: true },
        })
      : []
    const enabledMap = new Map(enabledCounts.map(row => [row.batchId, row._count._all]))
    return list.map(batch => ({
      ...batch,
      canRevoke: !batch.revokedAt && (!isSupplierRole(role) || (enabledMap.get(batch.id) || 0) === 0),
    }))
  })

  // ─── 撤回上传：只停售并留存历史，禁止物理删除商品/库存流水 ──────
  app.patch('/batches/:id/revoke', auth(app), async (req: any, reply: any) => {
    const { tenantId, role, userId, supplierId } = req.user
    if (!PRODUCT_WRITE_ROLES.has(role)) return reply.status(403).send({ error: '无权撤回商品上传批次' })
    const { id } = req.params as any
    const where: any = { id, tenantId }
    if (isSupplierRole(role)) {
      if (!supplierScopeOrReply(req, reply, 'catalog.manage')) return
      if (!supplierId) return reply.status(403).send({ error: '账号未绑定供应商' })
      where.supplierId = supplierId
    }
    const b = await prisma.productBatch.findFirst({ where })
    if (!b) return reply.status(404).send({ error: '批次不存在' })
    if (b.revokedAt) return reply.status(400).send({ error: '已撤回, 不可重复操作' })
    try {
      const result = await prisma.$transaction(async tx => {
        const pendingDocuments = await tx.document.findMany({
          where: {
            tenantId, type: { in: ['NEW_DISH', 'SUPPLIER_OFFER_CREATE'] }, status: 'PENDING',
            payload: { path: ['batchId'], equals: b.id },
          },
          select: { id: true },
          orderBy: { id: 'asc' },
        })
        for (const document of pendingDocuments) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`document:${document.id}`}))`
        }
        // 供应商角色：在事务内按稳定 id 顺序锁定批次商品，防止并发审批上架后绕过停售审批。
        const products = await tx.$queryRaw<[{ id: string; status: string }]>`
          SELECT id, status FROM "products"
          WHERE "batchId" = ${b.id} AND "tenantId" = ${tenantId}
          ORDER BY id ASC
          FOR UPDATE
        `
        if (isSupplierRole(role)) {
          const enabledCount = products.filter(p => p.status === 'ENABLED').length
          if (enabledCount > 0) {
            throw Object.assign(new Error('该批次包含已上架商品，请先通过批量停售流程提交审批后停售'), { statusCode: 400 })
          }
        }
        const claimed = await tx.productBatch.updateMany({
          where: { id: b.id, tenantId, revokedAt: null },
          data: { revokedAt: new Date(), revokedById: userId },
        })
        if (claimed.count !== 1) {
          throw Object.assign(new Error('批次状态已变化，请刷新后重试'), { statusCode: 409 })
        }
        await tx.product.updateMany({
          where: { batchId: b.id, tenantId }, data: { status: 'DISABLED' },
        })
        if (pendingDocuments.length > 0) {
          await tx.document.updateMany({
            where: { id: { in: pendingDocuments.map(document => document.id) }, tenantId, status: 'PENDING' },
            data: { status: 'CANCELED', finalizedAt: new Date() },
          })
        }
        await tx.opLog.create({
          data: {
            tenantId, userId, role,
            action: `撤回批次上传 ${b.id}，停售 ${products.length} 个 SKU（历史保留）`,
            entityType: 'ProductBatch', targetId: b.id,
            metadata: {
              supplierId: b.supplierId, productIds: products.map(item => item.id),
              canceledDocumentIds: pendingDocuments.map(document => document.id),
            },
          },
        })
        return { disabledCount: products.length }
      })
      void invalidatePattern(`products:full:${tenantId}:*`)
      return { success: true, disabledCount: result.disabledCount }
    } catch (error: any) {
      if (error?.statusCode) return reply.status(error.statusCode).send({ error: error.message })
      req.log.error({ err: error }, 'product batch revoke failed')
      return reply.status(500).send({ error: '撤回失败，未保存任何变更' })
    }
  })

  // 历史商品、库存流水和批次禁止物理清除；保留旧接口并明确拒绝，防旧前端误调用。
  app.delete('/clear-all', auth(app), async (req: any, reply: any) => {
    return reply.status(410).send({ error: '为保护订单和库存审计，清空全部 SKU 已永久停用。请使用批量停售。' })
  })

  app.patch('/:id', auth(app), async (req: any, reply: any) => {
    const { role, tenantId, userId, supplierId } = req.user
    if (!PRODUCT_WRITE_ROLES.has(role)) {
      return reply.status(403).send({ error: '无权修改商品' })
    }
    // 供应商只能改自己 SKU
    const where: any = { id: req.params.id, tenantId }
    if (isSupplierRole(role)) {
      if (!supplierScopeOrReply(req, reply, 'catalog.manage')) return
      if (!supplierId) return reply.status(403).send({ error: '账号未绑定供应商' })
      where.supplierId = supplierId
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as any : {}
    // P1: 非供应商角色也必须白名单字段, 防 mass assignment (改 tenantId / supplierId / id)
    const SUPPLIER_ALLOW = ['price', 'spec', 'category', 'imageKey', 'minOrderQty', 'stepQty', 'shelfDays', 'status', 'shipUpperPct', 'shipUpperBuffer']
    const STAFF_ALLOW = [...SUPPLIER_ALLOW, 'name', 'unit', 'category', 'code']  // 内部员工额外可改名/类
    const UNIT_ALLOW = [
      'purchaseUnit', 'inventoryUnit', 'orderUnit', 'costUnit',
      'inventoryUnitsPerPurchaseUnit', 'inventoryUnitsPerOrderUnit', 'inventoryUnitsPerCostUnit',
      'unitConversionStatus', 'unitConversionNote',
    ]
    const allow = isSupplierRole(role)
      ? SUPPLIER_ALLOW
      : UNIT_GOVERNANCE_ROLES.has(role)
        ? [...STAFF_ALLOW, ...UNIT_ALLOW]
        : STAFF_ALLOW
    const parsedPatch = productPatchSchema.safeParse(
      Object.fromEntries(Object.entries(body).filter(([k]) => allow.includes(k))),
    )
    if (!parsedPatch.success) return reply.status(400).send({ error: parsedPatch.error.issues[0].message })
    const data: any = parsedPatch.data
    if (data.imageKey && !String(data.imageKey).startsWith(`products/${tenantId}/`)) {
      return reply.status(400).send({ error: '商品图片不属于当前租户' })
    }
    if (isSupplierRole(role) && data.category) {
      const category = await prisma.supplierProductCategory.findUnique({
        where: { tenantId_supplierId_name: { tenantId, supplierId: supplierId!, name: String(data.category).trim() } },
      })
      if (!category?.isActive) return reply.status(400).send({ error: '请选择一个启用中的分类' })
      data.category = category.name
    }
    if (isSupplierRole(role) && data.status && !['ENABLED', 'DISABLED'].includes(data.status)) {
      return reply.status(400).send({ error: '供应商不能直接设置待审批状态' })
    }
    if (role === 'SUPPLY_CHAIN' && data.status && !['ENABLED', 'DISABLED'].includes(data.status)) {
      return reply.status(400).send({ error: '内部供应链商品维护必须直接写入启用或停用状态' })
    }
    if (isSupplierRole(role) && data.status === 'ENABLED') {
      const current = await prisma.product.findFirst({ where, select: { status: true } })
      if (!current) return reply.status(404).send({ error: '商品不存在或无权修改' })
      if (current.status !== 'DISABLED') {
        return reply.status(400).send({ error: '供应商只能恢复已停用商品，待审批商品不能直接启用' })
      }
      where.status = 'DISABLED'
    }

    // 供应商停售 SKU → 不直接落库, 创建 NEW_DISH(action=DISABLE) 审批单
    if (isSupplierRole(role) && data.status === 'DISABLED') {
      const cur = await prisma.product.findFirst({
        where, select: { id: true, name: true, code: true, status: true, supplier: { select: { name: true } } },
      })
      if (!cur) return reply.status(404).send({ error: '商品不存在或无权修改' })
      if (cur.status !== 'ENABLED') return reply.status(400).send({ error: `商品当前状态 ${cur.status}, 不能再申请停售` })
      const pending = await prisma.document.findFirst({
        where: {
          tenantId, type: { in: ['NEW_DISH', 'SUPPLIER_OFFER_DISABLE'] }, status: 'PENDING',
          payload: { path: ['productId'], equals: cur.id },
        },
      })
      if (pending) return reply.status(400).send({ error: `该商品已有待审批单 ${pending.no}` })
      const doc = await prisma.$transaction(async tx => {
        const claimed = await tx.product.updateMany({
          where: { ...where, status: 'ENABLED' },
          data: { status: 'PENDING_DISABLE' as any },
        })
        if (claimed.count !== 1) {
          throw Object.assign(new Error('商品状态已变化，请刷新后重试'), { statusCode: 409 })
        }
        const no = await nextDocumentNo(tx, tenantId)
        const created = await tx.document.create({
          data: {
            tenantId, no, type: 'SUPPLIER_OFFER_DISABLE',
            title: `停售: ${cur.name} (#${cur.code})`,
            amount: null, isOverThreshold: false,
            thresholdRule: 'SKU 停售 直送总厨',
            payload: {
              action: 'DISABLE',
              productId: cur.id, productName: cur.name, productCode: cur.code,
              supplierId, supplierName: cur.supplier?.name || null,
            },
            initiatorId: userId, status: 'PENDING',
            steps: { create: [{ seq: 1, approverRole: 'CHEF_DIRECTOR', status: 'PENDING' }] },
          },
        })
        await tx.opLog.create({
          data: {
            tenantId, userId, role,
            action: `申请停售商品 ${cur.name} (#${cur.code})，审批单 ${created.no}`,
            entityType: 'Product', target: cur.code, targetId: cur.id,
            metadata: { supplierId, before: { status: cur.status }, after: { status: 'PENDING_DISABLE' }, documentNo: created.no },
          },
        })
        return created
      })
      void invalidatePattern(`products:full:${tenantId}:*`)
      return { count: 1, statusChange: 'PENDING_APPROVAL', documentNo: doc.no, message: '停售已提交总厨审批' }
    }

    // 供应商改价: 降价 / 首次定价 直接落库, 涨价才走审批
    if (isSupplierRole(role) && data.price != null) {
      const cur = await prisma.product.findFirst({
        where, select: { id: true, name: true, code: true, price: true, supplier: { select: { name: true } } },
      })
      if (!cur) return reply.status(404).send({ error: '商品不存在或无权修改' })
      const oldPrice = Number(cur.price)
      const newPrice = Number(data.price)
      const noChange = Math.abs(oldPrice - newPrice) < 0.001
      const isPriceUp = newPrice > oldPrice && oldPrice > 0  // 真涨价 (oldPrice>0 排除"首次定价")
      // 降价 / 首次定价 / 价格不变 → 直接进入下面 update; 仅涨价才走审批分支
      if (!noChange && isPriceUp) {
        // 检查是否有 PENDING 的同商品调价单, 避免重复提交
        const pending = await prisma.document.findFirst({
          where: {
            tenantId, type: 'PRICE_ADJUSTMENT', status: 'PENDING',
            payload: { path: ['productId'], equals: cur.id },
          },
        })
        if (pending) {
          return reply.status(400).send({ error: `该商品已有待审批的调价单 ${pending.no}, 请等总厨处理后再改` })
        }
        const delta = newPrice - oldPrice
        const pct = oldPrice > 0 ? (delta / oldPrice * 100).toFixed(1) : 'N/A'
        const sign = delta > 0 ? '↑' : '↓'
        const title = `调价: ${cur.name} ¥${oldPrice} → ¥${newPrice} (${sign}${Math.abs(delta).toFixed(2)} / ${pct}%)`
        // 价格字段从本次更新 data 里去除, 其他字段仍可与审批单原子提交。
        delete data.price
        const doc = await prisma.$transaction(async tx => {
          if (data.category) {
            await lockActiveSupplierCategory(tx, tenantId, supplierId!, data.category)
          }
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`product-price:${cur.id}`}))::text AS locked`
          const concurrent = await tx.document.findFirst({
            where: {
              tenantId, type: 'PRICE_ADJUSTMENT', status: 'PENDING',
              payload: { path: ['productId'], equals: cur.id },
            },
            select: { no: true },
          })
          if (concurrent) {
            throw Object.assign(new Error(`该商品已有待审批的调价单 ${concurrent.no}`), { statusCode: 409 })
          }
          const no = await nextDocumentNo(tx, tenantId)
          const created = await tx.document.create({
            data: {
              tenantId, no, type: 'PRICE_ADJUSTMENT', title,
              amount: newPrice, isOverThreshold: false,
              thresholdRule: '调价 直送总厨',
              payload: {
                productId: cur.id, productName: cur.name, productCode: cur.code,
                supplierId, supplierName: cur.supplier?.name || null,
                oldPrice, newPrice, delta, pct,
              },
              initiatorId: userId, status: 'PENDING',
              steps: { create: [{ seq: 1, approverRole: 'CHEF_DIRECTOR', status: 'PENDING' }] },
            },
          })
          if (Object.keys(data).length > 0) await tx.product.updateMany({ where, data })
          await tx.opLog.create({
            data: {
              tenantId, userId, role,
              action: `申请调价 ${cur.name} (#${cur.code})：¥${oldPrice} → ¥${newPrice}`,
              entityType: 'Product', target: cur.code, targetId: cur.id,
              metadata: { supplierId, before: { price: oldPrice }, requested: { price: newPrice }, documentNo: created.no },
            },
          })
          return created
        })
        void invalidatePattern(`products:full:${tenantId}:*`)
        // 涨价审批单已生成 → 企微通知总厨
        fireAndForget({
          tenantId,
          event: 'APPROVAL_PENDING',
          eventKey: `APPROVAL:PRICE:${doc.no}`,
          payload: {
            docTitle: title,
            summary: `${cur.supplier?.name || '供应商'} 申请涨价,审批通过后自动生效`,
          },
        })
        return { count: 1, priceChangeStatus: 'PENDING_APPROVAL', documentNo: doc.no, message: '涨价已提交总厨审批, 通过后自动生效' }
      }
      // 价格不变 → 不写; 降价 / 首次定价 → 直接落库 (data.price 已是新价, 由下面 updateMany 应用)
      if (noChange) delete data.price
    }

    if (Object.keys(data).length === 0) return { count: 0, message: '没有可修改字段' }
    const before = await prisma.product.findFirst({
      where,
      select: {
        id: true, code: true, name: true, supplierId: true, price: true, spec: true,
        category: true, imageKey: true, minOrderQty: true, stepQty: true,
        shelfDays: true, status: true, shipUpperPct: true, shipUpperBuffer: true,
        unit: true, purchaseUnit: true, inventoryUnit: true, orderUnit: true, costUnit: true,
        inventoryUnitsPerPurchaseUnit: true,
        inventoryUnitsPerOrderUnit: true, inventoryUnitsPerCostUnit: true,
        unitConversionStatus: true, unitConversionNote: true, unitConversionVerifiedAt: true,
      },
    })
    if (!before) return reply.status(404).send({ error: '商品不存在或无权修改' })
    const mappingTouched = UNIT_ALLOW.some(field => Object.prototype.hasOwnProperty.call(data, field))
    if (Object.prototype.hasOwnProperty.call(data, 'unit') && !mappingTouched) {
      // Legacy unit edits keep legacy clients deterministic. The old verified
      // purchase mapping is still invalidated exactly as before.
      data.purchaseUnit = data.unit
      data.orderUnit = data.unit
      data.costUnit = data.unit
      data.inventoryUnit = null
      data.inventoryUnitsPerPurchaseUnit = null
      data.inventoryUnitsPerOrderUnit = 1
      data.inventoryUnitsPerCostUnit = 1
      data.unitConversionStatus = 'PENDING'
      data.unitConversionNote = '兼容单位已变更，待重新配置四单位换算'
      data.unitConversionVerifiedAt = null
    } else if (mappingTouched) {
      if (Object.prototype.hasOwnProperty.call(data, 'orderUnit')) {
        data.unit = data.orderUnit
      } else if (Object.prototype.hasOwnProperty.call(data, 'unit')) {
        data.orderUnit = data.unit
      }
      const materialMappingChanged = FOUR_UNIT_FIELDS.some(field =>
        Object.prototype.hasOwnProperty.call(data, field)
        && !productFieldEquals((before as any)[field], data[field]),
      )
      const nextUnit = Object.prototype.hasOwnProperty.call(data, 'inventoryUnit')
        ? data.inventoryUnit
        : before.inventoryUnit
      const nextFactor = Object.prototype.hasOwnProperty.call(data, 'inventoryUnitsPerPurchaseUnit')
        ? data.inventoryUnitsPerPurchaseUnit
        : before.inventoryUnitsPerPurchaseUnit
      if (Boolean(nextUnit) !== Boolean(nextFactor)) {
        return reply.status(400).send({ error: '库存基础单位与每采购单位换算数量必须同时填写' })
      }
      const unitIdentityError = fourUnitIdentityError({ ...before, ...data })
      if (unitIdentityError) return reply.status(400).send({ error: unitIdentityError })
      if (!nextUnit || !nextFactor) {
        data.inventoryUnit = null
        data.inventoryUnitsPerPurchaseUnit = null
        data.unitConversionStatus = 'PENDING'
        data.unitConversionVerifiedAt = null
      } else {
        if (!data.unitConversionStatus || data.unitConversionStatus === 'PENDING') {
          // 总厨/管理员在界面明确保存即视为人工复核。
          data.unitConversionStatus = 'VERIFIED'
        }
        const becomesVerified = data.unitConversionStatus === 'VERIFIED'
          && before.unitConversionStatus !== 'VERIFIED'
        if (materialMappingChanged || becomesVerified) {
          data.unitConversionVerifiedAt = data.unitConversionStatus === 'VERIFIED' ? new Date() : null
        }
      }
    }
    if (role === 'SUPPLY_CHAIN') {
      for (const field of Object.keys(data)) {
        if (productFieldEquals((before as any)[field], data[field])) delete data[field]
      }
      if (Object.keys(data).length === 0) return { count: 0, message: '商品已是目标状态' }
    }
    const after = await prisma.$transaction(async tx => {
      if (isSupplierRole(role) && data.category) {
        await lockActiveSupplierCategory(tx, tenantId, supplierId!, data.category)
      } else if (role === 'SUPPLY_CHAIN' && data.category && before.supplierId) {
        await lockActiveSupplierCategory(tx, tenantId, before.supplierId, data.category)
      }
      let updated
      if (isSupplierRole(role) && data.status === 'ENABLED') {
        const claimed = await tx.product.updateMany({ where: { ...where, id: before.id }, data })
        if (claimed.count !== 1) {
          throw Object.assign(new Error('商品状态已变化，请刷新后重试'), { statusCode: 409 })
        }
        updated = await tx.product.findUniqueOrThrow({ where: { id: before.id } })
      } else {
        updated = await tx.product.update({ where: { id: before.id }, data })
      }
      await tx.opLog.create({
        data: {
          tenantId, userId, role,
          action: `修改商品 ${before.name} (#${before.code})：${Object.keys(data).join('、')}`,
          entityType: 'Product', target: before.code, targetId: before.id,
          metadata: {
            supplierId: before.supplierId,
            fields: Object.keys(data),
            before: jsonSafe(before),
            after: jsonSafe(Object.fromEntries(Object.keys(data).map(key => [key, (updated as any)[key]]))),
          },
        },
      })
      return updated
    })
    void invalidatePattern(`products:full:${tenantId}:*`)
    // 供应商降价直接生效 → 企微知会总厨 (首次定价 oldPrice=0 不打扰)
    if (isSupplierRole(role) && data.price != null) {
      const oldP = Number(before.price)
      const newP = Number((after as any).price)
      if (oldP > 0 && newP < oldP) {
        fireAndForget({
          tenantId,
          event: 'PRICE_REDUCED',
          eventKey: `PRICE-DOWN:${before.id}:${newP}`,
          payload: { productName: before.name, oldPrice: oldP, newPrice: newP },
        })
      }
    }
    if (role === 'SUPPLY_CHAIN') {
      const action = resolveProductChangeAction(data)
      const changedFields = Object.keys(data)
      const beforeSummary = buildProductChangeSummary(before, changedFields)
      const afterSummary = buildProductChangeSummary(after, changedFields)
      if (action === 'PRICE_CHANGE') {
        beforeSummary.price = Number(before.price)
        afterSummary.price = Number((after as any).price)
      }
      if (action === 'DISABLE' || action === 'ENABLE') {
        beforeSummary.status = before.status
        afterSummary.status = (after as any).status
      }
      const eventKey = `PRODUCT:${before.id}:${action}:${userId}:${hashEventPayload({ before: beforeSummary, after: afterSummary })}`
      fireAndForgetNotifyProductChange({
        tenantId,
        productId: before.id,
        action,
        operatorId: userId,
        eventKey,
        before: beforeSummary,
        after: afterSummary,
      })
    }
    return { count: 1, product: { ...after, imageUrl: signOssKey(after.imageKey) } }
  })
}
