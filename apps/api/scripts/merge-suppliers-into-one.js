#!/usr/bin/env node
/**
 * 一次性维护脚本: 把 SUP001-SUP008 (8 个临时供应商) 合并成 1 个真实供应商.
 *
 * 业务方提供:
 *   公司名: 南京捌拾捌号餐饮管理有限公司
 *   类别:   全类目
 *   联系人: 武艺
 *   联系电话: 13801595365
 *   账期:   30 天
 *   银行:   南京捌拾捌号餐饮管理有限公司 / 南京银行水西门支行 / 0140260000001991
 *   Owner:  武艺 (其余 7 人改 SUPPLIER_STAFF)
 *
 * 用法:
 *   node scripts/merge-suppliers-into-one.js              # dry-run
 *   node scripts/merge-suppliers-into-one.js --commit     # 执行
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const COMMIT = process.argv.includes('--commit')

const COMPANY = {
  name:            '南京捌拾捌号餐饮管理有限公司',
  category:        '全类目',
  contactName:     '武艺',
  contactPhone:    '13801595365',
  creditDays:      30,
  bankAccountName: '南京捌拾捌号餐饮管理有限公司',
  bankName:        '南京银行水西门支行',
  bankAccount:     '0140260000001991',
}
const OWNER_PHONE = '13801595365'  // 武艺 → SUPPLIER_OWNER

async function main() {
  // 找出所有以 SUP 开头且 name 含 "(临时供应商)" 的占位 Supplier
  const placeholders = await prisma.supplier.findMany({
    where: {
      no: { startsWith: 'SUP' },
      name: { contains: '(临时供应商)' },
    },
    orderBy: { no: 'asc' },
  })

  if (placeholders.length === 0) {
    console.log('没有找到占位 Supplier (SUP*** 临时供应商).')
    return
  }

  // 取第一个 (SUP001) 作为保留, 其余删除
  const keep = placeholders[0]
  const drop = placeholders.slice(1)
  const tenantId = keep.tenantId

  console.log(`\n占位 Supplier 共 ${placeholders.length} 个:`)
  for (const s of placeholders) console.log(`  ${s.no}  ${s.name}  (id=${s.id})`)
  console.log(`\n→ 保留: ${keep.no} (将更新为真实公司信息)`)
  console.log(`→ 删除: ${drop.map(s => s.no).join(', ')}`)

  // 关联到这些 Supplier 的所有用户
  const users = await prisma.user.findMany({
    where: { supplierId: { in: placeholders.map(s => s.id) } },
    select: { id: true, name: true, phone: true, role: true, supplierId: true },
  })
  console.log(`\n关联用户 ${users.length} 个 (将全部 supplierId → ${keep.no}):`)
  for (const u of users) {
    const willBeOwner = u.phone === OWNER_PHONE
    console.log(`  ${u.name.padEnd(8)} ${u.phone.padEnd(13)} → role=${willBeOwner ? 'SUPPLIER_OWNER (Owner)' : 'SUPPLIER_STAFF'}`)
  }

  if (!COMMIT) {
    console.log('\n[DRY-RUN] 加 --commit 执行更新.')
    return
  }

  console.log('\n开始执行...\n')

  await prisma.$transaction(async (tx) => {
    // 1. 更新 SUP001 为真实公司信息
    await tx.supplier.update({
      where: { id: keep.id },
      data: {
        name:            COMPANY.name,
        category:        COMPANY.category,
        contactName:     COMPANY.contactName,
        contactPhone:    COMPANY.contactPhone,
        creditDays:      COMPANY.creditDays,
        bankAccountName: COMPANY.bankAccountName,
        bankName:        COMPANY.bankName,
        bankAccount:     COMPANY.bankAccount,
      },
    })
    console.log(`  ✓ ${keep.no} 已更新为 "${COMPANY.name}"`)

    // 2. 全部用户 supplierId → keep.id, 角色按 phone 分配
    for (const u of users) {
      const newRole = u.phone === OWNER_PHONE ? 'SUPPLIER_OWNER' : 'SUPPLIER_STAFF'
      await tx.user.update({
        where: { id: u.id },
        data: { supplierId: keep.id, role: newRole },
      })
      console.log(`  ✓ ${u.name} → role=${newRole}, supplierId=${keep.no}`)
    }

    // 3. 删除多余 Supplier
    if (drop.length > 0) {
      const r = await tx.supplier.deleteMany({ where: { id: { in: drop.map(s => s.id) } } })
      console.log(`  ✓ 删除 ${r.count} 个多余占位 Supplier (${drop.map(s => s.no).join(', ')})`)
    }

    // 4. 审计日志
    await tx.opLog.create({
      data: {
        tenantId,
        userId: users[0].id,
        action: `[维护] 合并 ${placeholders.length} 个占位 Supplier 为 "${COMPANY.name}", 涉及 ${users.length} 个员工 (Owner=${OWNER_PHONE})`,
        entityType: 'Supplier',
        targetId: keep.id,
      },
    })
  })

  console.log('\n✅ 合并完成.')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
