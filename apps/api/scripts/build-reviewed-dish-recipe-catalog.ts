/** Convert the reviewed BOM workbook staging output into a portable recipe catalog. */
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { convertBomUsageToProductUnit } from '../src/services/inventoryUnits'
import { normalizeVariantKey } from '../src/services/dailyBusinessImport'

type Product = { id: string; code: string; name: string; spec: string | null; unit: string }
type RawRule = {
  dishName: string
  spec: string
  policy: 'BOM' | 'DIRECT' | 'EXCLUDE'
  target?: string
  bomName?: string
  note?: string | null
  items: Array<{ ingredient: string; quantity: number; unit: string; sheet: string; row: number }>
}
type Candidate = { ingredient: string; candidates: Array<{ score: number; productId: string | null; linked: boolean }> }

const REVIEWED_ALIASES: Record<string, string> = {
  'X-云南豆腐皮豆皮': '云南豆腐皮',
  'X-保乐肩保乐肩': '保乐肩（M2安格斯）',
  'X-傣味舂鸡爪酱（定制）': '傣味春鸡爪酱',
  'X-冷冻水蜜桃酱（春日桃桃用': '冷冻水蜜桃酱',
  'X-冷冻茉香奶绿（果汁包）': '冷冻茉莉奶绿（果汁包）',
  'X-常温酸奶（夏日桃桃用）': '常温酸奶',
  'X-开心果酱（夏日桃桃用）': '开心果酱',
  'X-吊龙切片吊龙': '吊龙切片A（吊龙前段）',
  'X-木姜子香辣蘸（定制）': '木姜子香辣蘸料·滇界定制',
  'X-汤底调味粉（定制）': '汤底调味粉·滇界定制',
  'X-火锅专用红油(定制）': '火锅专用红油·滇界定制',
  'X-焖饭汁(定制）': '焖饭汁·滇界专用',
  'X-爆浆豆腐（小）': '石屏包浆豆腐（小）',
  'X-甄选马蹄爆珠': '马蹄爆爆珠',
  'X-白米线.1.6mm-定制': '白米线·滇界定制1.6mm',
  'X-秘制底料（定制）': '秘制底料·滇界定制',
  'X-胡辣椒': '糊辣椒',
  'X-清远鸡/真空包装': '清远鸡盒装',
  'X-灰虎掌': '人工灰虎掌',
  'X-酸萝卜丝.富源酸菜': '酸萝卜丝·富源酸菜',
  'X-黑皮鸡纵': '黑皮鸡枞菌',
  'X调味糖浆': '调味糖浆（冰糖糖浆）',
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
  '石屏包浆豆腐': { product: '炸小包浆豆腐·滇界定制', unit: 'g', perSale: 140, note: '利润表毛重每份140g' },
  '武定跑山鸡': { product: '清远鸡盒装', unit: '盒', perSale: 1, note: '鲜冻可替代，本规则优先扣清远鸡盒装' },
  '见手青啤酒': { product: '见手青啤酒', unit: '瓶', perSale: 1, note: '每份1瓶' },
  '东川三色面': { product: '东川三色面·滇界定制', unit: '袋', perSale: 1, note: '每份1袋' },
  '赠（炸黄粉皮）': { product: '黄粉皮', unit: 'g', perSale: 32, note: '用户确认每份32g' },
  '赠（鲜花饼/个）': { product: '烤制鲜花饼', unit: '枚', perSale: 1, note: '用户确认每份1枚' },
  '雪碧摩登罐': { product: '雪碧摩登罐', unit: '罐', perSale: 1, note: '每份1罐' },
  '赠【冰淇淋】': { product: '光明冰淇淋', unit: 'g', perSale: 50, note: '用户确认每份50g' },
}

function normalize(value: string) {
  return String(value || '').normalize('NFKC').replace(/^x-/i, '').replace(/[\s·•・|（）()【】\-/]/g, '').toLowerCase()
}

