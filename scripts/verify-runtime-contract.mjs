import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const expected = {
  nodeMajor: 20,
  pnpm: '10.32.1',
  prisma: '5.22.0',
}

const failures = []
const rootPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const apiPackage = JSON.parse(readFileSync(path.join(root, 'apps/api/package.json'), 'utf8'))
const dbPackage = JSON.parse(readFileSync(path.join(root, 'packages/db/package.json'), 'utf8'))

const nodeVersion = process.versions.node
const nodeMajor = Number(nodeVersion.split('.')[0])
if (nodeMajor !== expected.nodeMajor) {
  failures.push(`Node.js ${nodeVersion} is active; expected major ${expected.nodeMajor}.`)
}

let pnpmVersion = 'unavailable'
try {
  pnpmVersion = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim()
} catch {
  failures.push('pnpm is unavailable on PATH.')
}
if (pnpmVersion !== expected.pnpm) {
  failures.push(`pnpm ${pnpmVersion} is active; expected ${expected.pnpm}.`)
}

if (rootPackage.packageManager !== `pnpm@${expected.pnpm}`) {
  failures.push(`packageManager must be pnpm@${expected.pnpm}.`)
}
if (rootPackage.engines?.node !== '20.x' || rootPackage.engines?.pnpm !== expected.pnpm) {
  failures.push('package.json engines must pin Node 20.x and pnpm 10.32.1.')
}

const prismaDeclarations = [
  ['apps/api @prisma/client', apiPackage.dependencies?.['@prisma/client']],
  ['packages/db @prisma/client', dbPackage.dependencies?.['@prisma/client']],
  ['packages/db prisma', dbPackage.devDependencies?.prisma],
]
for (const [label, value] of prismaDeclarations) {
  if (value !== expected.prisma) {
    failures.push(`${label} must be exactly ${expected.prisma}; found ${value ?? 'missing'}.`)
  }
}

const migrationRoot = path.join(root, 'packages/db/prisma/migrations')
const migrations = readdirSync(migrationRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort()
if (migrations.length === 0) {
  failures.push('No Prisma migrations were found.')
}

const requiredEnvironmentKeys = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'API_PORT',
  'API_HOST',
  'NODE_ENV',
  'NEXT_PUBLIC_API_URL',
  'FRONTEND_URL',
  'OSS_REGION',
  'OSS_BUCKET',
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
  'WECOM_REDIRECT_BASE',
  'RECEIPT_STORAGE_DIR',
  'CMB_SERVICE_PORT',
  'CMB_SERVICE_URL',
  'CMB_RATE_LIMIT_SEC',
  'CMB_AUTOPAY_ENABLED',
  'CMB_INTERNAL_TRANSFER_ENABLED',
  'CMB_SYNC_ENABLED',
  'MEITUAN_ENABLED',
  'MEITUAN_MODE',
]
const exampleText = readFileSync(path.join(root, '.env.example'), 'utf8')
const exampleKeys = new Set(
  exampleText
    .split(/\r?\n/)
    .map(line => line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1])
    .filter(Boolean),
)
for (const key of requiredEnvironmentKeys) {
  if (!exampleKeys.has(key)) failures.push(`.env.example is missing ${key}.`)
}

console.log(JSON.stringify({
  node: nodeVersion,
  pnpm: pnpmVersion,
  prisma: expected.prisma,
  migrations: migrations.length,
  environmentContractKeys: exampleKeys.size,
  ok: failures.length === 0,
}, null, 2))

if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
