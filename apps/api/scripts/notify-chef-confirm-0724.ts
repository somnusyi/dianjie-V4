/**
 * 一次性：向总厨（梁厨）推送「盘点差异根因 · 配方与主数据确认单」
 * 背景：7.22 盘点差异分析定位的待确认项，一次性收回
 * 用法: npx tsx scripts/notify-chef-confirm-0724.ts   (服务器 apps/api 目录下)
 */
import 'dotenv/config'
import { prisma } from '@dianjie/db'
import { notify } from '../src/services/notify'

async function main() {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: 'dianjie' } })

  const summary =
    '【配方克数·急】①脆爽黄喉现 1396g/份，应为 139.6g？（多扣10倍）' +
    '②汤底调味粉账面消耗是销量4.8倍，现配方克数疑似偏小' +
    '③大米龙2.4倍 ④白葱/紫葱1.9倍 ⑤腊火腿1.5倍——请按实际投料复核' +
    '【配方去重】⑥轻颜羽衣甘蓝里奇异果果茸31.57g与奇异果果酱55g并存，是否重复扣减？保留哪个？' +
    '【主数据规格】⑦茉莉绿茶按袋还是按箱采购 ⑧水牛毛肚/猪黄喉1包=2500g？ ⑨丘北辣椒1斤=500g？ ⑩盐冻虾「件」是单袋1.5kg还是整箱9kg ⑪香草冰激淋规格3Gg应为3kg'

  const res = await notify({
    tenantId: tenant.id,
    event: 'DATA_QUALITY_TASK',
    eventKey: 'MANUAL:DQ:2026-07-24',
    payload: { count: 11, summary },
  })
  console.log('DATA_QUALITY_TASK:', JSON.stringify(res))
}

main().finally(() => prisma.$disconnect())
