import { describe, expect, it } from 'vitest'
import {
  buildAgentBrief,
  buildTaskBookPrompt,
  findOutOfScopeFiles,
  findUntrackedFiles,
  isTransientAgentError,
  isVerifiedNoChangeOutput,
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

describe('isVerifiedNoChangeOutput', () => {
  it.each([
    'NO_CHANGE: 当前代码已处理该场景',
    '检查后确认当前代码已经实现了该需求，无需修改代码。',
    'No code changes required because the fix is already implemented.',
  ])('识别 agent 明确的零改动结论: %s', (output) => {
    expect(isVerifiedNoChangeOutput(output)).toBe(true)
  })

  it.each(['', '我检查了相关代码。', '测试通过。'])('含糊或空输出不误判为已解决: %s', (output) => {
    expect(isVerifiedNoChangeOutput(output)).toBe(false)
  })
})

describe('isTransientAgentError', () => {
  it.each([
    new Error('TRANSIENT_QWEN: process killed'),
    new Error('request failed with ECONNRESET'),
    new Error('429 rate limit'),
  ])('识别可自动重试的临时故障', (error) => {
    expect(isTransientAgentError(error)).toBe(true)
  })

  it.each([
    new Error('触碰硬红线路径'),
    new Error('独立复验失败'),
    new Error('Qwen Code 未产生任何改动'),
  ])('策略/测试/业务失败不盲目自动重试', (error) => {
    expect(isTransientAgentError(error)).toBe(false)
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

  it('揪出核心库存写入/成本 API 改动（含 core_business 的 inventoryCosting/storeInventory 等）', () => {
    expect(
      findOutOfScopeFiles([
        'apps/web/src/lib/b.ts',
        'apps/api/src/routes/orders.ts',
        'apps/api/src/services/inventoryCosting.ts',
        'apps/api/src/services/storeInventory.ts',
        'apps/api/src/services/receiptSettlement.ts',
        'apps/api/src/services/receiptDerivatives.ts',
      ]),
    ).toEqual([
      'apps/api/src/routes/orders.ts',
      'apps/api/src/services/inventoryCosting.ts',
      'apps/api/src/services/storeInventory.ts',
      'apps/api/src/services/receiptSettlement.ts',
      'apps/api/src/services/receiptDerivatives.ts',
    ])
  })

  it('allowCoreBusinessApi=true 时放行核心经营 API src/test，仍拒绝永久红线', () => {
    const opts = { allowCoreBusinessApi: true }
    // 核心经营 API 放行（含本阶段允许的 4 个文件）
    expect(findOutOfScopeFiles(['apps/api/src/routes/orders.ts'], opts)).toEqual([])
    expect(findOutOfScopeFiles(['apps/api/tests/inventory.test.ts'], opts)).toEqual([])
    expect(findOutOfScopeFiles(['apps/api/src/services/storeInventory.ts'], opts)).toEqual([])
    expect(findOutOfScopeFiles(['apps/api/src/services/receiptSettlement.ts'], opts)).toEqual([])
    expect(findOutOfScopeFiles(['apps/api/src/services/receiptDerivatives.ts'], opts)).toEqual([])
    expect(findOutOfScopeFiles(['apps/api/src/services/inventoryCosting.ts'], opts)).toEqual([])
    // 永久红线仍拒绝
    expect(findOutOfScopeFiles(['apps/api/src/routes/auth.ts'], opts)).toEqual(['apps/api/src/routes/auth.ts'])
    expect(findOutOfScopeFiles(['apps/api/src/routes/payments.ts'], opts)).toEqual(['apps/api/src/routes/payments.ts'])
    expect(findOutOfScopeFiles(['apps/api/src/routes/paymentRequests.ts'], opts)).toEqual(['apps/api/src/routes/paymentRequests.ts'])
    expect(findOutOfScopeFiles(['apps/api/src/routes/capital.ts'], opts)).toEqual(['apps/api/src/routes/capital.ts'])
    expect(findOutOfScopeFiles(['apps/api/src/services/paymentMutex.ts'], opts)).toEqual(['apps/api/src/services/paymentMutex.ts'])
    expect(findOutOfScopeFiles(['apps/api/src/services/cmbAutoSync.ts'], opts)).toEqual(['apps/api/src/services/cmbAutoSync.ts'])
    expect(findOutOfScopeFiles(['packages/db/prisma/schema.prisma'], opts)).toEqual(['packages/db/prisma/schema.prisma'])
    // 非核心 API 与 Web 行为不变
    expect(findOutOfScopeFiles(['apps/api/src/routes/stores.ts', 'apps/web/src/lib/a.ts'], opts)).toEqual([])
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

  it('核心经营 API 改动（allowCoreBusinessApi=true）摘要包含隔离数据库集成测试', () => {
    const summary = verificationSummary(['apps/api/src/routes/orders.ts'], { allowCoreBusinessApi: true })
    expect(summary).toContain('API 测试、类型检查与构建')
    expect(summary).toContain('隔离数据库集成测试')
  })

  it('核心经营 API 改动默认（未开启开关）摘要不含集成测试（risk=blocked，不进入复验）', () => {
    const summary = verificationSummary(['apps/api/src/routes/orders.ts'])
    expect(summary).not.toContain('隔离数据库集成测试')
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
    expect(prompt).toContain('apps/api/src、apps/api/tests 下的 TypeScript')
    // Web 与 API 两套验收命令都要点名
    expect(prompt).toContain('pnpm --filter @dianjie/web test')
    expect(prompt).toContain('tsc -p apps/web/tsconfig.json --noEmit')
    expect(prompt).toContain('pnpm --filter @dianjie/api test')
    expect(prompt).toContain('pnpm --filter @dianjie/db generate')
    expect(prompt).toContain('pnpm --filter @dianjie/api build')
    // 默认（未开启核心 API）：核心库存写入仍被列为禁区
    expect(prompt).toContain('核心库存写入')
  })

  it('allowCoreBusinessApi=true 时任务书文案说明核心经营 API 已开启', () => {
    const corePrompt = buildTaskBookPrompt({
      title: '库存调整',
      summary: '需要修改库存逻辑',
      contextPath: '/v2/inventory',
      messages: [{ role: 'user', content: '库存不对' }],
      rootCause: '库存计算错误',
      candidateFiles: ['apps/api/src/routes/inventory.ts'],
      allowCoreBusinessApi: true,
    })
    expect(corePrompt).toContain('AUTO_FIX_CORE_API_ENABLED=true')
    expect(corePrompt).toContain('核心经营')
    // 永久红线仍在
    expect(corePrompt).toContain('认证、权限、资金')
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
    expect(brief).toContain('NO_CHANGE:')
    expect(brief).toContain('apps/web')
    // 放开非核心 API：点名 API 验收命令与白名单，同时保留核心库存写入禁区
    expect(brief).toContain('apps/api/src、apps/api/tests 下的 TypeScript')
    expect(brief).toContain('pnpm --filter @dianjie/api test')
    expect(brief).toContain('pnpm --filter @dianjie/db generate')
    expect(brief).toContain('pnpm --filter @dianjie/api build')
    expect(brief).toContain('核心库存写入')
  })

  it('allowCoreBusinessApi=true 时简报说明核心经营 API 已开启', () => {
    const coreBrief = buildAgentBrief({
      title: '库存调整',
      summary: '需要修改库存逻辑',
      contextPath: '/v2/inventory',
      messages: [{ role: 'user', content: '库存不对' }],
      allowCoreBusinessApi: true,
    })
    expect(coreBrief).toContain('AUTO_FIX_CORE_API_ENABLED=true')
    expect(coreBrief).toContain('核心经营')
    // 永久红线仍在
    expect(coreBrief).toContain('认证、权限、资金')
  })
})