function pendingProductCode(ingredient: string, unit: string) {
  return `DJ-BOM-${crypto.createHash('sha1').update(`${ingredient}\u0000${unit}`).digest('hex').slice(0, 10).toUpperCase()}`
}

function pendingProductName(ingredient: string) {
  return ingredient.normalize('NFKC').replace(/^x-/i, '').trim().slice(0, 100)
}

function reviewedBomItem(item: RawRule['items'][number]) {
  if (item.ingredient === 'X-清远鸡/真空包装' && item.quantity === 1) {
    return { ...item, unit: '盒', reviewNote: '原表成本13.5元，对应清远鸡1盒，不按克解释' }
  }
  if (item.ingredient === '鸡蛋' && item.quantity <= 2) {
    return { ...item, unit: '个', reviewNote: '原表单价及成本对应整蛋计数' }
  }
  if (item.ingredient === '酒精块' && item.quantity <= 2) {
    return { ...item, unit: '个', reviewNote: '原表净用量明确标注1个' }
  }
  return { ...item, reviewNote: null }
}

async function main() {
  const [rawPath, stagePath, productPath, outputPath] = process.argv.slice(2)
  if (!rawPath || !stagePath || !productPath || !outputPath) {
    throw new Error('参数: raw_recipe_catalog.json trial_stage.json prod_export.json output.json')
  }
  const raw = JSON.parse(await fs.readFile(rawPath, 'utf8')) as { version: number; rules: RawRule[] }
  const stage = JSON.parse(await fs.readFile(stagePath, 'utf8')) as { ingredientCandidates: Candidate[] }
  const exported = JSON.parse(await fs.readFile(productPath, 'utf8')) as { products: Product[] }
  const byId = new Map(exported.products.map(product => [product.id, product]))
  const byName = new Map(exported.products.map(product => [normalize(product.name), product]))
  const candidates = new Map(stage.ingredientCandidates.map(row => [row.ingredient, row]))
  const pendingProducts = new Map<string, { code: string; name: string; unit: string; category: string; spec: null }>()
  const warnings: string[] = []

  function existingProductFor(ingredient: string) {
    const alias = REVIEWED_ALIASES[ingredient]
    if (alias) return byName.get(normalize(alias))
    const top = candidates.get(ingredient)?.candidates[0]
    if (top && top.score >= 0.7 && top.linked && top.productId) return byId.get(top.productId)
    return undefined
  }

  function itemFor(ingredient: string, quantity: number, unit: string, context: string) {
    const product = existingProductFor(ingredient)
    if (product) {
      const converted = convertBomUsageToProductUnit({ quantity, bomUnit: unit, productUnit: product.unit, productSpec: product.spec })
      if (converted.status !== 'PENDING' && converted.normalizedQuantity != null && converted.normalizedQuantity > 0) {
        return {
          productCode: product.code, productName: product.name, productUnit: product.unit,
          quantity: Math.round(converted.normalizedQuantity * 1_000_000) / 1_000_000,
          rawIngredient: ingredient, rawQuantity: quantity, rawUnit: unit, note: `${context}；${converted.note}`,
        }
      }
      warnings.push(`${ingredient}: ${converted.note}，改用BOM原始单位独立SKU`)
    }
    const code = pendingProductCode(ingredient, unit)
    const productName = pendingProductName(ingredient)
    pendingProducts.set(code, { code, name: productName, unit, category: 'BOM待采购映射', spec: null })
    return {
      productCode: code, productName, productUnit: unit,
      quantity: Math.round(quantity * 1_000_000) / 1_000_000,
      rawIngredient: ingredient, rawQuantity: quantity, rawUnit: unit,
      note: `${context}；暂无可靠采购SKU，先按BOM原单位建档，后续可归并`,
    }
  }

  const rules = raw.rules.map(rule => {
    if (rule.policy === 'EXCLUDE') return { ...rule, variantKey: normalizeVariantKey(rule.spec), items: [] }
    if (rule.policy === 'DIRECT') {
      const direct = DIRECT[rule.dishName]
      if (!direct) {
        return { ...rule, policy: 'PENDING', variantKey: normalizeVariantKey(rule.spec), items: [], note: `${rule.note || ''}；单份用量待确认` }
      }
      const product = byName.get(normalize(direct.product))
      if (!product) throw new Error(`直接扣减商品不存在: ${rule.dishName} → ${direct.product}`)
      const converted = convertBomUsageToProductUnit({ quantity: direct.perSale, bomUnit: direct.unit, productUnit: product.unit, productSpec: product.spec })
      if (converted.status === 'PENDING' || converted.normalizedQuantity == null) {
        throw new Error(`直接扣减无法换算: ${rule.dishName}: ${converted.note}`)
      }
      return {
        ...rule, policy: 'BOM', variantKey: normalizeVariantKey(rule.spec),
        note: direct.note,
        items: [{
          productCode: product.code, productName: product.name, productUnit: product.unit,
          quantity: Math.round(converted.normalizedQuantity * 1_000_000) / 1_000_000,
          rawIngredient: rule.target || rule.dishName, rawQuantity: direct.perSale, rawUnit: direct.unit,
          note: `${direct.note}；${converted.note}`,
        }],
      }
    }
    const grouped = new Map<string, ReturnType<typeof itemFor>>()
    for (const item of rule.items) {
      if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
        warnings.push(`${rule.dishName}: ${item.ingredient} 毛重为 ${item.quantity}，已忽略零用量行`)
        continue
      }
      const reviewed = reviewedBomItem(item)
      const context = `${item.sheet} 第${item.row}行，按毛重${reviewed.reviewNote ? `；${reviewed.reviewNote}` : ''}`
      const resolved = itemFor(reviewed.ingredient, reviewed.quantity, reviewed.unit, context)
      const current = grouped.get(resolved.productCode)
      if (current) {
        current.quantity = Math.round((current.quantity + resolved.quantity) * 1_000_000) / 1_000_000
        current.note += `；${resolved.note}`
      } else grouped.set(resolved.productCode, resolved)
    }
    return { ...rule, variantKey: normalizeVariantKey(rule.spec), items: [...grouped.values()] }
  })
  const keySet = new Set<string>()
  for (const rule of rules) {
    const key = `${normalize(rule.dishName)}\u0000${rule.variantKey}`
    if (keySet.has(key)) throw new Error(`菜品规格规则重复: ${rule.dishName} ${rule.spec}`)
    keySet.add(key)
  }
  const payload = {
    version: 1,
    tenantSlug: 'dianjie',
    source: '滇界菜品利润分析表（用户确认毛重口径）',
    policies: ['BOM按毛重', '退菜不补库存', '百家蘸料不扣', '鲜冻可替代并优先鲜鸡', '赠品直接扣库存'],
    productsToCreate: [...pendingProducts.values()].sort((a, b) => a.code.localeCompare(b.code)),
    rules,
    audit: {
      rules: rules.length,
      activeRules: rules.filter(rule => rule.policy === 'BOM' || rule.policy === 'EXCLUDE').length,
      pendingRules: rules.filter(rule => rule.policy === 'PENDING').map(rule => `${rule.dishName}${rule.spec ? `(${rule.spec})` : ''}`),
      recipeItems: rules.reduce((sum, rule) => sum + rule.items.length, 0),
      existingProductItems: rules.reduce((sum, rule) => sum + rule.items.filter((item: any) => !pendingProducts.has(item.productCode)).length, 0),
      pendingProductItems: rules.reduce((sum, rule) => sum + rule.items.filter((item: any) => pendingProducts.has(item.productCode)).length, 0),
      productsToCreate: pendingProducts.size,
      conversionWarnings: [...new Set(warnings)],
    },
  }
  await fs.mkdir(outputPath.slice(0, outputPath.lastIndexOf('/')), { recursive: true })
  await fs.writeFile(outputPath, JSON.stringify(payload, null, 2) + '\n')
  console.log(JSON.stringify({ outputPath, ...payload.audit }, null, 2))
}

main().catch(error => { console.error(error); process.exit(1) })
