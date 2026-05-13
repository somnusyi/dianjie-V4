#!/usr/bin/env node
/**
 * 用 5.12系统库存.xlsx 为基准, 按 name 匹配 DB 中 SUP001 的 SKU,
 * 更新 stock 数字 + 写一条 INITIAL 流水.
 *
 * 用法:
 *   node scripts/sync-stock-from-snapshot.js                # dry-run
 *   node scripts/sync-stock-from-snapshot.js --commit       # 真改
 *
 * 仅在 ECS 上执行.
 */

const { PrismaClient } = require('@prisma/client')
const fs = require('fs')

const COMMIT = process.argv.includes('--commit')
const JSON_FILE = '/tmp/stock-snapshot.json'  // 本地预先 Excel → JSON
const OPERATOR_PHONE = '13900000003'  // 老板账号 (审计 opLog 用)

const prisma = new PrismaClient()

async function main() {
  const snapshot = JSON.parse(fs.readFileSync(JSON_FILE, 'utf-8'))
  console.log(`📋 JSON 读到 ${snapshot.length} 行`)

  // 2. 找 SUP001 + 操作人
  const sup = await prisma.supplier.findFirst({ where: { no: 'SUP001' } })
  if (!sup) throw new Error('SUP001 未找到')
  const operator = await prisma.user.findFirst({ where: { phone: OPERATOR_PHONE, tenantId: sup.tenantId } })
  if (!operator) throw new Error(`操作人 ${OPERATOR_PHONE} 未找到`)

  // 3. 拉所有现有 SKU (按 name 索引)
  const products = await prisma.product.findMany({
    where: { supplierId: sup.id, tenantId: sup.tenantId },
    select: { id: true, name: true, stock: true },
  })
  const byName = new Map(products.map(p => [p.name, p]))
  console.log(`📦 DB 现有 ${products.length} 个 SKU`)

  // 4. 分类
  const matched = []
  const noMatch = []
  for (const row of snapshot) {
    const p = byName.get(row.name)
    if (p) matched.push({ ...row, productId: p.id, currentStock: Number(p.stock) })
    else noMatch.push(row)
  }
  const willChange = matched.filter(m => Math.abs(m.currentStock - m.qty) > 0.001)
  const noChange = matched.filter(m => Math.abs(m.currentStock - m.qty) < 0.001)
  console.log(`\n📊 匹配情况:`)
  console.log(`  匹配成功 ${matched.length} 个 (其中需更新 ${willChange.length}, 已是目标值 ${noChange.length})`)
  console.log(`  Excel 有但 DB 无 ${noMatch.length} 个 (会被跳过, 别上传 5.12 系统库存创建新 SKU)`)
  if (noMatch.length > 0) {
    console.log(`  示例: ${noMatch.slice(0, 3).map(r => r.name).join(', ')}...`)
  }

  if (!COMMIT) {
    console.log('\n[DRY-RUN] 加 --commit 执行更新')
    console.log('需更新前 5 条:')
    willChange.slice(0, 5).forEach(m => console.log(`  ${m.name.padEnd(30)} ${m.currentStock} → ${m.qty}`))
    return
  }

  // 5. 真改
  console.log('\n开始执行...')
  let okCount = 0
  for (const m of willChange) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.product.update({ where: { id: m.productId }, data: { stock: m.qty } })
        await tx.supplierStockMovement.create({
          data: {
            tenantId: sup.tenantId, supplierId: sup.id, productId: m.productId,
            delta: m.qty - m.currentStock, balanceAfter: m.qty,
            type: 'INITIAL',
            reason: '从 5.12系统库存.xlsx 同步',
            sourceType: 'Snapshot', sourceId: null,
            createdById: operator.id,
          },
        })
      })
      okCount++
    } catch (e) {
      console.error(`✗ ${m.name}:`, e.message)
    }
  }

  // 6. 审计
  await prisma.opLog.create({
    data: {
      tenantId: sup.tenantId, userId: operator.id,
      action: `[维护] 用 5.12系统库存 同步 ${okCount} 条 SKU 库存; ${noMatch.length} 条因 DB 无对应 SKU 跳过`,
      entityType: 'Product', targetId: sup.id,
    },
  })
  console.log(`\n✅ 同步完成: 成功 ${okCount} 条, 跳过 ${noMatch.length}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
