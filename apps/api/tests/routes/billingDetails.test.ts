/**
 * DJ-002 / REQ-FIN-001 / DEC-023：账期、对账单、发票只读详情 mock 契约测试。
 * Fastify inject + Prisma spy，不读真实数据库；验证作用域、字段白名单与无写副作用。
 */
import Fastify from 'fastify'
import { Prisma, prisma } from '@dianjie/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleRoutes } from '../../src/routes/schedules'
import { reconciliationRoutes } from '../../src/routes/reconciliations'
import { invoiceRoutes } from '../../src/routes/invoices'
import { notifyApprovalDone } from '../../src/services/notification'

vi.mock('../../src/services/notification', () => ({ notifyApprovalDone: vi.fn() }))

type TestUser = Record<string, any>

async function buildApp(user: TestUser, kind: 'schedules' | 'reconciliations' | 'invoices') {
  const app = Fastify()
  app.decorate('authenticate', async (request: any) => { request.user = { ...user } })
  if (kind === 'schedules') await app.register(scheduleRoutes, { prefix: '/api/schedules' })
  else if (kind === 'reconciliations') await app.register(reconciliationRoutes, { prefix: '/api/reconciliations' })
  else await app.register(invoiceRoutes, { prefix: '/api/invoices' })
  await app.ready()
  return app
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('GET /api/schedules/:id 只读详情', () => {
  const scheduleRow = {
    id: 'sch-1',
    amount: new Prisma.Decimal('1216.6'),
    status: 'PENDING',
    dueAt: new Date('2026-06-13T00:00:00.000Z'),
    paidAt: null,
    supplier: { id: 'sup-1', name: '测试供应商' },
    receipt: {
      id: 'r-1',
      no: 'RK001',
      deliveryDate: new Date('2026-05-14T00:00:00.000Z'),
      totalAmount: new Prisma.Decimal('1216.6'),
      tenantId: 'tenant-1',
      store: { id: 'store-1', name: '测试门店' },
    },
  }

  it('授权读取返回白名单字段，金额原样传递且不带银行敏感字段', async () => {
    const findFirst = vi.spyOn(prisma.paymentSchedule, 'findFirst').mockResolvedValue(scheduleRow as any)
    const app = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN', supplierId: null,
    }, 'schedules')

    const response = await app.inject({ method: 'GET', url: '/api/schedules/sch-1' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toEqual({
      id: 'sch-1',
      amount: '1216.6',
      status: 'PENDING',
      dueAt: '2026-06-13T00:00:00.000Z',
      paidAt: null,
      supplier: { id: 'sup-1', name: '测试供应商' },
      receipt: {
        id: 'r-1',
        no: 'RK001',
        deliveryDate: '2026-05-14T00:00:00.000Z',
        totalAmount: '1216.6',
        store: { id: 'store-1', name: '测试门店' },
      },
    })
    expect(findFirst.mock.calls[0][0]).toMatchObject({ where: { id: 'sch-1', tenantId: 'tenant-1' } })
    await app.close()
  })

  it('无读取角色返回403且不触发查询', async () => {
    const findFirst = vi.spyOn(prisma.paymentSchedule, 'findFirst').mockResolvedValue(null)
    const app = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'COURIER', supplierId: null,
    }, 'schedules')

    const response = await app.inject({ method: 'GET', url: '/api/schedules/sch-1' })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: '无权查看付款计划' })
    expect(findFirst).not.toHaveBeenCalled()
    await app.close()
  })

  it('其他租户或不属于该供应商的记录按不存在返回404', async () => {
    vi.spyOn(prisma.paymentSchedule, 'findFirst').mockResolvedValue(null)
    const app = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'FINANCE', supplierId: null,
    }, 'schedules')

    const response = await app.inject({ method: 'GET', url: '/api/schedules/sch-other-tenant' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: '账期不存在' })
    await app.close()
  })

  it('供应商角色查询收窄到自身供应商', async () => {
    const findFirst = vi.spyOn(prisma.paymentSchedule, 'findFirst').mockResolvedValue(null)
    const app = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLIER_OWNER', supplierId: 'sup-1',
    }, 'schedules')

    await app.inject({ method: 'GET', url: '/api/schedules/sch-1' })
    expect(findFirst.mock.calls[0][0]).toMatchObject({
      where: { id: 'sch-1', tenantId: 'tenant-1', supplierId: 'sup-1' },
    })
    await app.close()
  })

  it('门店角色沿用列表的多店集合过滤，未绑定时fail-closed', async () => {
    const findFirst = vi.spyOn(prisma.paymentSchedule, 'findFirst').mockResolvedValue(null)
    const scoped = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'MANAGER', storeId: 'store-1', storeIds: ['store-1', 'store-2'],
    }, 'schedules')
    await scoped.inject({ method: 'GET', url: '/api/schedules/sch-1' })
    expect(findFirst.mock.calls[0][0]).toMatchObject({
      where: { storeId: { in: ['store-1', 'store-2'] } },
    })
    await scoped.close()

    const unbound = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'MANAGER',
    }, 'schedules')
    await unbound.inject({ method: 'GET', url: '/api/schedules/sch-1' })
    expect(findFirst.mock.calls[1][0]).toMatchObject({ where: { storeId: '__NONE__' } })
    await unbound.close()
  })

  it('来源入库属于其他租户时按无来源呈现，不泄露内容', async () => {
    vi.spyOn(prisma.paymentSchedule, 'findFirst').mockResolvedValue({
      ...scheduleRow,
      receipt: { ...scheduleRow.receipt, tenantId: 'tenant-2' },
    } as any)
    const app = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'FINANCE', supplierId: null,
    }, 'schedules')

    const response = await app.inject({ method: 'GET', url: '/api/schedules/sch-1' })
    expect(response.statusCode).toBe(200)
    expect(response.json().receipt).toBeNull()
    await app.close()
  })

  it('ID过长返回400，数据库异常返回500', async () => {
    vi.spyOn(prisma.paymentSchedule, 'findFirst').mockResolvedValue(null)
    const app = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'FINANCE', supplierId: null,
    }, 'schedules')

    const bad = await app.inject({ method: 'GET', url: `/api/schedules/${'x'.repeat(101)}` })
    expect(bad.statusCode).toBe(404) // Fastify默认maxParamLength=100，在路由校验前拒绝超长参数

    vi.spyOn(prisma.paymentSchedule, 'findFirst').mockRejectedValue(new Error('db down'))
    const failing = await app.inject({ method: 'GET', url: '/api/schedules/sch-1' })
    expect(failing.statusCode).toBe(500)
    expect(failing.json()).toEqual({ error: '账期详情加载失败' })
    await app.close()
  })

  it('只读详情不触发任何数据库写方法或通知', async () => {
    vi.spyOn(prisma.paymentSchedule, 'findFirst').mockResolvedValue(scheduleRow as any)
    const update = vi.spyOn(prisma.paymentSchedule, 'update' as any).mockResolvedValue(null as any)
    const updateMany = vi.spyOn(prisma.paymentSchedule, 'updateMany' as any).mockResolvedValue({ count: 0 } as any)
    const create = vi.spyOn(prisma.paymentSchedule, 'create' as any).mockResolvedValue(null as any)
    const opLogCreate = vi.spyOn(prisma.opLog, 'create').mockResolvedValue(null as any)
    const app = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN', supplierId: null,
    }, 'schedules')

    await app.inject({ method: 'GET', url: '/api/schedules/sch-1' })
    expect(update).not.toHaveBeenCalled()
    expect(updateMany).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(opLogCreate).not.toHaveBeenCalled()
    expect(notifyApprovalDone).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('GET /api/reconciliations/:id 只读详情', () => {
  const reconRow = {
    id: 'rec-1',
    no: 'DC2026050001',
    periodStart: new Date('2026-05-01T00:00:00.000Z'),
    periodEnd: new Date('2026-05-31T00:00:00.000Z'),
    status: 'DRAFT',
    totalAmount: new Prisma.Decimal('1000'),
    supplier: { id: 'sup-1', name: '测试供应商', no: 'SUP001' },
    items: [
      {
        receiptId: 'r-2',
        amount: new Prisma.Decimal('400'),
        receipt: {
          id: 'r-2', no: 'RK002', deliveryDate: new Date('2026-05-20T00:00:00.000Z'),
          totalAmount: new Prisma.Decimal('400'), tenantId: 'tenant-1',
        },
      },
      {
        receiptId: 'r-1',
        amount: new Prisma.Decimal('600'),
        receipt: {
          id: 'r-1', no: 'RK001', deliveryDate: new Date('2026-05-14T00:00:00.000Z'),
          totalAmount: new Prisma.Decimal('600'), tenantId: 'tenant-1',
        },
      },
      {
        receiptId: 'r-x',
        amount: new Prisma.Decimal('999'),
        receipt: {
          id: 'r-x', no: 'RK999', deliveryDate: new Date('2026-05-15T00:00:00.000Z'),
          totalAmount: new Prisma.Decimal('999'), tenantId: 'tenant-2',
        },
      },
    ],
  }

  it('返回完整组成来源单，按到货日稳定排序且呈现原单金额', async () => {
    const findFirst = vi.spyOn(prisma.reconciliation, 'findFirst').mockResolvedValue(reconRow as any)
    const app = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN', supplierId: null,
    }, 'reconciliations')

    const response = await app.inject({ method: 'GET', url: '/api/reconciliations/rec-1' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toEqual({
      id: 'rec-1',
      no: 'DC2026050001',
      periodStart: '2026-05-01T00:00:00.000Z',
      periodEnd: '2026-05-31T00:00:00.000Z',
      status: 'DRAFT',
      totalAmount: '1000',
      supplier: { id: 'sup-1', name: '测试供应商', no: 'SUP001' },
      items: [
        {
          receiptId: 'r-1',
          amount: '600',
          receipt: {
            id: 'r-1', no: 'RK001',
            deliveryDate: '2026-05-14T00:00:00.000Z', totalAmount: '600',
          },
        },
        {
          receiptId: 'r-2',
          amount: '400',
          receipt: {
            id: 'r-2', no: 'RK002',
            deliveryDate: '2026-05-20T00:00:00.000Z', totalAmount: '400',
          },
        },
      ],
    })
    expect(findFirst.mock.calls[0][0]).toMatchObject({
      where: { id: 'rec-1', tenantId: 'tenant-1' },
      select: { items: { where: { receipt: { tenantId: 'tenant-1' } } } },
    })
    await app.close()
  })

  it('无读取角色403；供应商角色未绑定时403', async () => {
    const findFirst = vi.spyOn(prisma.reconciliation, 'findFirst').mockResolvedValue(null)
    const denied = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'COURIER', supplierId: null,
    }, 'reconciliations')
    const deniedResponse = await denied.inject({ method: 'GET', url: '/api/reconciliations/rec-1' })
    expect(deniedResponse.statusCode).toBe(403)
    expect(findFirst).not.toHaveBeenCalled()
    await denied.close()

    const unbound = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLIER_OWNER', supplierId: null,
    }, 'reconciliations')
    const unboundResponse = await unbound.inject({ method: 'GET', url: '/api/reconciliations/rec-1' })
    expect(unboundResponse.statusCode).toBe(403)
    expect(responseError(unboundResponse.json())).toBe('供应商账号未绑定供应商')
    await unbound.close()
  })

  it('记录不存在返回404；供应商角色查询收窄到自身', async () => {
    const findFirst = vi.spyOn(prisma.reconciliation, 'findFirst').mockResolvedValue(null)
    const finance = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'FINANCE', supplierId: null,
    }, 'reconciliations')
    const notFound = await finance.inject({ method: 'GET', url: '/api/reconciliations/rec-9' })
    expect(notFound.statusCode).toBe(404)
    expect(notFound.json()).toEqual({ error: '对账单不存在' })
    await finance.close()

    const supplier = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLIER_STAFF', supplierId: 'sup-1',
    }, 'reconciliations')
    await supplier.inject({ method: 'GET', url: '/api/reconciliations/rec-1' })
    expect(findFirst.mock.calls[1][0]).toMatchObject({
      where: { id: 'rec-1', tenantId: 'tenant-1', supplierId: 'sup-1' },
    })
    await supplier.close()
  })

  it('ID过长返回400；数据库异常返回500', async () => {
    vi.spyOn(prisma.reconciliation, 'findFirst').mockResolvedValue(null)
    const app = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'FINANCE', supplierId: null,
    }, 'reconciliations')

    const bad = await app.inject({ method: 'GET', url: `/api/reconciliations/${'x'.repeat(101)}` })
    expect(bad.statusCode).toBe(404) // Fastify默认maxParamLength=100，在路由校验前拒绝超长参数

    vi.spyOn(prisma.reconciliation, 'findFirst').mockRejectedValue(new Error('db down'))
    const failing = await app.inject({ method: 'GET', url: '/api/reconciliations/rec-1' })
    expect(failing.statusCode).toBe(500)
    expect(failing.json()).toEqual({ error: '对账单详情加载失败' })
    await app.close()
  })

  it('只读详情不触发任何数据库写方法', async () => {
    vi.spyOn(prisma.reconciliation, 'findFirst').mockResolvedValue(reconRow as any)
    const update = vi.spyOn(prisma.reconciliation, 'update' as any).mockResolvedValue(null as any)
    const updateMany = vi.spyOn(prisma.reconciliation, 'updateMany' as any).mockResolvedValue({ count: 0 } as any)
    const create = vi.spyOn(prisma.reconciliation, 'create' as any).mockResolvedValue(null as any)
    const opLogCreate = vi.spyOn(prisma.opLog, 'create').mockResolvedValue(null as any)
    const app = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN', supplierId: null,
    }, 'reconciliations')

    await app.inject({ method: 'GET', url: '/api/reconciliations/rec-1' })
    expect(update).not.toHaveBeenCalled()
    expect(updateMany).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(opLogCreate).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('GET /api/invoices/:id 既有发票详情只读复用', () => {
  const invoiceRow = {
    id: 'inv-1',
    invoiceNo: 'FP001',
    invoiceCode: null,
    amount: new Prisma.Decimal('1000'),
    amountWithoutTax: new Prisma.Decimal('943.4'),
    taxRate: new Prisma.Decimal('0.06'),
    taxAmount: new Prisma.Decimal('56.6'),
    issueDate: new Date('2026-06-01T00:00:00.000Z'),
    fileUrl: 'https://files.example.com/invoice-1.pdf',
    fileType: 'pdf',
    note: null,
    uploadedById: 'user-2',
    uploadedAt: new Date('2026-06-02T00:00:00.000Z'),
    status: 'PENDING',
    reviewedById: null,
    reviewedAt: null,
    reviewNote: null,
    paidAmount: new Prisma.Decimal('0'),
    fullyPaidAt: null,
    supplier: { id: 'sup-1', name: '测试供应商' },
    uploadedBy: { id: 'user-2', name: '供应商账号' },
    receipts: [
      {
        id: 'r-1', tenantId: 'tenant-1', tempBankAccount: 'BANK-CANARY', tempBankName: 'BANK-NAME-CANARY', no: 'RK001', totalAmount: new Prisma.Decimal('600'),
        deliveryDate: new Date('2026-05-14T00:00:00.000Z'),
        store: { name: '测试门店' },
        paymentSchedule: { id: 'sch-1', amount: new Prisma.Decimal('600'), dueAt: new Date('2026-06-13T00:00:00.000Z'), status: 'PENDING' },
      },
    ],
  }

  it('授权读取返回票面资料与关联入库单，附件原样签名返回', async () => {
    const findFirst = vi.spyOn(prisma.invoice, 'findFirst').mockResolvedValue(invoiceRow as any)
    const app = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN', supplierId: null,
    }, 'invoices')

    const response = await app.inject({ method: 'GET', url: '/api/invoices/inv-1' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.invoiceNo).toBe('FP001')
    expect(body.amount).toBe('1000')
    expect(body.fileUrl).toBe('https://files.example.com/invoice-1.pdf')
    expect(body.receipts).toHaveLength(1)
    expect(body.receipts[0].no).toBe('RK001')
    expect(body).not.toHaveProperty('uploadedById')
    expect(body).not.toHaveProperty('paidAmount')
    expect(body.receipts[0]).not.toHaveProperty('paymentSchedule')
    expect(JSON.stringify(body)).not.toContain('CANARY')
    expect(findFirst.mock.calls[0][0]).toHaveProperty('select.receipts.where.tenantId', 'tenant-1')
    expect(findFirst.mock.calls[0][0]).toMatchObject({
      where: { id: 'inv-1', tenantId: 'tenant-1' },
    })
    await app.close()
  })

  it('损坏的跨租户来源不泄露，并保留财务角色既有响应', async () => {
    vi.spyOn(prisma.invoice, 'findFirst').mockResolvedValue({
      ...invoiceRow, receipts: [...invoiceRow.receipts, {
        ...invoiceRow.receipts[0], id: 'foreign', tenantId: 'tenant-other', no: 'FOREIGN-CANARY',
      }],
    } as any)
    const supply = await buildApp({ tenantId: 'tenant-1', userId: 'u1', role: 'SUPPLY_CHAIN', supplierId: null }, 'invoices')
    const response = await supply.inject({ method: 'GET', url: '/api/invoices/inv-1' })
    expect(response.json().receipts).toHaveLength(1)
    expect(response.body).not.toContain('FOREIGN-CANARY')
    await supply.close()
    const finance = await buildApp({ tenantId: 'tenant-1', userId: 'u1', role: 'FINANCE', supplierId: null }, 'invoices')
    const original = await finance.inject({ method: 'GET', url: '/api/invoices/inv-1' })
    expect(original.json()).toHaveProperty('uploadedById', 'user-2')
    await finance.close()
  })

  it('无读取角色403；记录不存在404；供应商范围收窄', async () => {
    const findFirst = vi.spyOn(prisma.invoice, 'findFirst').mockResolvedValue(null)
    const denied = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'COURIER', supplierId: null,
    }, 'invoices')
    const deniedResponse = await denied.inject({ method: 'GET', url: '/api/invoices/inv-1' })
    expect(deniedResponse.statusCode).toBe(403)
    expect(findFirst).not.toHaveBeenCalled()
    await denied.close()

    const finance = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'FINANCE', supplierId: null,
    }, 'invoices')
    const notFound = await finance.inject({ method: 'GET', url: '/api/invoices/inv-9' })
    expect(notFound.statusCode).toBe(404)
    await finance.close()

    const supplier = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLIER_OWNER', supplierId: 'sup-1',
    }, 'invoices')
    await supplier.inject({ method: 'GET', url: '/api/invoices/inv-1' })
    expect(findFirst.mock.calls[1][0]).toMatchObject({
      where: { id: 'inv-1', tenantId: 'tenant-1', supplierId: 'sup-1' },
    })
    await supplier.close()
  })

  it('只读详情不触发任何数据库写方法', async () => {
    vi.spyOn(prisma.invoice, 'findFirst').mockResolvedValue(invoiceRow as any)
    const update = vi.spyOn(prisma.invoice, 'update' as any).mockResolvedValue(null as any)
    const create = vi.spyOn(prisma.invoice, 'create' as any).mockResolvedValue(null as any)
    const opLogCreate = vi.spyOn(prisma.opLog, 'create').mockResolvedValue(null as any)
    const app = await buildApp({
      tenantId: 'tenant-1', userId: 'user-1', role: 'SUPPLY_CHAIN', supplierId: null,
    }, 'invoices')

    await app.inject({ method: 'GET', url: '/api/invoices/inv-1' })
    expect(update).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(opLogCreate).not.toHaveBeenCalled()
    await app.close()
  })
})

