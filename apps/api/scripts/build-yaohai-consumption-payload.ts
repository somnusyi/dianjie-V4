/** Build the reviewed 2026-07-14/15 Yaohai BOM-consumption payload. */
import fs from 'node:fs/promises'
import { convertBomUsageToProductUnit } from '../src/services/inventoryUnits'

type Product = { id: string; code: string; name: string; spec: string | null; unit: string }
type Stage = {
  dailyIngredientUsage: Array<{ date: string; ingredient: string; bomUnit: string; grossUsage: number }>
  ingredientCandidates: Array<{ ingredient: string; candidates: Array<{ score: number; productId: string | null; linked: boolean }> }>
  variants: Array<{ date: string; name: string; quantity: number; directPolicy: null | { policy: string; target?: string } }>
}

const REVIEWED_ALIASES: Record<string, string> = {
  'X-冷冻水蜜桃酱（春日桃桃用': '冷冻水蜜桃酱',
  'X-冷冻茉香奶绿（果汁包）': '冷冻茉莉奶绿（果汁包）',
  'X-常温酸奶（夏日桃桃用）': '常温酸奶',
  'X-木姜子香辣蘸（定制）': '木姜子香辣蘸料·滇界定制',
  'X-汤底调味粉（定制）': '汤底调味粉·滇界定制',
  'X-火锅专用红油(定制）': '火锅专用红油·滇界定制',
  'X-甄选马蹄爆珠': '甄选马蹄爆爆珠',
  'X-白米线.1.6mm-定制': '白米线·滇界定制1.6mm',
  'X-秘制底料（定制）': '秘制底料·滇界定制',
  'X-胡辣椒': '糊辣椒',
  'X-酸萝卜丝.富源酸菜': '酸萝卜丝·富源酸菜',
  'X-黑皮鸡纵': '黑皮鸡枞菌',
  'X调味糖浆': '冰糖糖浆',
  '冰淇淋球': '光明冰淇淋',
  '冰淇球': '光明冰淇淋',
  '冰糖浆': '冰糖糖浆',
  '糖浆': '冰糖糖浆',
  '冷冻柳橙汁': '冷冻香橙汁',
  '冷冻草莓果': '冷冻红颜草莓肉',
  '奇异果茸': '奇异果果茸',
  '生抽': '金标生抽',
  '粉色棉花糖': '棉花糖',
  '茉莉绿茶': 'SevenQ茉莉绿茶',
  '马蹄爆珠': '马蹄爆爆珠',
}

const DIRECT: Record<string, { product: string; unit: string; perSale: number; note: string }> = {
  '武定跑山鸡': { product: '清远鸡盒装', unit: '盒', perSale: 1, note: '鲜冻可替代，本轮优先扣7月13日鲜鸡盘点' },
  '东川三色面': { product: '东川三色面·滇界定制', unit: '袋', perSale: 1, note: '每份按1袋' },
  '见手青啤酒': { product: '见手青啤酒', unit: '瓶', perSale: 1, note: '每份按1瓶' },
  '雪碧摩登罐': { product: '雪碧摩登罐', unit: '罐', perSale: 1, note: '每份按1罐' },
  '赠（炸黄粉皮）': { product: '黄粉皮', unit: 'g', perSale: 32, note: '用户确认每份32g' },
  '赠（鲜花饼/个）': { product: '烤制鲜花饼', unit: '枚', perSale: 1, note: '每份赠品按1枚' },
  '赠【冰淇淋】': { product: '光明冰淇淋', unit: 'g', perSale: 50, note: '用户确认每份50g' },
}

function normalize(value: string) {
  return value.normalize('NFKC').replace(/^x-/i, '').replace(/[\s·・（）()【】\-/]/g, '').toLowerCase()
}

