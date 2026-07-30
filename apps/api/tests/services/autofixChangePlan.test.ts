import { describe, expect, it } from 'vitest'
import {
  API_VERIFICATION,
  DATABASE_MIGRATE_COMMAND,
  WEB_VERIFICATION,
  planChanges,
  planDeploymentComponents,
  planVerificationSteps,
  resolveIntegrationTestEnv,
  runVerificationSteps,
} from '../../src/services/autofix/changePlan'

describe('autofix changePlan', () => {
  describe('纯 Web 改动', () => {
    it('普通 apps/web/src 源码判为 low，且只组成 Web 验证命令', () => {
      const plan = planChanges([
        'apps/web/src/app/v2/supply-chain/home/page.tsx',
        'apps/web/src/lib/format.ts',
        'apps/web/src/components/v2/foo.tsx',
        'apps/web/src/app/globals.css',
      ])
      expect(plan.risk).toBe('low')
      expect(plan.blocked).toBe(false)
      expect(plan.categories).toEqual(['web'])
      expect(plan.redlines).toEqual([])
      expect(plan.verification.web).toEqual(WEB_VERIFICATION)
      expect(plan.verification.api).toBeUndefined()
      expect(plan.verification.database).toBeUndefined()
      expect(plan.files.every((f) => f.category === 'web' && f.risk === 'low')).toBe(true)
    })

    it('Web 验证命令含单测/tsc/build 三段', () => {
      const plan = planChanges(['apps/web/src/lib/x.ts'])
      expect(plan.verification.web).toEqual({
        test: 'pnpm --filter @dianjie/web test',
        typecheck: 'pnpm exec tsc -p apps/web/tsconfig.json --noEmit',
        build: 'pnpm --filter @dianjie/web build',
      })
    })
  })

  describe('纯 API 改动', () => {
    it('普通 apps/api/src 判为 medium，组成 API 验证命令', () => {
      const plan = planChanges([
        'apps/api/src/routes/stores.ts',
        'apps/api/src/services/supplierCategory.ts',
      ])
      expect(plan.risk).toBe('medium')
      expect(plan.blocked).toBe(false)
      expect(plan.categories).toEqual(['api'])
      expect(plan.verification.api).toEqual(API_VERIFICATION)
      expect(plan.verification.web).toBeUndefined()
      expect(plan.files.every((f) => f.category === 'api' && f.risk === 'medium')).toBe(true)
    })

    it('API 验证命令含单测/tsc/build 三段', () => {
      const plan = planChanges(['apps/api/src/routes/stores.ts'])
      expect(plan.verification.api).toEqual({
        test: 'pnpm --filter @dianjie/api test',
        typecheck: 'pnpm --filter @dianjie/db generate && pnpm exec tsc -p apps/api/tsconfig.json --noEmit',
        build: 'pnpm --filter @dianjie/api build',
      })
    })

    it('API typecheck 先生成 Prisma Client 再从根目录按 apps/api/tsconfig.json noEmit', () => {
      const plan = planChanges(['apps/api/src/routes/stores.ts'])
      const { typecheck } = plan.verification.api!
      // 干净 worktree 的客户端可能未生成：必须先 generate，避免陈旧生成物造成假失败
      expect(typecheck.startsWith('pnpm --filter @dianjie/db generate')).toBe(true)
      expect(typecheck).toContain('tsc -p apps/api/tsconfig.json --noEmit')
    })
  })

  describe('数据库改动', () => {
    it('Prisma schema 与 migrations 判为 blocked，并只输出隔离 CI 标志', () => {
      const plan = planChanges([
        'packages/db/prisma/schema.prisma',
        'packages/db/prisma/migrations/20990101000000_x/migration.sql',
      ])
      expect(plan.risk).toBe('blocked')
      expect(plan.blocked).toBe(true)
      expect(plan.categories).toEqual(['database'])
      expect(plan.verification.database).toEqual({
        requiresIsolatedCiDb: true,
        migrateDeployCommand: DATABASE_MIGRATE_COMMAND,
        note: expect.stringContaining('隔离 CI 数据库'),
      })
      // 绝不因数据库改动而组成 Web/API 命令
      expect(plan.verification.web).toBeUndefined()
      expect(plan.verification.api).toBeUndefined()
      expect(plan.files.every((f) => f.risk === 'blocked')).toBe(true)
    })

    it('migrateDeployCommand 是隔离 CI 用的 prisma migrate deploy 字符串', () => {
      expect(DATABASE_MIGRATE_COMMAND).toBe('prisma migrate deploy')
    })
  })

  describe('核心红线', () => {
    it.each([
      ['apps/api/src/routes/auth.ts', '认证'],
      ['apps/api/src/services/authTokens.ts', '认证'],
      ['apps/web/src/components/v2/auth-gate.tsx', '认证'],
      ['apps/api/src/middleware/rate-guard.ts', '权限守卫'],
      ['apps/api/src/lib/some-permission.ts', '权限'],
      ['apps/api/src/routes/payments.ts', '资金路由'],
      ['apps/api/src/services/finance/report.ts', '资金服务'],
      ['scripts/deploy-worktree.sh', '部署脚本'],
      ['ecosystem.config.js', '部署配置'],
      ['.env.production', '环境变量文件'],
    ])('%s 判为 blocked（%s）', (file, reason) => {
      const plan = planChanges([file])
      expect(plan.risk).toBe('blocked')
      expect(plan.blocked).toBe(true)
      expect(plan.redlines).toEqual([`${file}: ${reason}`])
    })

    it('依赖与锁文件判为 high（非 blocked，但阻断自动发布）', () => {
      const plan = planChanges(['package.json', 'pnpm-lock.yaml', 'apps/web/package.json'])
      expect(plan.risk).toBe('high')
      expect(plan.blocked).toBe(false)
      expect(plan.files.every((f) => f.risk === 'high')).toBe(true)
      expect(plan.redlines.every((r) => r.includes('依赖与锁文件'))).toBe(true)
    })

    it.each([
      ['apps/api/src/routes/paymentRequests.ts', '资金路由'],
      ['apps/api/src/routes/paymentRules.ts', '资金路由'],
      ['apps/api/src/routes/financeReports.ts', '资金路由'],
      ['apps/api/src/routes/financeReconcile.ts', '资金路由'],
      ['apps/api/src/routes/pettyCash.ts', '资金路由'],
      ['apps/api/src/routes/invoices.ts', '资金路由'],
      ['apps/api/src/routes/capital.ts', '资金路由'],
      ['apps/api/src/routes/payroll.ts', '资金路由'],
      ['apps/api/src/routes/cmb.ts', '资金路由'],
      ['apps/api/src/routes/invoicePayments.ts', '资金路由'],
      ['apps/api/src/services/paymentRequests/create.ts', '资金服务'],
      ['apps/api/src/services/pettyCash/adjust.ts', '资金服务'],
      ['apps/api/src/services/invoices/generate.ts', '资金服务'],
      ['apps/api/src/services/capital/sync.ts', '资金服务'],
      ['apps/api/src/services/payroll/run.ts', '资金服务'],
      ['apps/api/src/services/cmb/sync.ts', '资金服务'],
      ['apps/api/src/services/paymentMutex.ts', '资金服务'],
      ['apps/api/src/services/paymentSchedule.ts', '资金服务'],
      ['apps/api/src/services/cmbAutoSync.ts', '资金服务'],
      ['apps/api/src/services/invoicePaymentIntegrity.ts', '资金服务'],
      ['apps/api/src/services/cashbook.ts', '资金服务'],
      ['apps/api/tests/services/payments.test.ts', '资金测试'],
      ['apps/api/tests/services/cashbook.test.ts', '资金测试'],
      ['apps/api/tests/services/capital.test.ts', '资金测试'],
    ])('资金域 %s 始终判为 blocked（%s），不受核心开关影响', (file, reason) => {
      const planDefault = planChanges([file])
      expect(planDefault.risk).toBe('blocked')
      expect(planDefault.redlines).toEqual([`${file}: ${reason}`])
      // 即使开启核心经营 API 开关，资金域仍为永久红线
      const planCore = planChanges([file], { allowCoreBusinessApi: true })
      expect(planCore.risk).toBe('blocked')
      expect(planCore.blocked).toBe(true)
    })

    it('普通库存 settlement 路径不误伤为资金域（归 core_business）', () => {
      const plan = planChanges(['apps/api/src/services/settlement/run.ts'], { allowCoreBusinessApi: true })
      expect(plan.risk).toBe('core_business')
      expect(plan.blocked).toBe(false)
      expect(plan.redlines).toEqual(['apps/api/src/services/settlement/run.ts: 库存写入/成本核心路径'])
    })
  })

  describe('核心库存写入/成本路径（apps/api 专属红线）', () => {
    it.each([
      'apps/api/src/routes/inventory.ts',
      'apps/api/src/routes/orders.ts',
      'apps/api/src/routes/receipts.ts',
      'apps/api/src/routes/purchases.ts',
      'apps/api/src/services/stock/adjust.ts',
      'apps/api/src/routes/loss.ts',
      'apps/api/src/services/settlement/run.ts',
      'apps/api/src/services/bom/consumption.ts',
      // 本阶段允许的核心经营 API（归 core_business，默认拒绝，开关开启才放行）
      'apps/api/src/services/storeInventory.ts',
      'apps/api/src/services/receiptSettlement.ts',
      'apps/api/src/services/receiptDerivatives.ts',
      'apps/api/src/services/inventoryCosting.ts',
      // 关键字落在 apps/api/tests 同样拦截，避免用测试文件绕过红线
      'apps/api/tests/inventory.test.ts',
    ])('%s 默认判为 blocked（库存写入/成本核心路径）', (file) => {
      const plan = planChanges([file])
      expect(plan.risk).toBe('blocked')
      expect(plan.blocked).toBe(true)
      expect(plan.redlines).toEqual([`${file}: 库存写入/成本核心路径`])
    })

    it.each([
      'apps/api/src/routes/inventory.ts',
      'apps/api/src/routes/orders.ts',
      'apps/api/src/services/stock/adjust.ts',
      'apps/api/src/services/storeInventory.ts',
      'apps/api/src/services/receiptSettlement.ts',
      'apps/api/src/services/receiptDerivatives.ts',
      'apps/api/src/services/inventoryCosting.ts',
      'apps/api/tests/inventory.test.ts',
    ])('%s 开关开启后判为 core_business（可放行）', (file) => {
      const plan = planChanges([file], { allowCoreBusinessApi: true })
      expect(plan.risk).toBe('core_business')
      expect(plan.blocked).toBe(false)
      expect(plan.redlines).toEqual([`${file}: 库存写入/成本核心路径`])
    })

    it('开关开启后永久红线仍为 blocked（认证/权限/资金/schema/迁移）', () => {
      const plan = planChanges(
        [
          'apps/api/src/routes/auth.ts',
          'apps/api/src/routes/payments.ts',
          'packages/db/prisma/schema.prisma',
          'packages/db/prisma/migrations/20990101000000_x/migration.sql',
        ],
        { allowCoreBusinessApi: true },
      )
      expect(plan.risk).toBe('blocked')
      expect(plan.blocked).toBe(true)
    })

    it.each([
      'apps/web/src/app/v2/orders/page.tsx',
      'apps/web/src/app/v2/inventory/page.tsx',
      'apps/web/src/lib/settlement-format.ts',
    ])('同名前端页面 %s 不误伤（仍为 web/low）', (file) => {
      const plan = planChanges([file])
      expect(plan.risk).toBe('low')
      expect(plan.blocked).toBe(false)
      expect(plan.categories).toEqual(['web'])
      expect(plan.redlines).toEqual([])
      expect(plan.files[0]).toMatchObject({ category: 'web', risk: 'low' })
    })

    it('普通 API 路径（stores/supplierCategory）不命中核心红线', () => {
      const plan = planChanges(['apps/api/src/routes/stores.ts', 'apps/api/src/services/supplierCategory.ts'])
      expect(plan.risk).toBe('medium')
      expect(plan.blocked).toBe(false)
      expect(plan.redlines).toEqual([])
    })
  })

  describe('混合范围取最高风险', () => {
    it('low + medium → medium', () => {
      const plan = planChanges([
        'apps/web/src/lib/a.ts',
        'apps/api/src/routes/stores.ts',
      ])
      expect(plan.risk).toBe('medium')
      expect(plan.categories).toEqual(['web', 'api'])
      // Web 与 API 验证命令各自独立组成
      expect(plan.verification.web).toEqual(WEB_VERIFICATION)
      expect(plan.verification.api).toEqual(API_VERIFICATION)
    })

    it('low + medium + high → high', () => {
      const plan = planChanges([
        'apps/web/src/lib/a.ts',
        'apps/api/src/routes/stores.ts',
        'pnpm-lock.yaml',
      ])
      expect(plan.risk).toBe('high')
      expect(plan.blocked).toBe(false)
    })

    it('任意一项触红线 → 整体 blocked', () => {
      const plan = planChanges([
        'apps/web/src/lib/a.ts',
        'apps/api/src/routes/stores.ts',
        'packages/db/prisma/schema.prisma',
      ])
      expect(plan.risk).toBe('blocked')
      expect(plan.blocked).toBe(true)
      expect(plan.categories).toEqual(['web', 'api', 'database'])
      // 三类验证命令同时存在，互不覆盖
      expect(plan.verification.web).toBeDefined()
      expect(plan.verification.api).toBeDefined()
      expect(plan.verification.database).toBeDefined()
    })
  })

  describe('未知路径必须 blocked', () => {
    it.each([
      'README.md',
      'random/foo.py',
      'vendor/lib/thing.js',
    ])('无法识别的路径 %s → unknown/blocked', (file) => {
      const plan = planChanges([file])
      expect(plan.categories).toEqual(['unknown'])
      expect(plan.risk).toBe('blocked')
      expect(plan.files[0]).toMatchObject({ category: 'unknown', risk: 'blocked', redline: '未知路径' })
    })

    it('非法路径（目录穿越/绝对路径）也按 unknown/blocked 处理，不抛错', () => {
      const plan = planChanges(['../outside.ts', '/etc/passwd'])
      expect(plan.risk).toBe('blocked')
      expect(plan.files.every((f) => f.category === 'unknown' && f.risk === 'blocked')).toBe(true)
      expect(plan.redlines.every((r) => r.includes('非法路径'))).toBe(true)
    })

    it('树内穿越会被规范化，落到 unknown/blocked（仍不放行）', () => {
      const plan = planChanges(['apps/web/src/../../leak.ts'])
      // path.posix.normalize → 'apps/leak.ts'，非任何已知工程区 → unknown
      expect(plan.files[0]).toMatchObject({ path: 'apps/leak.ts', category: 'unknown', risk: 'blocked' })
    })
  })

  describe('去重与稳定排序', () => {
    it('重复路径（含 a/ b/ 前缀与引号变体）只计一次', () => {
      const plan = planChanges([
        'apps/web/src/lib/a.ts',
        'a/apps/web/src/lib/a.ts',
        'b/apps/web/src/lib/a.ts',
        '"apps/web/src/lib/a.ts"',
        'apps/web/src/lib/a.ts\tapps/web/src/lib/a.ts',
      ])
      expect(plan.files).toHaveLength(1)
      expect(plan.files[0].path).toBe('apps/web/src/lib/a.ts')
    })

    it('files 与 redlines 按路径字节序稳定排序，与输入顺序无关', () => {
      const input = [
        'apps/api/src/routes/zebra.ts',
        'apps/web/src/lib/alpha.ts',
        'apps/api/src/routes/mango.ts',
      ]
      const forward = planChanges(input)
      const backward = planChanges([...input].reverse())
      expect(forward).toEqual(backward)
      expect(forward.files.map((f) => f.path)).toEqual([
        'apps/api/src/routes/mango.ts',
        'apps/api/src/routes/zebra.ts',
        'apps/web/src/lib/alpha.ts',
      ])
    })

    it('空输入得到中性结果（low、无命令）', () => {
      const plan = planChanges([])
      expect(plan.files).toEqual([])
      expect(plan.categories).toEqual([])
      expect(plan.risk).toBe('low')
      expect(plan.blocked).toBe(false)
      expect(plan.verification).toEqual({})
    })

    it('空串与 /dev/null 被忽略', () => {
      const plan = planChanges(['', '   ', '/dev/null', 'apps/web/src/lib/a.ts'])
      expect(plan.files).toHaveLength(1)
      expect(plan.risk).toBe('low')
    })
  })
})

