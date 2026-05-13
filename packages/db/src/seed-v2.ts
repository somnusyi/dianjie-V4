/**
 * v2 账号补丁 — 让登录页 6 角色快捷登录都能用
 * 参考 apps/web/src/app/v2/login/page.tsx 的测试账号列表
 *
 * 运行：
 *   DATABASE_URL=... pnpm tsx src/seed-v2.ts
 */
import { PrismaClient, Role } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()
const hash = (pw: string) => bcrypt.hashSync(pw, 10)
const PWD = 'dj123456'

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: 'dianjie' } })
  if (!tenant) throw new Error('tenant dianjie not found, run base seed first')

  // ── 大行宫店（v2 登录页提到的店）──────────
  const dxg = await prisma.store.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'DJ-DXG' } },
    update: {},
    create: {
      tenantId: tenant.id, no: 'DJ-DXG',
      name: '滇界·南京大行宫店',
      address: '江苏省南京市玄武区大行宫1号',
      managerName: '大行宫店长',
      phone: '13888880001', status: 'ENABLED',
    },
  })

  // 老板·王总（admin 已存在，把 name 改成"王总"以符合 v2 标识）
  await prisma.user.update({
    where: { tenantId_email: { tenantId: tenant.id, email: 'admin@dianjie.com' } },
    data: { name: '王总' },
  }).catch(() => {})

  // 财务·刘
  await prisma.user.update({
    where: { tenantId_email: { tenantId: tenant.id, email: 'finance@dianjie.com' } },
    data: { name: '刘财务' },
  }).catch(() => {})

  // 店长·大行宫
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'dqg@dianjie.com' } },
    update: { storeId: dxg.id, role: Role.MANAGER, name: '大行宫店长' },
    create: {
      tenantId: tenant.id, name: '大行宫店长', email: 'dqg@dianjie.com',
      password: hash(PWD), role: Role.MANAGER, storeId: dxg.id,
    },
  })

  // 厨师长·王凯（KITCHEN_LEAD，单店级）
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'chef@dianjie.com' } },
    update: { role: Role.KITCHEN_LEAD, storeId: dxg.id, name: '王凯' },
    create: {
      tenantId: tenant.id, name: '王凯', email: 'chef@dianjie.com',
      password: hash(PWD), role: Role.KITCHEN_LEAD, storeId: dxg.id,
    },
  })

  // 总厨·黄辉（CHEF_DIRECTOR，集团级）
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'zc001@dianjie.com' } },
    update: { role: Role.CHEF_DIRECTOR, name: '黄辉' },
    create: {
      tenantId: tenant.id, name: '黄辉', email: 'zc001@dianjie.com',
      password: hash(PWD), role: Role.CHEF_DIRECTOR,
    },
  })

  // 供应商·武胖子（SUPPLIER_OWNER，要先有一个 supplier 实体）
  const sup = await prisma.supplier.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'SUP-WPZ' } },
    update: {},
    create: {
      tenantId: tenant.id, no: 'SUP-WPZ', name: '武胖子海鲜',
      contactName: '武胖子', contactPhone: '13888880002',
    },
  })
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'supplier@dianjie.com' } },
    update: { role: Role.SUPPLIER_OWNER, supplierId: sup.id, name: '武胖子' },
    create: {
      tenantId: tenant.id, name: '武胖子', email: 'supplier@dianjie.com',
      password: hash(PWD), role: Role.SUPPLIER_OWNER, supplierId: sup.id,
    },
  })

  console.log('✅ v2 账号已就绪（6 角色 dj123456）')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
