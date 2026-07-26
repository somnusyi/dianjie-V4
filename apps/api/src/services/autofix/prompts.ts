import type { SourceFile } from './repository'

export function buildAnalysisPrompt(input: {
  title?: string | null
  summary?: string | null
  contextPath: string
  messages: Array<{ role: string; content: string }>
  sources: SourceFile[]
}): string {
  return `你是滇界系统的只读反馈定位助手。反馈已经由管理员批准。只分析，不生成命令，不修改数据库。

反馈标题: ${input.title || '未命名'}
反馈摘要: ${input.summary || '无'}
页面路径: ${input.contextPath}
反馈对话:
${input.messages.map((message) => `[${message.role}] ${message.content}`).join('\n')}

候选源码:
${input.sources.map((source) => `--- ${source.path}\n${source.content}`).join('\n\n')}

只输出一个 JSON 对象，不要 Markdown:
{"rootCause":"明确定位结论或实现方案","candidateFiles":["仓库相对路径"],"inWhitelist":true,"confidence":0.0}

如果需求不明确、无法确定，或需要认证、权限、资金、库存写入、数据库、依赖、通知或部署配置变更，
inWhitelist 必须为 false。`
}

export function buildPatchPrompt(input: {
  analysis: string
  contextPath: string
  sources: SourceFile[]
}): string {
  return `你是滇界系统的补丁生成器。根据已确认的定位结论生成最小 unified diff。

页面路径: ${input.contextPath}
定位结论: ${input.analysis}

可修改源码:
${input.sources.map((source) => `--- ${source.path}\n${source.content}`).join('\n\n')}

硬规则:
- 只能修改上面列出的 Web 展示文件或同目录测试
- 不得修改认证、权限、资金、库存写入、数据库、依赖、通知、部署配置
- 不得删除或重命名文件
- 最多 5 个文件、总变更不超过 200 行
- 输出必须从 "diff --git" 开始，只输出 unified diff，不要解释、不要 Markdown 围栏`
}

export interface AnalysisResult {
  rootCause: string
  candidateFiles: string[]
  inWhitelist: boolean
  confidence: number
}

export function parseAnalysisResult(raw: string): AnalysisResult {
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('AI 定位结果不是 JSON')
  const parsed = JSON.parse(unfenced.slice(start, end + 1))
  if (
    typeof parsed.rootCause !== 'string'
    || !parsed.rootCause.trim()
    || !Array.isArray(parsed.candidateFiles)
    || typeof parsed.inWhitelist !== 'boolean'
    || typeof parsed.confidence !== 'number'
  ) {
    throw new Error('AI 定位结果字段不完整')
  }
  return {
    rootCause: parsed.rootCause.trim().slice(0, 4000),
    candidateFiles: parsed.candidateFiles.filter((file: unknown) => typeof file === 'string').slice(0, 5),
    inWhitelist: parsed.inWhitelist,
    confidence: Math.max(0, Math.min(1, parsed.confidence)),
  }
}

export function extractUnifiedDiff(raw: string): string {
  const fenced = /```(?:diff|patch)?\s*\n([\s\S]*?)```/i.exec(raw)?.[1]
  const candidate = (fenced || raw).trim()
  const start = candidate.indexOf('diff --git ')
  if (start < 0) throw new Error('AI 未返回 unified diff')
  return `${candidate.slice(start).trim()}\n`
}