describe('planVerificationSteps', () => {
  it('纯 Web 改动只组成单测 + 类型检查两步', () => {
    const steps = planVerificationSteps(['apps/web/src/lib/a.ts'])
    expect(steps.map((s) => s.label)).toEqual(['Web 单测', 'Web 类型检查'])
    expect(steps.every((s) => s.command === 'pnpm' && Array.isArray(s.args))).toBe(true)
  })

  it('纯 API 改动按 单测 → generate → 类型检查 → 构建 顺序组成', () => {
    const steps = planVerificationSteps(['apps/api/src/routes/stores.ts'])
    expect(steps.map((s) => s.label)).toEqual(['API 单测', 'Prisma 客户端生成', 'API 类型检查', 'API 构建'])
    // generate 与类型检查是各自独立的 command+args，绝不拼成 shell 串
    expect(steps[1]).toMatchObject({ command: 'pnpm', args: ['--filter', '@dianjie/db', 'generate'] })
    expect(steps[2]).toMatchObject({ command: 'pnpm', args: ['exec', 'tsc', '-p', 'apps/api/tsconfig.json', '--noEmit'] })
  })

  it('混合改动两套都跑，且 Web 恒在 API 之前（与输入顺序无关）', () => {
    const forward = planVerificationSteps(['apps/api/src/routes/stores.ts', 'apps/web/src/lib/a.ts'])
    const backward = planVerificationSteps(['apps/web/src/lib/a.ts', 'apps/api/src/routes/stores.ts'])
    expect(forward).toEqual(backward)
    expect(forward.map((s) => s.label)).toEqual([
      'Web 单测',
      'Web 类型检查',
      'API 单测',
      'Prisma 客户端生成',
      'API 类型检查',
      'API 构建',
    ])
  })

  it('任何步骤都不含 shell 拼接（无 && / ; / |）', () => {
    const steps = planVerificationSteps(['apps/web/src/lib/a.ts', 'apps/api/src/routes/stores.ts'])
    for (const step of steps) {
      expect(step.command).toBe('pnpm')
      for (const arg of step.args) {
        expect(arg).not.toMatch(/&&|;|\|/)
      }
    }
  })

  it('数据库 / 未知改动不组成任何可执行步骤（由上层范围检查先行拒绝）', () => {
    expect(planVerificationSteps(['packages/db/prisma/schema.prisma'])).toEqual([])
    expect(planVerificationSteps(['README.md'])).toEqual([])
    expect(planVerificationSteps([])).toEqual([])
  })

  it('核心 API 路径本身仍按 api 类别组成步骤——拦截由上层范围检查负责，而非本函数', () => {
    // planVerificationSteps 只做"按类别规划"，不做红线判定；上层 denyPatchFile/findOutOfScopeFiles 先行拒绝。
    expect(planVerificationSteps(['apps/api/src/routes/orders.ts']).map((s) => s.label)).toEqual([
      'API 单测',
      'Prisma 客户端生成',
      'API 类型检查',
      'API 构建',
    ])
  })

  it('核心经营 API 改动（allowCoreBusinessApi=true）额外规划集成测试步骤', () => {
    const testEnv = { DATABASE_URL: 'postgresql://user:pass@localhost:5432/dianjie_test' }
    const steps = planVerificationSteps(['apps/api/src/routes/orders.ts'], {
      allowCoreBusinessApi: true,
      integrationTestEnv: testEnv,
    })
    expect(steps.map((s) => s.label)).toEqual([
      'API 单测',
      'Prisma 客户端生成',
      'API 类型检查',
      'API 构建',
      'API 集成测试（隔离数据库）',
    ])
    const integrationStep = steps[steps.length - 1]
    expect(integrationStep.command).toBe('pnpm')
    expect(integrationStep.args).toEqual(['--filter', '@dianjie/api', 'test:integration'])
    expect(integrationStep.env).toEqual(testEnv)
  })

  it('核心经营 API 改动缺少 integrationTestEnv 时明确失败（不碰数据库）', () => {
    expect(() =>
      planVerificationSteps(['apps/api/src/routes/orders.ts'], { allowCoreBusinessApi: true }),
    ).toThrow('AUTO_FIX_TEST_DATABASE_URL')
  })

  it('非核心 API 改动不规划集成测试步骤（即使传了 integrationTestEnv）', () => {
    const steps = planVerificationSteps(['apps/api/src/routes/stores.ts'], {
      integrationTestEnv: { DATABASE_URL: 'postgresql://x@localhost/db_test' },
    })
    expect(steps.map((s) => s.label)).not.toContain('API 集成测试（隔离数据库）')
  })
})

