import { describe, expect, it } from 'vitest'
import {
  API_VERIFICATION,
  DATABASE_MIGRATE_COMMAND,
  WEB_VERIFICATION,
  planChanges,
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
      ['apps/api/src/services/inventoryCosting.ts', '库存成本'],
      ['apps/api/src/services/storeInventory.ts', '库存成本'],
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
