import type { FastifyReply, FastifyRequest } from 'fastify'

export const DEFAULT_WAREHOUSE_ID = 'default'
export const DEFAULT_WAREHOUSE_NAME = '默认仓'
export const DEFAULT_WAREHOUSE_META = Object.freeze({
  id: DEFAULT_WAREHOUSE_ID,
  name: DEFAULT_WAREHOUSE_NAME,
})

export function resolveWarehouseId(raw: unknown): string {
  if (raw === undefined || raw === null) return DEFAULT_WAREHOUSE_ID
  const value = typeof raw === 'string' ? raw.trim() : String(raw).trim()
  if (value === '' || value === DEFAULT_WAREHOUSE_ID) return DEFAULT_WAREHOUSE_ID
  throw Object.assign(
    new Error(`未知仓库：${value}，当前仅支持默认仓`),
    { statusCode: 400 },
  )
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