describe('resolveIntegrationTestEnv', () => {
  it('变量缺失时明确失败（绝不继承生产 DATABASE_URL）', () => {
    expect(() => resolveIntegrationTestEnv({})).toThrow('AUTO_FIX_TEST_DATABASE_URL')
    expect(() => resolveIntegrationTestEnv({ DATABASE_URL: 'postgresql://x@localhost/prod' })).toThrow(
      'AUTO_FIX_TEST_DATABASE_URL',
    )
  })

  it('数据库名不以 _test/_ci 结尾时拒绝（不安全）', () => {
    expect(() =>
      resolveIntegrationTestEnv({ AUTO_FIX_TEST_DATABASE_URL: 'postgresql://user:pass@localhost:5432/dianjie_prod' }),
    ).toThrow('_test 或 _ci')
    expect(() =>
      resolveIntegrationTestEnv({ AUTO_FIX_TEST_DATABASE_URL: 'postgresql://user:pass@localhost:5432/dianjie' }),
    ).toThrow('_test 或 _ci')
  })

  it('合法 _test 后缀通过校验', () => {
    const env = resolveIntegrationTestEnv({
      AUTO_FIX_TEST_DATABASE_URL: 'postgresql://user:pass@localhost:5432/dianjie_test',
    })
    expect(env).toEqual({ DATABASE_URL: 'postgresql://user:pass@localhost:5432/dianjie_test' })
  })

  it('合法 _ci 后缀通过校验', () => {
    const env = resolveIntegrationTestEnv({
      AUTO_FIX_TEST_DATABASE_URL: 'postgresql://user:pass@localhost:5432/dianjie_ci?schema=public',
    })
    expect(env).toEqual({ DATABASE_URL: 'postgresql://user:pass@localhost:5432/dianjie_ci?schema=public' })
  })

  it('postgres:// 短协议同样通过校验', () => {
    const env = resolveIntegrationTestEnv({
      AUTO_FIX_TEST_DATABASE_URL: 'postgres://user:pass@localhost:5432/dianjie_test',
    })
    expect(env).toEqual({ DATABASE_URL: 'postgres://user:pass@localhost:5432/dianjie_test' })
  })

  it('数据库名后缀大小写不敏感（_TEST/_CI 均通过）', () => {
    expect(resolveIntegrationTestEnv({ AUTO_FIX_TEST_DATABASE_URL: 'postgresql://u@h:5432/dianjie_TEST' }))
      .toEqual({ DATABASE_URL: 'postgresql://u@h:5432/dianjie_TEST' })
    expect(resolveIntegrationTestEnv({ AUTO_FIX_TEST_DATABASE_URL: 'postgresql://u@h:5432/dianjie_CI' }))
      .toEqual({ DATABASE_URL: 'postgresql://u@h:5432/dianjie_CI' })
  })

  it('非 PostgreSQL 协议拒绝（mysql/http 等）', () => {
    expect(() =>
      resolveIntegrationTestEnv({ AUTO_FIX_TEST_DATABASE_URL: 'mysql://user:pass@localhost:3306/dianjie_test' }),
    ).toThrow('PostgreSQL')
    expect(() =>
      resolveIntegrationTestEnv({ AUTO_FIX_TEST_DATABASE_URL: 'http://localhost:5432/dianjie_test' }),
    ).toThrow('PostgreSQL')
  })

  it('无法解析的 URL 拒绝', () => {
    expect(() =>
      resolveIntegrationTestEnv({ AUTO_FIX_TEST_DATABASE_URL: 'not-a-valid-url' }),
    ).toThrow('无法解析')
    expect(() =>
      resolveIntegrationTestEnv({ AUTO_FIX_TEST_DATABASE_URL: '://missing-protocol' }),
    ).toThrow('无法解析')
  })
})

