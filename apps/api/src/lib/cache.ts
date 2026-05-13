import Redis from 'ioredis'

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
})

redis.on('error', () => {}) // 静默错误，缓存不可用时降级到直接查库

export async function cached<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
  try {
    const hit = await redis.get(key)
    if (hit) return JSON.parse(hit)
  } catch {}

  const data = await fn()

  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(data))
  } catch {}

  return data
}

export async function invalidate(...keys: string[]) {
  try {
    if (keys.length > 0) await redis.del(...keys)
  } catch {}
}

export async function invalidatePattern(pattern: string) {
  try {
    const keys = await redis.keys(pattern)
    if (keys.length > 0) await redis.del(...keys)
  } catch {}
}
