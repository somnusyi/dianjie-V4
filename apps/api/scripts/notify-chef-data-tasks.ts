/**
 * 一次性运维脚本：向总厨推送「缺 BOM 菜品」与「数据质量待办」企微通知
 * 用法: npx tsx scripts/notify-chef-data-tasks.ts   (在服务器 apps/api 目录下, 自动读 .env)
 */
import 'dotenv/config'
import { prisma } from '@dianjie/db'
import { notify } from '../src/services/notify'

async function main() {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: 'dianjie' } })
  const store = await prisma.store.findFirstOrThrow({ where: { tenantId: tenant.id, no: 'DJ001' } })

  const bom = await notify({
    tenantId: tenant.id,
    event: 'BOM_TASK_PENDING',
    eventKey: 'MANUAL:BOM-GAP:2026-07-21',
    payload: {
      count: 4,
      storeName: store.name,
      bizDate: '2026-07-21',
      dishNames: '百家蘸料(日均80份·最急)、打包盒（小）、打包盒大、虎掌菌',
    },
  })
  console.log('BOM_TASK_PENDING:', bom)

  const dq = await notify({
    tenantId: tenant.id,
    event: 'DATA_QUALITY_TASK',
    eventKey: 'MANUAL:DQ:2026-07-21',
    payload: {
      count: 7,
      summary: '①茉莉绿茶:按袋还是按箱采购(现1袋=15000g) ②水牛毛肚/猪黄喉:确认1包=2500g ③丘北辣椒:确认1斤=500g ④盐冻虾:「件」是单袋1.5kg还是整箱9kg ⑤香草冰激淋:规格3Gg系笔误应为3kg ⑥鲜花饼:1份实际用几枚',
    },
  })
  console.log('DATA_QUALITY_TASK:', dq)
}

main().finally(() => prisma.$disconnect())
