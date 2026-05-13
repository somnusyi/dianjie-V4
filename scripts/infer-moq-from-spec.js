#!/usr/bin/env node
/**
 * 从 product.spec 字符串里推断起订量 / 步长.
 *
 * 规则 (优先级从上到下):
 *   "10袋/箱"     → minOrderQty=10, stepQty=10  (整箱起售)
 *   "24瓶*330ml/件" → minOrderQty=24, stepQty=24
 *   "5kg/袋"      → 不动 (单位是 袋, 不是按瓶卖)
 *   "1*10"        → minOrderQty=10, stepQty=10
 *
 * 用法:
 *   node scripts/infer-moq-from-spec.js              # dry-run 看打印
 *   node scripts/infer-moq-from-spec.js --commit     # 真改
 */
try { require('dotenv').config({ path: require('path').resolve(__dirname, '../apps/api/.env') }) } catch {}
try { if (!process.env.DATABASE_URL) require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') }) } catch {}
const { PrismaClient } = require('@prisma/client')
const COMMIT = process.argv.includes('--commit')
const prisma = new PrismaClient()

// 提取 spec 里 "数字+(瓶|袋|包|盒|罐|支|杯|片|个)" 形式的 N
function inferQty(spec) {
  if (!spec) return null
  // 形如 "10袋/箱" / "24瓶*330ml/件" / "12包/箱"
  const m1 = spec.match(/(\d+)\s*(?:瓶|袋|包|盒|罐|支|杯|片|个)\s*[*x×/]/)
  if (m1) return parseInt(m1[1], 10)
  // "1*10" / "1×10" 默认右侧 = 整箱数量
  const m2 = spec.match(/^\s*1\s*[*x×]\s*(\d+)\s*$/)
  if (m2) return parseInt(m2[1], 10)
  return null
}

async function main() {
  const all = await prisma.product.findMany({
    where: { spec: { not: null } },
    select: { id: true, name: true, spec: true, unit: true, minOrderQty: true, stepQty: true },
  })
  const updates = []
  for (const p of all) {
    const q = inferQty(p.spec)
    if (!q || q <= 1) continue
    if (Number(p.minOrderQty) === q && Number(p.stepQty) === q) continue
    updates.push({ ...p, newQty: q })
  }
  console.log(`📦 总 ${all.length}, 推断出起订量的 ${updates.length}`)
  console.log('前 20 条:')
  updates.slice(0, 20).forEach(u =>
    console.log(`  ${u.name.padEnd(28)} spec=${(u.spec||'').padEnd(20)} → ${u.newQty}`)
  )
  if (!COMMIT) {
    console.log('\n[DRY-RUN] 加 --commit 执行更新')
    return
  }
  for (const u of updates) {
    await prisma.product.update({
      where: { id: u.id },
      data: { minOrderQty: u.newQty, stepQty: u.newQty },
    })
  }
  console.log(`\n✅ 已更新 ${updates.length} 条`)
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
