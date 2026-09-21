import 'dotenv/config'
import { prisma } from '@dianjie/db'
import { recordManualWarehouseInbound } from '../src/services/warehouseLedger'

async function main() {
  const url = new URL(process.env.DATABASE_URL || '')
  if (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.endsWith('_test') || process.env.REPORT_PREVIEW_SEED !== 'LOCAL_REPORTS') throw new Error('仅允许显式确认后的本地 _test 数据库')
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'supply-chain-uat' } })
  const user = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: 'SUPPLY_CHAIN' } })
  const product = await prisma.product.findUniqueOrThrow({ where: { tenantId_code: { tenantId: tenant.id, code: 'UAT-SKU-001' } } })
  const store = await prisma.store.upsert({ where: { tenantId_no: { tenantId: tenant.id, no: 'REPORT-STORE-02' } }, update: {}, create: { tenantId: tenant.id, no: 'REPORT-STORE-02', name: '本地报表测试门店 B', status: 'ENABLED' } })
  await recordManualWarehouseInbound({ tenantId: tenant.id, userId: user.id, productId: product.id, purchaseQuantity: 10, totalAmount: 1000, effectiveAt: new Date(), idempotencyKey: 'local-report-preview-inbound-v1', note: '本地报表联调种子入库（非线上数据）' })
  console.log(JSON.stringify({ seeded: true, store: store.name, product: product.name }))
}
main().finally(() => prisma.$disconnect()).catch(e => { console.error(e); process.exitCode = 1 })
