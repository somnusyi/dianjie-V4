import { describe, expect, it, vi } from 'vitest'

// planDeployment 是纯函数，但 deployment.ts 顶层 import 了 prisma/通知模块；
// 与既有部署测试一致地 mock 掉，确保单测绝不触碰数据库或生产。
const mocks = vi.hoisted(() => ({
  autoFixRun: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  opLog: { create: vi.fn() },
}))

vi.mock('@dianjie/db', () => ({
  prisma: { autoFixRun: mocks.autoFixRun, opLog: mocks.opLog },
}))
vi.mock('../../src/services/notification', () => ({ sendNotification: vi.fn() }))
vi.mock('../../src/services/notify', () => ({ fireAndForget: vi.fn() }))

import {
  planDeployment,
  type DeploymentPlan,
} from '../../src/services/autofix/deployment'

const REPO = '/candidate/worktree'
const TARGET = '/app/dianjie-v4'

function plan(changedPaths: string[], repo = REPO): DeploymentPlan {
  return planDeployment({ repo, target: TARGET, runId: 'run-x', changedPaths, timestamp: 1_700_000_000_000 })
}

/** 收集计划里所有命令，用于"绝不拼 shell"等全局断言。 */
function allCommands(p: DeploymentPlan) {
  return [...p.builds, ...p.backups, ...p.syncs, ...p.restarts]
}

