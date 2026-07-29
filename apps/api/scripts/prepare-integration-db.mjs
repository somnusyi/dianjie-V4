import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

function databaseName(databaseUrl) {
  if (!databaseUrl) return null
  try {
    return new URL(databaseUrl).pathname.replace(/^\//, '') || null
  } catch {
    return null
  }
}

const name = databaseName(process.env.DATABASE_URL)
if (!name || !/(?:_test|_ci)$/i.test(name)) {
  console.error('拒绝迁移集成测试数据库：DATABASE_URL 的数据库名必须以 _test 或 _ci 结尾')
  process.exit(1)
}

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const result = spawnSync(
  'pnpm',
  ['--filter', '@dianjie/db', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
  {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  },
)

if (result.error) {
  console.error(`无法执行测试数据库迁移：${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
