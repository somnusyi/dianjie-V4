import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@dianjie/db'
import { publicApplyRoute } from '../../src/routes/applications'
import { notify } from '../../src/services/notify'
import { findStoresMissingDailyReport, previousBizDate, runDailyReportReminder } from '../../src/services/dailyReportReminder'

const suffix = `todo-notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const BIZ_DATE = previousBizDate(new Date())

let app: ReturnType<typeof Fastify>
let tenantId = ''
let storeAId = ''   // OPERATING, 有店长+厨师长, 无日报 → 应提醒
let storeBId = ''   // CONSTRUCTION (未开业), 有店长 → 不提醒
let storeCId = ''   // OPERATING, 无绑定账号 → 不提醒
let storeDId = ''   // OPERATING, 有店长, 当日已有确认日报 → 不提醒
let storeEId = ''   // TRIAL, 有店长, 有历史确认日报但当日缺 → 应提醒
let bossId = ''
let chefDirectorId = ''
let managerAId = ''
let kitchenAId = ''
let managerEId = ''

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function createStore(no: string, name: string, lifecyclePhase: any) {
  const store = await prisma.store.create({ data: { tenantId, no, name, lifecyclePhase } })
  return store.id
}

async function createUser(data: { name: string; role: any; storeId?: string; wecom?: string }) {
  const user = await prisma.user.create({
    data: {
      tenantId, name: data.name, role: data.role,
      email: `${suffix}-${data.name}@local.test`, password: 'test',
      storeId: data.storeId || null, storeIds: data.storeId ? [data.storeId] : [],
      wecomUserId: data.wecom || null,
    },
  })
  return user.id
}

async function createConfirmedImport(storeId: string, businessDate: string, createdById: string) {
  await prisma.dailyBusinessImport.create({
    data: {
      tenantId, storeId, businessDate: new Date(`${businessDate}T00:00:00.000Z`), revision: 1,
      status: 'CONFIRMED', businessFileName: '营业.xlsx', businessFileHash: 'a'.repeat(64),
      salesFileName: '销售.xlsx', salesFileHash: 'b'.repeat(64), calculationFingerprint: 'c'.repeat(64),
      grossAmount: 1000, discountAmount: 0, netRevenue: 1000, orderCount: 10, dishRowCount: 1,
      parsedData: {}, previewData: {}, blockingIssues: [], warningIssues: [],
      createdById, confirmedById: createdById, confirmedAt: new Date(),
    },
  })
}

describe('wecom todo notifications (integration)', () => {
  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: suffix, slug: suffix } })
    tenantId = tenant.id
    storeAId = await createStore(`A-${suffix}`, '待办提醒A店', 'OPERATING')
    storeBId = await createStore(`B-${suffix}`, '未开业B店', 'CONSTRUCTION')
    storeCId = await createStore(`C-${suffix}`, '无人C店', 'OPERATING')
    storeDId = await createStore(`D-${suffix}`, '已报D店', 'OPERATING')
    storeEId = await createStore(`E-${suffix}`, '试营业E店', 'TRIAL')

    bossId = await createUser({ name: '老板', role: 'ADMIN', wecom: 'wx-boss' })
    chefDirectorId = await createUser({ name: '总厨', role: 'CHEF_DIRECTOR', wecom: 'wx-cd' })
    managerAId = await createUser({ name: 'A店长', role: 'MANAGER', storeId: storeAId, wecom: 'wx-m-a' })
    kitchenAId = await createUser({ name: 'A厨师长', role: 'KITCHEN_LEAD', storeId: storeAId, wecom: 'wx-k-a' })
    await createUser({ name: 'B店长', role: 'MANAGER', storeId: storeBId, wecom: 'wx-m-b' })
    const managerDId = await createUser({ name: 'D店长', role: 'MANAGER', storeId: storeDId, wecom: 'wx-m-d' })
    managerEId = await createUser({ name: 'E店长', role: 'MANAGER', storeId: storeEId, wecom: 'wx-m-e' })

    await createConfirmedImport(storeDId, BIZ_DATE, managerDId)
    // E 店只有历史日报 (10 天前), 前一营业日仍缺
    const older = new Date(`${BIZ_DATE}T00:00:00.000Z`)
    older.setUTCDate(older.getUTCDate() - 10)
    await createConfirmedImport(storeEId, older.toISOString().slice(0, 10), managerEId)

    app = Fastify()
    await app.register(publicApplyRoute, { prefix: '/api/auth' })
    await app.ready()
  })

  afterAll(async () => {
    if (app) await app.close()
    if (!tenantId) return
    await prisma.notificationLog.deleteMany({ where: { tenantId } })
    await prisma.dailyBusinessImport.deleteMany({ where: { tenantId } })
    await prisma.userApplication.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { tenantId } })
    await prisma.store.deleteMany({ where: { tenantId } })
    await prisma.tenant.delete({ where: { id: tenantId } })
  })

  it('notifies BOSS/ADMIN when a public account application is submitted', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/apply',
      payload: {
        name: '申请店长', phone: '13800001234', password: 'secret6',
        requestedRole: 'MANAGER', requestedStoreId: storeAId, tenantSlug: suffix,
      },
    })
    expect(response.statusCode).toBe(201)

    await sleep(800)
    const logs = await prisma.notificationLog.findMany({
      where: { tenantId, eventType: 'USER_APPLICATION_PENDING' },
    })
    expect(logs.length).toBeGreaterThan(0)
    // 老板在收件人里; 企微未配置时投递记 failed, 但事件/收件人/eventKey 已落库
    const bossLog = logs.find(row => row.userId === bossId)
    expect(bossLog).toBeTruthy()
    expect(bossLog!.eventKey).toMatch(/^USER_APPLICATION:.+:PENDING$/)
    const payload = bossLog!.payload as any
    expect(payload.name).toBe('申请店长')
    expect(payload.storeName).toBe('待办提醒A店')
    // 店长不应收到租户级审批通知
    expect(logs.some(row => row.userId === managerAId)).toBe(false)
  })

  it('resolves store-scoped recipients and blocks duplicate sends within the frequency window', async () => {
    const eventKey = `INVENTORY_COUNT:test-count-1:SUBMITTED`
    await notify({
      tenantId, event: 'COUNT_PENDING_CONFIRM', eventKey,
      payload: { countId: 'c1', no: 'PD-001', storeName: '待办提醒A店', submittedByName: 'A店长', itemCount: 10 },
      toStoreIds: [storeAId],
    })
    const firstLogs = await prisma.notificationLog.findMany({ where: { tenantId, eventKey, status: 'failed' } })
    // 店长 + 厨师长都收到 (企微未配置 → failed); 其他店店长不收
    expect(new Set(firstLogs.map(row => row.userId))).toEqual(new Set([managerAId, kitchenAId]))

    // 5 分钟频控窗口: 已有 sent/processing 占位时同 eventKey 不再重复投递。
    // (本环境企微未配置, 首次投递落 failed, 按设计 failed 不拦重试, 故用 sent 预置模拟已成功投递)
    const dupKey = `INVENTORY_COUNT:test-count-2:SUBMITTED`
    await prisma.notificationLog.create({
      data: { tenantId, userId: managerAId, eventType: 'COUNT_PENDING_CONFIRM', eventKey: dupKey, channel: 'wecom', status: 'sent' },
    })
    await prisma.notificationLog.create({
      data: { tenantId, userId: kitchenAId, eventType: 'COUNT_PENDING_CONFIRM', eventKey: dupKey, channel: 'wecom', status: 'sent' },
    })
    await notify({
      tenantId, event: 'COUNT_PENDING_CONFIRM', eventKey: dupKey,
      payload: { countId: 'c2', no: 'PD-002', storeName: '待办提醒A店', submittedByName: 'A店长', itemCount: 10 },
      toStoreIds: [storeAId],
    })
    const blocked = await prisma.notificationLog.findMany({ where: { tenantId, eventKey: dupKey, status: 'frequency_blocked' } })
    expect(blocked.length).toBe(2)
    const dupSent = await prisma.notificationLog.findMany({ where: { tenantId, eventKey: dupKey, status: { in: ['sent', 'processing'] } } })
    expect(dupSent.length).toBe(2) // 只有预置的两条, 没有新投递
  })

  it('routes BOM_TASK_PENDING to the chef director only', async () => {
    const eventKey = 'DAILY_IMPORT:test-import-1:BOM_TASK'
    await notify({
      tenantId, event: 'BOM_TASK_PENDING', eventKey,
      payload: { storeName: '待办提醒A店', bizDate: BIZ_DATE, count: 2, dishNames: '土豆牛腩、酸汤鱼(大份)' },
    })
    const logs = await prisma.notificationLog.findMany({ where: { tenantId, eventKey } })
    expect(new Set(logs.map(row => row.userId))).toEqual(new Set([chefDirectorId]))
  })

  it('selects only operating stores with bound staff and no confirmed report for the biz date', async () => {
    const missing = await findStoresMissingDailyReport(BIZ_DATE)
    const ids = missing.map(store => store.id)
    expect(ids).toContain(storeAId)  // 正式运营 + 有账号 + 缺日报
    expect(ids).toContain(storeEId)  // 试营业但有历史日报 → 视为已运行
    expect(ids).not.toContain(storeBId) // 未开业 (CONSTRUCTION)
    expect(ids).not.toContain(storeCId) // 无绑定账号
    expect(ids).not.toContain(storeDId) // 当日已确认日报
  })

  it('sends at most one reminder per store per day (persistent dedupe beyond the 5-min window)', async () => {
    // 预置: E 店当天已发过一条 sent 记录 → 不应重发 (模拟进程重启后再扫)
    await prisma.notificationLog.create({
      data: {
        tenantId, userId: managerEId, eventType: 'DAILY_REPORT_MISSING',
        eventKey: `DAILY_REPORT:${storeEId}:${BIZ_DATE}:MISSING`, channel: 'wecom', status: 'sent',
      },
    })
    const result = await runDailyReportReminder(BIZ_DATE)
    expect(result.reminded).toBe(1) // 仅 A 店
    expect(result.skipped).toBe(1)  // E 店持久去重
    await sleep(800)

    const aLogs = await prisma.notificationLog.findMany({
      where: { tenantId, eventType: 'DAILY_REPORT_MISSING', eventKey: `DAILY_REPORT:${storeAId}:${BIZ_DATE}:MISSING` },
    })
    expect(new Set(aLogs.map(row => row.userId))).toEqual(new Set([managerAId, kitchenAId]))

    const eLogs = await prisma.notificationLog.findMany({
      where: { tenantId, eventType: 'DAILY_REPORT_MISSING', eventKey: `DAILY_REPORT:${storeEId}:${BIZ_DATE}:MISSING` },
    })
    expect(eLogs.length).toBe(1) // 只有预置那条

    // 再跑一轮: A 店记录是 failed (企微未配置), 持久去重不拦 failed, 但正常运行一轮只发一次
    const second = await runDailyReportReminder(BIZ_DATE)
    expect(second.reminded + second.skipped).toBe(second.checked)
  })
})
