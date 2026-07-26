import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Prisma, PrismaClient } from '@dianjie/db'

export const DEFAULT_WAREHOUSE_ID = 'default'
export const DEFAULT_WAREHOUSE_NAME = '默认仓'
export const DEFAULT_WAREHOUSE_META = Object.freeze({
  id: DEFAULT_WAREHOUSE_ID,
  name: DEFAULT_WAREHOUSE_NAME,
})

export type WarehouseResolverDb =
  | Pick<PrismaClient, 'warehouse'>
  | Pick<Prisma.TransactionClient, 'warehouse'>

function normalizeWarehouseId(raw: unknown): string {
  if (raw === undefined || raw === null) return DEFAULT_WAREHOUSE_ID
  const value = typeof raw === 'string' ? raw.trim() : String(raw).trim()
  return value || DEFAULT_WAREHOUSE_ID
}

export function resolveWarehouseId(raw: unknown): string {
  const value = normalizeWarehouseId(raw)
  if (value === DEFAULT_WAREHOUSE_ID) return DEFAULT_WAREHOUSE_ID
  throw Object.assign(
    new Error(`未知仓库：${value}，当前仅支持默认仓`),
    { statusCode: 400 },
  )
}

export async function resolveTenantWarehouseId(
  db: WarehouseResolverDb,
  tenantId: string,
  rawWarehouseId: unknown,
): Promise<string> {
  if (!tenantId) {
    throw Object.assign(new Error('缺少租户上下文，无法解析仓库'), { statusCode: 400 })
  }

  const requestedId = normalizeWarehouseId(rawWarehouseId)
  const usesDefaultAlias = requestedId === DEFAULT_WAREHOUSE_ID
  const warehouse = await db.warehouse.findFirst({
    where: usesDefaultAlias
      ? { tenantId, isDefault: true, isActive: true }
      : { tenantId, id: requestedId, isActive: true },
    select: { id: true },
  })

  if (!warehouse) {
    const message = usesDefaultAlias
      ? '当前租户不存在启用的默认仓'
      : '仓库不存在、已停用或不属于当前租户'
    throw Object.assign(new Error(message), { statusCode: 404 })
  }

  return warehouse.id
}

export async function requireDefaultWarehouse(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const queryId = (req.query as Record<string, unknown> | null)?.warehouseId
  const bodyId = (req.body as Record<string, unknown> | null)?.warehouseId
  try {
    resolveWarehouseId(queryId)
    resolveWarehouseId(bodyId)
  } catch (error: any) {
    reply.status(error.statusCode || 400).send({ error: error.message })
  }
}
