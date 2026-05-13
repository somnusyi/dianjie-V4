import { PrismaClient, Role, CreditType } from '@prisma/client'
import bcrypt from 'bcryptjs'
import dayjs from 'dayjs'

const prisma = new PrismaClient()
const hash = (pw: string) => bcrypt.hashSync(pw, 10)
const d = (s: string) => new Date(s)

async function main() {
  console.log('🌱 开始初始化种子数据...')

  // ── 租户 ──────────────────────────────────────────
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'dianjie' },
    update: {},
    create: { name: '滇界餐饮管理有限公司', slug: 'dianjie', plan: 'PROFESSIONAL', status: 'ACTIVE' },
  })

  // ── 用户 ──────────────────────────────────────────
  const admin = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'admin@dianjie.com' } },
    update: {},
    create: { tenantId: tenant.id, name: '系统管理员', email: 'admin@dianjie.com', password: hash('admin123'), role: Role.ADMIN },
  })
  const finance = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'finance@dianjie.com' } },
    update: {},
    create: { tenantId: tenant.id, name: '李慧芳', email: 'finance@dianjie.com', password: hash('fin123'), role: Role.FINANCE },
  })

  // ── 门店 ──────────────────────────────────────────
  const stores = await Promise.all([
    prisma.store.upsert({
      where: { tenantId_no: { tenantId: tenant.id, no: 'DJ001' } },
      update: {},
      create: { tenantId: tenant.id, no: 'DJ001', name: '滇界·昆明翠湖旗舰店', address: '云南省昆明市五华区翠湖南路88号', managerName: '王建国', phone: '13888001111', status: 'ENABLED' },
    }),
    prisma.store.upsert({
      where: { tenantId_no: { tenantId: tenant.id, no: 'DJ002' } },
      update: {},
      create: { tenantId: tenant.id, no: 'DJ002', name: '滇界·大理古城店', address: '云南省大理州大理市古城区人民路32号', managerName: '张晓燕', phone: '13888002222', status: 'ENABLED' },
    }),
    prisma.store.upsert({
      where: { tenantId_no: { tenantId: tenant.id, no: 'DJ003' } },
      update: {},
      create: { tenantId: tenant.id, no: 'DJ003', name: '滇界·丽江束河店', address: '云南省丽江市古城区束河古镇56号', managerName: '赵明亮', phone: '13888003333', status: 'ENABLED' },
    }),
  ])

  // 店长
  const mgr1 = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'manager1@dianjie.com' } },
    update: {},
    create: { tenantId: tenant.id, name: '王建国', email: 'manager1@dianjie.com', password: hash('mgr123'), role: Role.MANAGER, storeId: stores[0].id },
  })
  const mgr2 = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'manager2@dianjie.com' } },
    update: {},
    create: { tenantId: tenant.id, name: '张晓燕', email: 'manager2@dianjie.com', password: hash('mgr123'), role: Role.MANAGER, storeId: stores[1].id },
  })

  console.log('✓ 用户 & 门店创建完成')

  // ── 供应商 ────────────────────────────────────────
  const sup1 = await prisma.supplier.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'SUP001' } },
    update: {},
    create: {
      tenantId: tenant.id, no: 'SUP001', name: '云南楚雄野生菌产业集团',
      contactName: '赵总', contactPhone: '13900001111', category: '菌类',
      creditType: CreditType.FIXED_DAYS, creditDays: 30, autoPay: false,
      bankName: '中国银行昆明分行', bankAccount: '6217001234567890', bankAccountName: '云南楚雄野生菌产业集团有限公司',
      scoreTotal: 96, onTimeRate: 98, totalOrders: 48,
    },
  })
  const sup2 = await prisma.supplier.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'SUP002' } },
    update: {},
    create: {
      tenantId: tenant.id, no: 'SUP002', name: '迪庆藏区高原蔬菜合作社',
      contactName: '扎西旺堆', contactPhone: '13900002222', category: '蔬菜',
      creditType: CreditType.FIXED_DAYS, creditDays: 15, autoPay: false,
      bankName: '农业银行昆明分行', bankAccount: '6228001234567891', bankAccountName: '迪庆藏区高原蔬菜合作社',
      scoreTotal: 88, onTimeRate: 92, totalOrders: 36,
    },
  })
  const sup3 = await prisma.supplier.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'SUP003' } },
    update: {},
    create: {
      tenantId: tenant.id, no: 'SUP003', name: '普洱山地土猪养殖基地',
      contactName: '李老板', contactPhone: '13900003333', category: '肉类',
      creditType: CreditType.FIXED_DAYS, creditDays: 7, autoPay: false,
      bankName: '建设银行普洱支行', bankAccount: '6236001234567892', bankAccountName: '普洱山地土猪养殖基地',
      scoreTotal: 82, onTimeRate: 85, totalOrders: 24,
    },
  })

  // 供应商账号
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'supplier1@dianjie.com' } },
    update: {},
    create: {
      tenantId: tenant.id, name: '赵总（楚雄菌业）',
      email: 'supplier1@dianjie.com', password: hash('sup123'),
      role: 'SUPPLIER_STAFF' as Role,
    },
  })
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'supplier2@dianjie.com' } },
    update: {},
    create: {
      tenantId: tenant.id, name: '扎西（迪庆蔬菜）',
      email: 'supplier2@dianjie.com', password: hash('sup123'),
      role: 'SUPPLIER_STAFF' as Role,
    },
  })

  console.log('✓ 供应商创建完成')

  // ── 商品 ──────────────────────────────────────────
  const products = await Promise.all([
    prisma.product.upsert({ where: { tenantId_code: { tenantId: tenant.id, code: 'MR001' } }, update: {}, create: { tenantId: tenant.id, code: 'MR001', name: '野生松茸（新鲜）', category: '菌菇类', unit: 'kg', price: 380, stock: 42, minStock: 10, shelfDays: 3, supplierId: sup1.id } }),
    prisma.product.upsert({ where: { tenantId_code: { tenantId: tenant.id, code: 'MR002' } }, update: {}, create: { tenantId: tenant.id, code: 'MR002', name: '云南牛肝菌（干货）', category: '菌菇类', unit: 'kg', price: 120, stock: 85, minStock: 20, shelfDays: 180, supplierId: sup1.id } }),
    prisma.product.upsert({ where: { tenantId_code: { tenantId: tenant.id, code: 'MR003' } }, update: {}, create: { tenantId: tenant.id, code: 'MR003', name: '鸡枞菌（新鲜）', category: '菌菇类', unit: 'kg', price: 260, stock: 18, minStock: 8, shelfDays: 2, supplierId: sup1.id } }),
    prisma.product.upsert({ where: { tenantId_code: { tenantId: tenant.id, code: 'VG001' } }, update: {}, create: { tenantId: tenant.id, code: 'VG001', name: '迪庆高原韭黄', category: '蔬菜', unit: 'kg', price: 18, stock: 120, minStock: 30, shelfDays: 5, supplierId: sup2.id } }),
    prisma.product.upsert({ where: { tenantId_code: { tenantId: tenant.id, code: 'VG002' } }, update: {}, create: { tenantId: tenant.id, code: 'VG002', name: '云南小瓜', category: '蔬菜', unit: 'kg', price: 8, stock: 200, minStock: 50, shelfDays: 7, supplierId: sup2.id } }),
    prisma.product.upsert({ where: { tenantId_code: { tenantId: tenant.id, code: 'MT001' } }, update: {}, create: { tenantId: tenant.id, code: 'MT001', name: '普洱土猪五花肉', category: '肉类', unit: 'kg', price: 68, stock: 60, minStock: 20, shelfDays: 3, supplierId: sup3.id } }),
    prisma.product.upsert({ where: { tenantId_code: { tenantId: tenant.id, code: 'MT002' } }, update: {}, create: { tenantId: tenant.id, code: 'MT002', name: '黑山羊肉（带骨）', category: '肉类', unit: 'kg', price: 88, stock: 35, minStock: 15, shelfDays: 3, supplierId: sup3.id } }),
  ])
  const [p1, p2, p3, p4, p5, p6, p7] = products
  console.log('✓ 商品创建完成')

  // ── 采购订单测试数据 ───────────────────────────────
  // 场景1：已提交，等供应商确认
  const po1 = await prisma.purchaseOrder.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'PO202403001' } },
    update: {},
    create: {
      tenantId: tenant.id, no: 'PO202403001',
      storeId: stores[0].id, supplierId: sup1.id,
      expectedDate: d('2026-03-15'), totalAmount: 5800,
      status: 'SUBMITTED', note: '周末备货，请尽快确认',
      createdById: mgr1.id,
      items: { create: [
        { productId: p1.id, quantity: 10, unitPrice: 380, amount: 3800 },
        { productId: p2.id, quantity: 15, unitPrice: 120, amount: 1800 },
        { productId: p3.id, quantity: 0.77, unitPrice: 260, amount: 200 },
      ]},
    },
  })

  // 场景2：供应商已送达，等店长确认收货（主要测试场景）
  const po2 = await prisma.purchaseOrder.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'PO202403002' } },
    update: {},
    create: {
      tenantId: tenant.id, no: 'PO202403002',
      storeId: stores[0].id, supplierId: sup2.id,
      expectedDate: d('2026-03-13'), totalAmount: 3160,
      status: 'PENDING_CONFIRM',
      shippedAt: d('2026-03-13T08:30:00'),
      shippedNote: '已送达，请尽快确认',
      shippedById: admin.id,
      createdById: mgr1.id,
      items: { create: [
        { productId: p4.id, quantity: 80, unitPrice: 18, amount: 1440 },
        { productId: p5.id, quantity: 110, unitPrice: 8, amount: 880 },
        { productId: p6.id, quantity: 12, unitPrice: 68, amount: 816 },
      ]},
    },
  })

  // 场景3：大理店，等待收货（测试报损流程）
  const po3 = await prisma.purchaseOrder.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'PO202403003' } },
    update: {},
    create: {
      tenantId: tenant.id, no: 'PO202403003',
      storeId: stores[1].id, supplierId: sup1.id,
      expectedDate: d('2026-03-13'), totalAmount: 9360,
      status: 'PENDING_CONFIRM',
      shippedAt: d('2026-03-13T09:00:00'),
      shippedById: admin.id,
      createdById: mgr2.id,
      items: { create: [
        { productId: p1.id, quantity: 20, unitPrice: 380, amount: 7600 },
        { productId: p3.id, quantity: 6, unitPrice: 260, amount: 1560 },
        { productId: p7.id, quantity: 2.3, unitPrice: 88, amount: 202 },
      ]},
    },
  })

  // 场景4：已完成的历史订单
  const po4 = await prisma.purchaseOrder.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'PO202402001' } },
    update: {},
    create: {
      tenantId: tenant.id, no: 'PO202402001',
      storeId: stores[0].id, supplierId: sup3.id,
      expectedDate: d('2026-02-20'), totalAmount: 4080,
      status: 'RECEIVED',
      shippedAt: d('2026-02-20T10:00:00'), shippedById: admin.id,
      receivedAt: d('2026-02-20T14:30:00'),
      createdById: mgr1.id,
      items: { create: [
        { productId: p6.id, quantity: 30, unitPrice: 68, amount: 2040 },
        { productId: p7.id, quantity: 24, unitPrice: 88, amount: 2040 },
      ]},
    },
  })

  console.log('✓ 采购订单创建完成（4笔）')

  // ── 入库单测试数据 ─────────────────────────────────
  // 对应 PO2：待店长操作的入库单（核心测试）
  const rk1 = await prisma.receipt.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'RK202403001' } },
    update: {},
    create: {
      tenantId: tenant.id, no: 'RK202403001',
      storeId: stores[0].id, supplierId: sup2.id,
      deliveryDate: d('2026-03-13'),
      totalAmount: 3160, status: 'PENDING_CONFIRM',
      createdById: admin.id,
      purchaseOrderId: po2.id,
      note: '迪庆高原蔬菜 + 土猪肉，今日到货',
      items: { create: [
        { productId: p4.id, quantity: 80, unitPrice: 18, amount: 1440 },
        { productId: p5.id, quantity: 110, unitPrice: 8, amount: 880 },
        { productId: p6.id, quantity: 12, unitPrice: 68, amount: 816 },
      ]},
    },
  })
  // 更新 PO2 关联
  await prisma.purchaseOrder.update({ where: { id: po2.id }, data: { receiptId: rk1.id } })

  // 对应 PO3：大理店待操作（用于测试报损）
  const rk2 = await prisma.receipt.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'RK202403002' } },
    update: {},
    create: {
      tenantId: tenant.id, no: 'RK202403002',
      storeId: stores[1].id, supplierId: sup1.id,
      deliveryDate: d('2026-03-13'),
      totalAmount: 9360, status: 'PENDING_CONFIRM',
      createdById: admin.id,
      purchaseOrderId: po3.id,
      note: '松茸批次，注意检查新鲜度',
      items: { create: [
        { productId: p1.id, quantity: 20, unitPrice: 380, amount: 7600 },
        { productId: p3.id, quantity: 6, unitPrice: 260, amount: 1560 },
        { productId: p7.id, quantity: 2.3, unitPrice: 88, amount: 202 },
      ]},
    },
  })
  await prisma.purchaseOrder.update({ where: { id: po3.id }, data: { receiptId: rk2.id } })

  // 历史已确认入库单（有账期）
  const rk3 = await prisma.receipt.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'RK202402001' } },
    update: {},
    create: {
      tenantId: tenant.id, no: 'RK202402001',
      storeId: stores[0].id, supplierId: sup3.id,
      deliveryDate: d('2026-02-20'),
      totalAmount: 4080, status: 'CONFIRMED',
      confirmedAt: d('2026-02-20T14:30:00'),
      createdById: mgr1.id,
      purchaseOrderId: po4.id,
      items: { create: [
        { productId: p6.id, quantity: 30, unitPrice: 68, amount: 2040 },
        { productId: p7.id, quantity: 24, unitPrice: 88, amount: 2040 },
      ]},
    },
  })
  await prisma.purchaseOrder.update({ where: { id: po4.id }, data: { receiptId: rk3.id } })

  // 已逾期账期
  await prisma.paymentSchedule.upsert({
    where: { receiptId: rk3.id },
    update: {},
    create: {
      tenantId: tenant.id, receiptId: rk3.id, supplierId: sup3.id,
      amount: 4080, creditDays: 7,
      confirmedAt: d('2026-02-20T14:30:00'),
      dueAt: d('2026-02-27'),
      status: 'OVERDUE',
    },
  })

  // 历史入库单（已确认，账期未到期）
  const rk4 = await prisma.receipt.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'RK202401001' } },
    update: {},
    create: {
      tenantId: tenant.id, no: 'RK202401001',
      storeId: stores[0].id, supplierId: sup1.id,
      deliveryDate: d('2026-03-01'),
      totalAmount: 18640, status: 'CONFIRMED',
      confirmedAt: d('2026-03-01T10:15:00'),
      createdById: admin.id,
      note: '松茸大批采购',
      items: { create: [
        { productId: p1.id, quantity: 28, unitPrice: 380, amount: 10640 },
        { productId: p2.id, quantity: 40, unitPrice: 120, amount: 4800 },
        { productId: p3.id, quantity: 12, unitPrice: 260, amount: 3120 },
      ]},
    },
  })

  // 对应账期（还差18天到期，测试 T-3天提醒）
  await prisma.paymentSchedule.upsert({
    where: { receiptId: rk4.id },
    update: {},
    create: {
      tenantId: tenant.id, receiptId: rk4.id, supplierId: sup1.id,
      amount: 18640, creditDays: 30,
      confirmedAt: d('2026-03-01T10:15:00'),
      dueAt: d('2026-03-31'),
      status: 'PENDING',
    },
  })

  // 补录入库单（非采购单流程，测试补录功能）
  await prisma.receipt.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'RK202403003' } },
    update: {},
    create: {
      tenantId: tenant.id, no: 'RK202403003',
      storeId: stores[2].id, supplierId: sup2.id,
      deliveryDate: d('2026-03-12'),
      totalAmount: 960, status: 'CONFIRMED',
      confirmedAt: d('2026-03-12T16:00:00'),
      isManual: true,
      createdById: admin.id,
      note: '丽江店补录，线下临时采购',
      items: { create: [
        { productId: p4.id, quantity: 40, unitPrice: 18, amount: 720 },
        { productId: p5.id, quantity: 30, unitPrice: 8, amount: 240 },
      ]},
    },
  })

  console.log('✓ 入库单创建完成（5笔，含2笔待操作）')

  // ── 已有报损申请（测试供应商处理）────────────────
  await prisma.lossClaim.upsert({
    where: { tenantId_no: { tenantId: tenant.id, no: 'LC202403001' } },
    update: {},
    create: {
      tenantId: tenant.id, no: 'LC202403001',
      purchaseOrderId: po4.id,
      storeId: stores[0].id, supplierId: sup3.id,
      totalLossAmount: 272,
      description: '土猪五花肉到货时有2kg已变质发黑，有图为证，请供应商确认扣款',
      evidenceImages: ['https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?w=400'],
      status: 'PENDING',
      createdById: mgr1.id,
      items: { create: [
        { productId: p6.id, orderedQty: 30, receivedQty: 28, lossQty: 2, unitPrice: 68, lossAmount: 136 },
        { productId: p7.id, orderedQty: 24, receivedQty: 22.5, lossQty: 1.5, unitPrice: 88, lossAmount: 132 },
      ]},
    },
  })

  console.log('✓ 报损申请创建完成（1笔待处理）')


  // ── 付款规则（默认配置）──────────────────────────
  const defaultRules = [
    { name: '小额自动付款', description: '单笔 ≤¥2,000 到期自动付款，无需审批', condition: 'AMOUNT_OVER', threshold: 0, action: 'auto_pay', priority: 0 },
    { name: '中额需审批', description: '单笔 ¥2,000~¥20,000 需总部审批后自动付款', condition: 'AMOUNT_OVER', threshold: 2000, action: 'require_approval', priority: 10 },
    { name: '大额人工确认', description: '单笔 > ¥20,000 必须财务人工确认', condition: 'AMOUNT_OVER', threshold: 20000, action: 'require_approval', priority: 20 },
    { name: '新供应商审批', description: '新供应商首次付款必须审批', condition: 'NEW_SUPPLIER', threshold: null, action: 'require_approval', priority: 30 },
    { name: '月累计超限审批', description: '同供应商单月累计超 ¥50,000 需审批', condition: 'MONTHLY_OVER', threshold: 50000, action: 'require_approval', priority: 15 },
  ]

  for (const rule of defaultRules) {
    const existing = await prisma.paymentRule.findFirst({ where: { tenantId: tenant.id, name: rule.name } })
    if (!existing) {
      await prisma.paymentRule.create({ data: { tenantId: tenant.id, ...rule, threshold: rule.threshold !== null ? rule.threshold : undefined } })
    }
  }
  console.log('✓ 付款规则创建完成（5条默认规则）')

  // ── 操作日志 ──────────────────────────────────────
  await prisma.opLog.createMany({
    data: [
      { tenantId: tenant.id, userId: mgr1.id, action: '创建采购订单 PO202403001', target: 'PO202403001', entityType: 'PurchaseOrder' },
      { tenantId: tenant.id, userId: admin.id, action: '供应商确认送达 PO202403002，入库单 RK202403001 已生成', target: 'PO202403002', entityType: 'PurchaseOrder' },
      { tenantId: tenant.id, userId: mgr1.id, action: '确认入库单 RK202402001，账期已自动创建', target: 'RK202402001', entityType: 'Receipt' },
      { tenantId: tenant.id, userId: mgr1.id, action: '提交报损申请 LC202403001，损失 ¥272', target: 'LC202403001', entityType: 'LossClaim' },
    ],
  })

  console.log('\n✅ 测试数据初始化完成！')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('登录账号：')
  console.log('  管理员    admin@dianjie.com      / admin123')
  console.log('  财务      finance@dianjie.com    / fin123')
  console.log('  翠湖店长  manager1@dianjie.com   / mgr123')
  console.log('  大理店长  manager2@dianjie.com   / mgr123')
  console.log('  供应商1   supplier1@dianjie.com  / sup123')
  console.log('  供应商2   supplier2@dianjie.com  / sup123')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('测试场景：')
  console.log('  采购订单  PO202403001 待供应商确认')
  console.log('            PO202403002 已送达，等翠湖店长收货 → 入库单 RK202403001')
  console.log('            PO202403003 已送达，等大理店长收货 → 入库单 RK202403002（可测报损）')
  console.log('  入库管理  RK202403001 点「确认入库」测试正常收货')
  console.log('            RK202403002 点「报损入库」修改数量测试报损扣款')
  console.log('  报损管理  LC202403001 待供应商处理，用 supplier1 账号登录处理')
  console.log('  账期看板  RK202401001 账期2026-03-31到期（18天后）')
  console.log('            RK202402001 账期已逾期（2026-02-27）')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
}

main()
  .catch(e => { console.error('❌ 种子失败:', e); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