async function main() {
  const [stagePath, productPath, outputPath] = process.argv.slice(2)
  if (!stagePath || !productPath || !outputPath) throw new Error('参数: trial_stage.json prod_export.json output.json')
  const stage = JSON.parse(await fs.readFile(stagePath, 'utf8')) as Stage
  const exported = JSON.parse(await fs.readFile(productPath, 'utf8')) as { products: Product[] }
  const byId = new Map(exported.products.map(product => [product.id, product]))
  const byName = new Map(exported.products.map(product => [normalize(product.name), product]))
  const candidateByIngredient = new Map(stage.ingredientCandidates.map(row => [row.ingredient, row]))
  const usage = new Map<string, { date: string; product: Product; quantity: number; sources: string[] }>()
  const skipped: Array<{ date?: string; source: string; quantity: number; reason: string }> = []

  function add(date: string, source: string, quantity: number, sourceUnit: string, product: Product, note?: string) {
    const converted = convertBomUsageToProductUnit({ quantity, bomUnit: sourceUnit, productUnit: product.unit, productSpec: product.spec })
    if (converted.status === 'PENDING' || converted.normalizedQuantity == null) {
      skipped.push({ date, source, quantity, reason: converted.note })
      return
    }
    const key = `${date}|${product.id}`
    const current = usage.get(key) || { date, product, quantity: 0, sources: [] }
    current.quantity += converted.normalizedQuantity
    current.sources.push(`${source} ${quantity}${sourceUnit}${note ? ` (${note})` : ''}`)
    usage.set(key, current)
  }

  for (const row of stage.dailyIngredientUsage) {
    const candidate = candidateByIngredient.get(row.ingredient)?.candidates[0]
    let product = candidate && candidate.score >= 1.19 && candidate.linked && candidate.productId
      ? byId.get(candidate.productId)
      : undefined
    if (!product && REVIEWED_ALIASES[row.ingredient]) product = byName.get(normalize(REVIEWED_ALIASES[row.ingredient]))
    if (!product) {
      skipped.push({ date: row.date, source: row.ingredient, quantity: row.grossUsage, reason: '未通过高可信SKU映射审核' })
      continue
    }
    add(row.date, row.ingredient, row.grossUsage, row.bomUnit, product)
  }

  for (const row of stage.variants.filter(row => row.directPolicy)) {
    if (row.directPolicy?.policy === 'exclude') {
      skipped.push({ date: row.date, source: row.name, quantity: row.quantity, reason: '用户确认本轮不扣库存' })
      continue
    }
    const rule = DIRECT[row.name]
    if (!rule) {
      skipped.push({ date: row.date, source: row.name, quantity: row.quantity, reason: '直接商品映射或单份用量待确认' })
      continue
    }
    const product = byName.get(normalize(rule.product))
    if (!product) {
      skipped.push({ date: row.date, source: row.name, quantity: row.quantity, reason: `商品不存在: ${rule.product}` })
      continue
    }
    add(row.date, row.name, row.quantity * rule.perSale, rule.unit, product, rule.note)
  }

  const rows = [...usage.values()].sort((a, b) => a.date.localeCompare(b.date) || a.product.name.localeCompare(b.product.name, 'zh-CN')).map(row => ({
    date: row.date,
    sourceId: `meituan-bom:${row.date}:v1`,
    productId: row.product.id,
    productCode: row.product.code,
    productName: row.product.name,
    quantity: Math.round(row.quantity * 1_000_000) / 1_000_000,
    unit: row.product.unit,
    note: `美团销量×毛重BOM；${row.sources.join('；')}`.slice(0, 1000),
  }))
  const payload = {
    version: 1, tenantSlug: 'dianjie', targetStoreNo: 'DJ001', sourceType: 'bom_import', rows, skipped,
    audit: {
      policies: ['BOM按毛重', '退菜不补库存', '百家蘸料不扣', '鲜冻可替代并优先鲜鸡', '黄粉皮赠品32g', '冰淇淋赠品50g'],
      mappedProducts: new Set(rows.map(row => row.productId)).size,
      skippedRows: skipped.length,
    },
  }
  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2) + '\n')
  console.log(JSON.stringify({ outputPath, rows: rows.length, products: payload.audit.mappedProducts, skipped: skipped.length }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