describe('planDeployment（不触碰生产的纯计划）', () => {
  describe('Web-only', () => {
    it('只构建/备份/同步/重启 Web，沿用 standalone/static/public 三段同步', () => {
      const p = plan(['apps/web/src/app/v2/supply-chain/home/page.tsx'])
      expect(p.components).toEqual(['web'])
      expect(p.web).toBe(true)
      expect(p.api).toBe(false)
      expect(p.noRuntime).toBe(false)

      expect(p.builds).toHaveLength(1)
      expect(p.builds[0]).toMatchObject({ command: 'pnpm', args: ['--filter', '@dianjie/web', 'build'], cwd: REPO })

      expect(p.backupDirs).toEqual(['apps/web/apps/web'])
      const tar = p.backups.find((c) => c.command === 'tar')!
      expect(tar.args).toContain('apps/web/apps/web')
      expect(p.backupArchivePath).toContain('autofix-web-run-x-')

      expect(p.syncs.map((c) => c.label)).toEqual(['Web 同步 standalone', 'Web 同步 static', 'Web 同步 public'])
      for (const sync of p.syncs) {
        expect(sync.command).toBe('rsync')
        // 目标落在生产 Web 目录
        expect(sync.args[sync.args.length - 1]).toContain(`${TARGET}/apps/web/apps/web`)
      }

      expect(p.restarts).toHaveLength(1)
      expect(p.restarts[0]).toMatchObject({ command: 'pm2', args: ['restart', 'dianjie-v4-web'] })
      // 绝不带 --update-env（避免 API 的 PORT=4004 污染 Web 3204）
      expect(p.restarts[0].args).not.toContain('--update-env')
    })
  })

  describe('API-only', () => {
    it('只构建/备份/同步/重启 API，且仅同步 dist 编译产物', () => {
      const p = plan(['apps/api/src/routes/stores.ts'])
      expect(p.components).toEqual(['api'])
      expect(p.web).toBe(false)
      expect(p.api).toBe(true)

      expect(p.builds).toHaveLength(1)
      expect(p.builds[0]).toMatchObject({ command: 'pnpm', args: ['--filter', '@dianjie/api', 'build'], cwd: REPO })

      expect(p.backupDirs).toEqual(['apps/api/dist'])
      expect(p.backupArchivePath).toContain('autofix-api-run-x-')

      expect(p.syncs).toHaveLength(1)
      const sync = p.syncs[0]
      expect(sync.command).toBe('rsync')
      expect(sync.args).toContain(`${REPO}/apps/api/dist/`)
      expect(sync.args[sync.args.length - 1]).toBe(`${TARGET}/apps/api/dist/`)

      expect(p.restarts).toHaveLength(1)
      expect(p.restarts[0]).toMatchObject({ command: 'pm2', args: ['restart', 'dianjie-v4-api'] })
      expect(p.restarts[0].args).not.toContain('--update-env')
    })

    it('绝不同步 package/schema/migration/依赖/环境变量', () => {
      const p = plan(['apps/api/src/routes/stores.ts'])
      const serialized = JSON.stringify(allCommands(p))
      for (const forbidden of ['package.json', 'schema.prisma', 'migrations', 'node_modules', '.env', 'pnpm-lock']) {
        expect(serialized).not.toContain(forbidden)
      }
    })
  })

  describe('混合（Web + API）', () => {
    it('两边都构建，单个 tar 备份两个生产目录，再各自同步重启', () => {
      const p = plan(['apps/web/src/lib/a.ts', 'apps/api/src/routes/stores.ts'])
      expect(p.components).toEqual(['web', 'api'])
      expect(p.noRuntime).toBe(false)

      // 两个构建命令（Web 在前，API 在后）
      expect(p.builds.map((c) => c.label)).toEqual(['Web 构建', 'API 构建'])

      // 统一备份：一个 tar 同时包含两个受影响生产目录
      expect(p.backupDirs).toEqual(['apps/web/apps/web', 'apps/api/dist'])
      const tars = p.backups.filter((c) => c.command === 'tar')
      expect(tars).toHaveLength(1)
      expect(tars[0].args).toContain('apps/web/apps/web')
      expect(tars[0].args).toContain('apps/api/dist')
      expect(p.backupArchivePath).toContain('autofix-web-api-run-x-')

      // 同步：Web 三段 + API 一段
      expect(p.syncs).toHaveLength(4)
      // 重启：两个进程
      expect(p.restarts.map((c) => c.args[1])).toEqual(['dianjie-v4-web', 'dianjie-v4-api'])
    })
  })

  describe('测试-only（无运行组件）', () => {
    it.each([
      [['apps/api/tests/services/foo.test.ts']],
      [['apps/api/tests/routes/bar.test.ts']],
      [['apps/web/next.config.js']],
      [[]],
    ])('不构建/不备份/不同步/不重启: %j', (paths) => {
      const p = plan(paths)
      expect(p.noRuntime).toBe(true)
      expect(p.components).toEqual([])
      expect(p.builds).toEqual([])
      expect(p.backups).toEqual([])
      expect(p.syncs).toEqual([])
      expect(p.restarts).toEqual([])
      expect(p.backupArchivePath).toBeNull()
    })
  })

  describe('阶段顺序与命令安全', () => {
    it('构建/备份/同步/重启彼此分离，供执行器按 build→backup→sync→restart 顺序运行', () => {
      const p = plan(['apps/web/src/lib/a.ts', 'apps/api/src/routes/stores.ts'])
      // 构建阶段不含任何 rsync/pm2；备份阶段不含构建/同步/重启
      expect(p.builds.every((c) => c.command === 'pnpm')).toBe(true)
      expect(p.backups.every((c) => c.command === 'mkdir' || c.command === 'tar')).toBe(true)
      expect(p.syncs.every((c) => c.command === 'rsync')).toBe(true)
      expect(p.restarts.every((c) => c.command === 'pm2')).toBe(true)
    })

    it('所有命令均为 command+args，绝不拼 shell（无 && / ; / |）', () => {
      const p = plan(['apps/web/src/lib/a.ts', 'apps/api/src/routes/stores.ts'])
      for (const cmd of allCommands(p)) {
        expect(typeof cmd.command).toBe('string')
        expect(Array.isArray(cmd.args)).toBe(true)
        for (const arg of cmd.args) {
          expect(arg).not.toMatch(/&&|;|\|/)
        }
      }
    })

    it('注入相同时间戳时计划确定（相同输入恒得相同输出）', () => {
      const a = plan(['apps/api/src/routes/stores.ts'])
      const b = plan(['apps/api/src/routes/stores.ts'])
      expect(a).toEqual(b)
      expect(a.backupArchivePath).toBe(`${'/app/backups'}/autofix-api-run-x-1700000000000.tar.gz`)
    })
  })

  describe('正常/回滚组件计划一致性', () => {
    it.each([
      ['Web-only', ['apps/web/src/lib/a.ts']],
      ['API-only', ['apps/api/src/routes/stores.ts']],
      ['混合', ['apps/web/src/lib/a.ts', 'apps/api/src/routes/stores.ts']],
    ])('%s：正常发布与恢复使用相同 changedPaths → 相同组件与生产目标', (_label, paths) => {
      const deploy = planDeployment({
        repo: '/candidate/worktree', target: TARGET, runId: 'run-x', changedPaths: paths, timestamp: 1,
      })
      const recovery = planDeployment({
        repo: '/app/dianjie-src', target: TARGET, runId: 'run-x-rollback', changedPaths: paths, timestamp: 1,
      })

      // 组件与受影响生产目录完全一致
      expect(recovery.components).toEqual(deploy.components)
      expect(recovery.backupDirs).toEqual(deploy.backupDirs)
      expect(recovery.web).toBe(deploy.web)
      expect(recovery.api).toBe(deploy.api)

      // 同步目标（生产路径）一致，仅来源 repo 不同
      expect(recovery.syncs.map((c) => c.args[c.args.length - 1]))
        .toEqual(deploy.syncs.map((c) => c.args[c.args.length - 1]))
      // 重启的进程一致
      expect(recovery.restarts.map((c) => c.args)).toEqual(deploy.restarts.map((c) => c.args))
    })

    it('混合改动的恢复绝不退化为只恢复 Web（API 组件仍在）', () => {
      const paths = ['apps/web/src/lib/a.ts', 'apps/api/src/routes/stores.ts']
      const recovery = planDeployment({
        repo: '/app/dianjie-src', target: TARGET, runId: 'run-x-rollback', changedPaths: paths, timestamp: 1,
      })
      expect(recovery.api).toBe(true)
      expect(recovery.restarts.map((c) => c.args[1])).toContain('dianjie-v4-api')
      expect(recovery.backupDirs).toContain('apps/api/dist')
    })
  })
})