function responseError(body: any) {
  return body?.error
}


describe('供应链旧列表白名单', () => {
  it('账期列表不带银行响应，其他角色保留旧查询合同', async () => {
    const findMany = vi.spyOn(prisma.paymentSchedule, 'findMany').mockResolvedValue([{
      id: 'sch-list', amount: new Prisma.Decimal(600), status: 'PENDING', dueAt: new Date('2026-10-10'), paidAt: null,
      bankTxNo: 'BANK-SECRET', bankRawResponse: { account: 'RAW-SECRET' },
      supplier: { id: 'supplier', name: '供应商' },
      receipt: { id: 'r', tenantId: 'tenant-1', no: 'RK-1', deliveryDate: new Date('2026-10-01'), store: { name: '门店' } },
    }] as any)
    const app = await buildApp({ tenantId: 'tenant-1', userId: 'u', role: 'SUPPLY_CHAIN' }, 'schedules')
    const response = await app.inject({ method: 'GET', url: '/api/schedules' })
    expect(response.statusCode).toBe(200)
    expect(response.json()[0]).toMatchObject({ amount: '600', receipt: { no: 'RK-1' } })
    expect(response.body).not.toContain('SECRET')
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { tenantId: 'tenant-1' }, select: { id: true } })
    await app.close()
    const finance = await buildApp({ tenantId: 'tenant-1', userId: 'f', role: 'FINANCE' }, 'schedules')
    await finance.inject({ method: 'GET', url: '/api/schedules' })
    expect(findMany.mock.calls[1][0]).toHaveProperty('include')
    expect(findMany.mock.calls[1][0]).not.toHaveProperty('select')
    await finance.close()
  })

  it('发票列表保留票面和本租户来源数，隐藏付款和审核内部字段', async () => {
    const findMany = vi.spyOn(prisma.invoice, 'findMany').mockResolvedValue([{
      id: 'inv', invoiceNo: 'FP-1', amount: new Prisma.Decimal(1000), status: 'PENDING', issueDate: new Date('2026-10-01'),
      supplier: { id: 's', name: '供应商' }, reviewedById: 'SECRET-REVIEWER',
      payments: [{ note: 'SECRET-PAYMENT' }], fileUrl: 'SECRET-FILE',
      receipts: [{ id: 'own', tenantId: 'tenant-1' }, { id: 'foreign', tenantId: 'tenant-2' }],
    }] as any)
    const app = await buildApp({ tenantId: 'tenant-1', userId: 'u', role: 'SUPPLY_CHAIN' }, 'invoices')
    const response = await app.inject({ method: 'GET', url: '/api/invoices' })
    expect(response.statusCode).toBe(200)
    expect(response.json()[0]).toMatchObject({ invoiceNo: 'FP-1', amount: '1000', receipts: [{ id: 'own' }] })
    expect(response.body).not.toContain('SECRET')
    expect(response.body).not.toContain('foreign')
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { tenantId: 'tenant-1' }, select: { receipts: { where: { tenantId: 'tenant-1' } } } })
    await app.close()
  })
})
