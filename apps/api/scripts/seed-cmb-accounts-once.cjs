// 一次性 seed: 把硬编码的两条招行实时账户写到 dianjie + test 两个 tenant 的 cash_accounts 表
// 跑完该脚本可以删除 (idempotent, 重跑也安全)
//
// 服务器跑:
//   cd /app/dianjie-v4 && node apps/api/scripts/seed-cmb-accounts-once.cjs
//
// 本地 dev DB:
//   cd ~/Desktop/dianjie-V4/dianjie-V4 && \
//     DATABASE_URL='postgresql://reedom@localhost:5432/dianjie_v4_dev' \
//     node apps/api/scripts/seed-cmb-accounts-once.cjs

const path = require('path')
require('dotenv').config({
  path: process.env.DOTENV_PATH || path.resolve(process.cwd(), '.env'),
})
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL 没读到 (cwd .env 或 DOTENV_PATH)')
  process.exit(1)
}

// 直接用 @prisma/client (避开 @dianjie/db 的 .ts entry, cjs require 不动)
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const ENTRIES = [
  {
    name:           '南京云洱之境餐饮有限公司',   // 大标题 (户名)
    bankName:       '招商银行南京城东支行',
    accountNo:      '125925235910001',          // 用于显示尾号 0001
    note:           '一般户',                   // 显示在徽章旁
    cmbBindAccount: '125925235910001',          // 走 cmb 微服务拉余额
  },
  {
    name:           '合肥云岳之境餐饮有限公司',
    bankName:       '招商银行南京城东支行',
    accountNo:      '125925610910001',
    note:           '一般户',
    cmbBindAccount: '125925610910001',
  },
]

async function main() {
  for (const slug of ['dianjie', 'test']) {
    const tenant = await prisma.tenant.findUnique({ where: { slug } })
    if (!tenant) {
      console.log(`⚠ tenant ${slug} 不存在, 跳过`)
      continue
    }
    console.log(`\n=== tenant ${slug} (${tenant.id}) ===`)
    for (const entry of ENTRIES) {
      const existed = await prisma.cashAccount.findFirst({
        where: { tenantId: tenant.id, cmbBindAccount: entry.cmbBindAccount },
      })
      if (existed) {
        console.log(`  ✓ ${entry.cmbBindAccount} 已存在 (id=${existed.id.slice(0, 8)}…), 跳过`)
        continue
      }
      const created = await prisma.cashAccount.create({
        data: {
          tenantId: tenant.id,
          type:     'BANK',
          balance:  0,
          status:   'ACTIVE',
          ...entry,
        },
      })
      console.log(`  ✓ ${entry.cmbBindAccount} 已创建 (${created.id.slice(0, 8)}…)`)
    }
  }
  console.log('\n✅ seed 完成')
}

main()
  .catch(e => { console.error('❌', e.message || e); process.exit(1) })
  .finally(() => prisma.$disconnect())
