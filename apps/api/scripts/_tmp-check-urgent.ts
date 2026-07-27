import 'dotenv/config'
import { prisma } from '@dianjie/db'

async function main() {
  const logs = await prisma.notificationLog.findMany({
    where: { eventType: 'FEEDBACK_URGENT_BUG' },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { eventType: true, eventKey: true, createdAt: true },
  })
  console.log('URGENT 事件日志:', JSON.stringify(logs))
  const fb = await prisma.feedback.findUniqueOrThrow({
    where: { id: 'cms1evbzx000mnzoi6hvy0bx3' },
    select: { status: true, category: true, title: true, summary: true, messages: { select: { role: true, content: true }, orderBy: { createdAt: 'asc' } } },
  })
  console.log('反馈状态:', fb.status, '| 分类:', fb.category)
  console.log('对话数:', fb.messages.length)
  for (const m of fb.messages) console.log(`  [${m.role}] ${m.content.slice(0, 80)}`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
