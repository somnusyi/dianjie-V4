#!/usr/bin/env node
/**
 * 一次性维护脚本: 把误申请到 role='PURCHASER' 的用户修复为正确的 SUPPLIER_OWNER
 *
 * 背景: PURCHASER 是 v2 legacy 别名, 路由到 /v2/manager/home (店长权限).
 * 申请页之前误开放了"采购"选项, 导致供应商误申请 → 拿到店长权限.
 *
 * 修复策略 (业务方确认: 这 8 个都是真实供应商):
 *   1. 给每个 PURCHASER 用户**创建一个临时 Supplier 实体** (name=用户名 + " (临时供应商)", no=自增 SUP###)
 *   2. user.supplierId = newSupplier.id
 *   3. user.role = 'SUPPLIER_OWNER'
 *
 * 后续: 老板可在供应商管理页面修改 Supplier 名称、合并同公司多员工 (把员工 user.supplierId
 *       指到同一个 Supplier).
 *
 * 用法:
 *   node scripts/fix-purchaser-users.js              # dry-run
 *   node scripts/fix-purchaser-users.js --commit     # 执行
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const COMMIT = process.argv.includes('--commit')

function nextNo(maxNoStr) {
  // maxNoStr 形如 "SUP012" 或 null. 输出 "SUP013".
  const n = maxNoStr ? parseInt(maxNoStr.replace(/^SUP/, ''), 10) : 0
  return 'SUP' + String(n + 1).padStart(3, '0')
}

async function main() {
  const users = await prisma.user.findMany({
    where: { role: 'PURCHASER', status: 'ACTIVE' },
    select: { id: true, name: true, phone: true, tenantId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`\n找到 role='PURCHASER' 且 ACTIVE 的用户 ${users.length} 条:\n`)
  console.log('id'.padEnd(28), 'name'.padEnd(12), 'phone'.padEnd(13), 'tenantId')
  console.log('-'.repeat(80))
  for (const u of users) {
    console.log(u.id.padEnd(28), (u.name || '').padEnd(12), (u.phone || '').padEnd(13), u.tenantId)
  }

  if (users.length === 0) { console.log('\n没有需要处理的用户.'); return }

  if (!COMMIT) {
    console.log('\n[DRY-RUN] 加 --commit 才执行更新.')
    console.log('将为每人创建一个临时 Supplier (name="<用户名> (临时供应商)") 并绑定, role 改为 SUPPLIER_OWNER.')
    return
  }

  console.log('\n开始执行更新...\n')

  // 按租户处理, 每个租户独立编号
  const byTenant = users.reduce((m, u) => {
    (m[u.tenantId] = m[u.tenantId] || []).push(u)
    return m
  }, {})

  let totalFixed = 0
  for (const [tenantId, group] of Object.entries(byTenant)) {
    // 该租户当前最大的 SUP 编号
    const lastSup = await prisma.supplier.findFirst({
      where: { tenantId, no: { startsWith: 'SUP' } },
      orderBy: { no: 'desc' },
      select: { no: true },
    })
    let nextSup = nextNo(lastSup?.no)

    for (const u of group) {
      const supplierName = `${u.name} (临时供应商)`
      try {
        await prisma.$transaction(async (tx) => {
          const supplier = await tx.supplier.create({
            data: {
              tenantId,
              no: nextSup,
              name: supplierName,
              contactName: u.name,
              contactPhone: u.phone,
              status: 'ENABLED',
            },
          })
          await tx.user.update({
            where: { id: u.id },
            data: {
              role: 'SUPPLIER_OWNER',
              supplierId: supplier.id,
            },
          })
        })
        console.log(`  ✓ ${u.name} (${u.phone}) → SUPPLIER_OWNER, 绑定 ${nextSup} ${supplierName}`)
        totalFixed++
        nextSup = nextNo(nextSup)
      } catch (e) {
        console.error(`  ✗ ${u.name} (${u.phone}) 失败:`, e.message)
      }
    }

    // 写一条审计日志
    await prisma.opLog.create({
      data: {
        tenantId,
        userId: group[0].id,
        action: `[维护] 批量修复 ${group.length} 个 PURCHASER 用户 → SUPPLIER_OWNER + 创建临时 Supplier`,
        entityType: 'User',
        targetId: group.map(u => u.id).join(','),
      },
    }).catch(e => console.warn('  写审计日志失败:', e.message))
  }

  console.log(`\n✅ 共修复 ${totalFixed} 个用户.`)
  console.log('\n提醒: 同一家公司的多个员工目前各有独立 Supplier 实体.')
  console.log('  老板请去供应商管理页面把同公司员工合并: 编辑保留的 Supplier (改正式公司名),')
  console.log('  把其他员工的 user.supplierId 改指到这个 Supplier (并删多余 Supplier 实体).')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
