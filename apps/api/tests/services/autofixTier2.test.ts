import { describe, expect, it } from 'vitest'
import {
  buildAgentBrief,
  buildTaskBookPrompt,
  findOutOfScopeFiles,
  findUntrackedFiles,
  parseChangedPaths,
} from '../../src/services/autofix/tier2'

describe('parseChangedPaths', () => {
  it('提取修改与删除的路径并过滤 node_modules', () => {
    const porcelain = [
      ' M apps/web/src/app/v2/page.tsx',
      'D  apps/web/src/lib/a.ts',
      '?? node_modules',
      ' M apps/api/src/routes/x.ts',
      '',
    ].join('\n')
    expect(parseChangedPaths(porcelain)).toEqual([
      'apps/web/src/app/v2/page.tsx',
      'apps/web/src/lib/a.ts',
      'apps/api/src/routes/x.ts',
    ])
  })

  it('处理重命名与引号路径，并去重', () => {
    const porcelain = 'R  apps/web/a.ts -> apps/web/b.ts\n M "apps/web/src/空格 file.ts"\n M apps/web/b.ts\n'
    expect(parseChangedPaths(porcelain)).toEqual(['apps/web/b.ts', 'apps/web/src/空格 file.ts'])
  })

  it('空输出返回空数组', () => {
    expect(parseChangedPaths('')).toEqual([])
  })
})

describe('findOutOfScopeFiles', () => {
  it('apps/web 内全部通过', () => {
    expect(findOutOfScopeFiles(['apps/web/a.ts', 'apps/web/src/lib/b.ts'])).toEqual([])
  })

  it('揪出 API / db / 根目录改动', () => {
    expect(
      findOutOfScopeFiles(['apps/web/a.ts', 'apps/api/src/routes/products.ts', 'packages/db/prisma/schema.prisma', 'README.md']),
    ).toEqual(['apps/api/src/routes/products.ts', 'packages/db/prisma/schema.prisma', 'README.md'])
  })

  it('拒绝伪装前缀', () => {
    expect(findOutOfScopeFiles(['apps/webhook/x.ts'])).toEqual(['apps/webhook/x.ts'])
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

  it('写死安全约束：web限定/禁新文件/REJECT出口/验收命令', () => {
    expect(prompt).toContain('REJECT:')
    expect(prompt).toContain('不得新建、删除、重命名')
    expect(prompt).toContain('pnpm --filter @dianjie/web test')
    expect(prompt).toContain('tsc -p apps/web/tsconfig.json --noEmit')
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
  })
})
