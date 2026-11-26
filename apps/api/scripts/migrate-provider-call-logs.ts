// Run only against an explicitly identified environment. Does not load a repository .env.
import { PrismaClient } from '@prisma/client'
import { migrateProviderCallLogs } from '../src/lib/provider-log-migration'

async function main() {
  const args = process.argv.slice(2)
  const execute = args.includes('--execute')
  if (args.some(a => !['--execute', '--expected-endpoint', '--confirm-backup-ready'].includes(a) && args[args.indexOf(a) - 1] !== '--expected-endpoint')) throw Error('Invalid arguments')
  const expected = args[args.indexOf('--expected-endpoint') + 1]
  const url = new URL(process.env.DATABASE_URL || '')
  // Example endpoint is db.internal:5432/database; never includes username or password.
  const actual = `${url.hostname}:${url.port || '5432'}${url.pathname}`
  if (!args.includes('--expected-endpoint') || expected !== actual || (execute && !args.includes('--confirm-backup-ready'))) throw Error('Explicit database identity and verified backup confirmation required')
  const db = new PrismaClient()
  try { console.log(JSON.stringify(await migrateProviderCallLogs(db, { execute }))) }
  finally { await db.$disconnect() }
}
main().catch(() => { console.error('Provider log sanitization refused or failed. No credential values or driver details logged.'); process.exitCode = 1 })