describe('planDeploymentComponents', () => {
  it('只有 apps/web/src 源码触发 Web 部署', () => {
    expect(planDeploymentComponents(['apps/web/src/lib/a.ts'])).toEqual({
      components: ['web'],
      web: true,
      api: false,
    })
  })

  it('只有 apps/api/src 源码触发 API 部署', () => {
    expect(planDeploymentComponents(['apps/api/src/routes/stores.ts'])).toEqual({
      components: ['api'],
      web: false,
      api: true,
    })
  })

  it('混合改动按 web → api 固定顺序部署', () => {
    expect(planDeploymentComponents(['apps/api/src/routes/stores.ts', 'apps/web/src/lib/a.ts'])).toEqual({
      components: ['web', 'api'],
      web: true,
      api: true,
    })
  })

  it('测试与构建配置不进入运行产物，不触发部署', () => {
    expect(planDeploymentComponents(['apps/api/tests/services/foo.test.ts'])).toEqual({
      components: [],
      web: false,
      api: false,
    })
    expect(planDeploymentComponents(['apps/web/next.config.js'])).toEqual({
      components: [],
      web: false,
      api: false,
    })
    expect(planDeploymentComponents([])).toEqual({ components: [], web: false, api: false })
  })
})

describe('runVerificationSteps', () => {
  it('顺序执行并合并尾部日志', async () => {
    const log = await runVerificationSteps(
      [
        { label: '步骤A', command: 'node', args: ['-e', 'console.log("hello-a")'], timeoutMs: 10_000 },
        { label: '步骤B', command: 'node', args: ['-e', 'console.log("hello-b")'], timeoutMs: 10_000 },
      ],
      { cwd: process.cwd() },
    )
    expect(log).toContain('$ 步骤A')
    expect(log).toContain('hello-a')
    expect(log).toContain('$ 步骤B')
    expect(log).toContain('hello-b')
  })

  it('强制注入 NODE_ENV=test 与 CI=1', async () => {
    const log = await runVerificationSteps(
      [{ label: 'env', command: 'node', args: ['-e', 'console.log(process.env.NODE_ENV + "/" + process.env.CI)'], timeoutMs: 10_000 }],
      { cwd: process.cwd(), env: { NODE_ENV: 'production' } },
    )
    expect(log).toContain('test/1')
  })

  it('任一步骤失败即带上标签向上抛出', async () => {
    await expect(
      runVerificationSteps(
        [{ label: '坏步骤', command: 'node', args: ['-e', 'console.error("boom"); process.exit(1)'], timeoutMs: 10_000 }],
        { cwd: process.cwd() },
      ),
    ).rejects.toThrow('独立复验失败（坏步骤）')
  })
})
