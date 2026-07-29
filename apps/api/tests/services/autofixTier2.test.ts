import { describe, expect, it } from 'vitest'
import {
  buildAgentBrief,
  buildTaskBookPrompt,
  findOutOfScopeFiles,
  findUntrackedFiles,
  parseChangedPaths,
  verificationSummary,
} from '../../src/services/autofix/tier2'

describe('parseChangedPaths', () => {
  it('提取变更路径并过滤 node_modules（diff --name-only -z 格式）', () => {
    const nameOnlyZ = [
      'apps/web/src/app/v2/page.tsx',
      'apps/web/src/lib/a.ts',
      'node_modules',
      'apps/api/src/routes/x.ts',
      '',
    ].join('\0')
    expect(parseChangedPaths(nameOnlyZ)).toEqual([
      'apps/web/src/app/v2/page.tsx',
      'apps/web/src/lib/a.ts',
      'apps/api/src/routes/x.ts',
    ])
  })

  it('处理带引号路径并去重', () => {
    const nameOnlyZ = '"apps/web/src/空格 file.ts"\0apps/web/b.ts\0apps/web/b.ts\0'
    expect(parseChangedPaths(nameOnlyZ)).toEqual(['apps/web/src/空格 file.ts', 'apps/web/b.ts'])
  })

  it('空输出返回空数组', () => {
    expect(parseChangedPaths('')).toEqual([])
  })
})

describe('findOutOfScopeFiles', () => {
  it('Web 源码、非核心 API 源码与 API 测试全通过', () => {
    expect(
      findOutOfScopeFiles([
        'apps/web/src/app/v2/page.tsx',
        'apps/web/src/lib/b.ts',
        'apps/api/src/routes/stores.ts',
        'apps/api/tests/services/stores.test.ts',
      ]),
    ).toEqual([])
  })

  it('揪出核心库存写入/成本 API 改动（含命中硬红线的 inventoryCosting）', () => {
    expect(
      findOutOfScopeFiles([
        'apps/web/src/lib/b.ts',
        'apps/api/src/routes/orders.ts',
        'apps/api/src/services/inventoryCosting.ts',
      ]),
    ).toEqual(['apps/api/src/routes/orders.ts', 'apps/api/src/services/inventoryCosting.ts'])
  })

  it('揪出 db / 未知 / 非 src 前端 / 受保护前端改动', () => {
    expect(
      findOutOfScopeFiles([
        'apps/web/a.ts',
        'apps/web/src/app/v2/layout.tsx',
        'packages/db/prisma/schema.prisma',
        'README.md',
      ]),
    ).toEqual(['apps/web/a.ts', 'apps/web/src/app/v2/layout.tsx', 'packages/db/prisma/schema.prisma', 'README.md'])
  })

  it('拒绝伪装前缀', () => {
    expect(findOutOfScopeFiles(['apps/webhook/x.ts'])).toEqual(['apps/webhook/x.ts'])
  })
})

describe('verificationSummary', () => {
  it('按实际改动范围描述独立复验（Web/API/混合）', () => {
    expect(verificationSummary(['apps/web/src/lib/a.ts'])).toBe('Web 测试与类型检查')
    expect(verificationSummary(['apps/api/src/routes/stores.ts'])).toBe('API 测试、类型检查与构建')
    expect(verificationSummary(['apps/web/src/lib/a.ts', 'apps/api/src/routes/stores.ts'])).toBe(
      'Web 测试与类型检查、API 测试、类型检查与构建',
    )
  })

  it('无可验证改动（空/数据库/未知）返回兜底文案', () => {
    expect(verificationSummary([])).toBe('无可验证改动')
    expect(verificationSummary(['packages/db/prisma/schema.prisma'])).toBe('无可验证改动')
    expect(verificationSummary(['README.md'])).toBe('无可验证改动')
  })
})

describe('findUntrackedFiles', () => {
  it('只抓未跟踪文件，过滤 node_modules', () => {
    const porcelain = ' M apps/web/a.ts\n?? apps/web/src/lib/new.ts\n?? node_modules\n?? "apps/web/src/新 文件.ts"\n'
    expect(findUntrackedFiles(porcelain)).toEqual(['apps/web/src/lib/new.ts', 'apps/web/src/新 文件.ts'])
  })

  it('无未跟踪文件返回空', () => {
    expect(findUntrackedFiles(' M apps/web/a.ts\n')).toEqual([])
  })
})

describe('buildTaskBookPrompt', () => {
  const prompt = buildTaskBookPrompt({
    title: '分类管理',
    summary: '希望调整分类',
    contextPath: '/v2/supply-chain/products',
    messages: [{ role: 'user', content: '分类需要调整' }],
    rootCause: '缺少入口',
    candidateFiles: ['apps/web/src/app/v2/supply-chain/products/page.tsx'],
  })

  it('包含反馈上下文与档1结论', () => {
    expect(prompt).toContain('分类管理')
    expect(prompt).toContain('/v2/supply-chain/products')
    expect(prompt).toContain('缺少入口')
    expect(prompt).toContain('[user] 分类需要调整')
  })

  it('写死安全约束：白名单/禁删改/REJECT出口/按范围验收命令', () => {
    expect(prompt).toContain('REJECT:')
    expect(prompt).toContain('不得删除、重命名文件')
    expect(prompt).toContain('apps/api/src、apps/api/tests 下的**非核心** TypeScript')
    // Web 与 API 两套验收命令都要点名
    expect(prompt).toContain('pnpm --filter @dianjie/web test')
    expect(prompt).toContain('tsc -p apps/web/tsconfig.json --noEmit')
    expect(prompt).toContain('pnpm --filter @dianjie/api test')
    expect(prompt).toContain('pnpm --filter @dianjie/db generate')
    expect(prompt).toContain('pnpm --filter @dianjie/api build')
    // 核心库存写入仍被列为禁区
    expect(prompt).toContain('核心库存写入')
  })
})

describe('buildAgentBrief', () => {
  const brief = buildAgentBrief({
    title: '按钮点不动',
    summary: '提交无反应',
    contextPath: '/v2/orders',
    messages: [{ role: 'user', content: '提交按钮没反应' }],
  })

  it('包含反馈全文与页面路径', () => {
    expect(brief).toContain('按钮点不动')
    expect(brief).toContain('/v2/orders')
    expect(brief).toContain('[user] 提交按钮没反应')
  })

  it('写死 agent 工作方式与安全约束', () => {
    expect(brief).toContain('pnpm --filter @dianjie/web test')
    expect(brief).toContain('tsc -p apps/web/tsconfig.json --noEmit')
    expect(brief).toContain('不得删除、重命名文件')
    expect(brief).toContain('REJECT:')
    expect(brief).toContain('apps/web')
    // 放开非核心 API：点名 API 验收命令与白名单，同时保留核心库存写入禁区
    expect(brief).toContain('apps/api/src、apps/api/tests 下的非核心 TypeScript')
    expect(brief).toContain('pnpm --filter @dianjie/api test')
    expect(brief).toContain('pnpm --filter @dianjie/db generate')
    expect(brief).toContain('pnpm --filter @dianjie/api build')
    expect(brief).toContain('核心库存写入')
  })
})
