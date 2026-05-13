/**
 * 老板 PC Web · 人员管理 (P0 新增)  PDF: boss_web_personnel
 * 替代独立 Web 后台 · KPI 4 格 + segmented + 分组表格 + 月度新增基层员工独立卡
 */
'use client'
import { Chip, MetricTile } from '@/components/v2'
import BossTopNav from '../_topnav'
import { useState } from 'react'

const KPIS = [
  { label: '集团角色', value: '3', sub: '老板 1 · 总厨 1 · 财务 1' },
  { label: '门店人员', value: '16', sub: '店长 8 · 厨师长 8' },
  { label: '基层员工', value: '142', sub: '本月新增 12' },
  { label: '供应商账号', value: '8', sub: '主账号 8 · 子账号 11' },
]
const QUEUE = [
  { label: '本月调动', value: '2',  sub: '店长 1 · 基层 1' },
  { label: '待审账号变更', value: '1', sub: '手机号变更', red: true },
]
const ROWS_GROUP = [
  { name: '王大伟', role: '老板', meta: '创始账号', dept: '—',     joined: '2024-01-15', phone: '13800001234', status: '活跃', op: '— (创始账号)' },
  { name: '陈大厨', role: '总厨', dept: '集团',     joined: '2024-10-08', phone: '13800002345', status: '活跃' },
  { name: '刘财务', role: '财务', dept: '集团',     joined: '2025-07-20', phone: '13800003456', status: '活跃', alert: true },
]
const ROWS_STORE = [
  { name: '张店长', role: '店长',   dept: '朝阳大悦城店', joined: '2024-06-01' },
  { name: '李厨师长', role: '厨师长', dept: '朝阳大悦城店', joined: '2024-06-01' },
  { name: '孙店长', role: '店长',   dept: '国贸店',       joined: '2024-08-15' },
  { name: '赵厨师长', role: '厨师长', dept: '国贸店',       joined: '2024-08-15' },
  { name: '钱店长', role: '店长',   dept: '望京 SOHO 店', joined: '2025-01-08' },
  { name: '周店长', role: '店长',   dept: '三里屯店',     joined: '2024-09-22' },
]
const NEW_STAFF = [
  { name: '小李', pos: '服务员',  store: '朝阳大悦城店', creator: '张店长', date: '2026-04-22' },
  { name: '小王', pos: '收银员',  store: '朝阳大悦城店', creator: '张店长', date: '2026-04-20' },
  { name: '小陈', pos: '传菜员',  store: '国贸店',       creator: '孙店长', date: '2026-04-18' },
]

export default function BossWebPersonnelPage() {
  const [filter, setFilter] = useState<'全部' | '集团' | '店长' | '厨师长' | '基层' | '供应商'>('全部')
  return (
    <div className="min-h-screen bg-bg">
      <BossTopNav />
      <main className="max-w-[1440px] mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-h1">人员管理</h1>
            <p className="text-caption text-gray3">全部人员 · 集团 18 + 门店 16 + 基层 142 + 供应商 8</p>
          </div>
          <div className="flex items-center gap-3">
            <input className="px-3 py-2 rounded-cta border border-border bg-white text-button w-72" placeholder="搜索姓名 / 手机 / 门店" />
            <button className="px-4 py-2 bg-white border border-border rounded-cta text-button text-gray2">导出名单</button>
            <button className="px-4 py-2 bg-ink text-white rounded-cta text-button">+ 新增人员</button>
          </div>
        </div>

        <div className="grid grid-cols-6 gap-3 mb-4">
          {KPIS.map(k => (
            <MetricTile key={k.label} label={k.label} value={k.value} delta={k.sub} />
          ))}
          <div className="bg-white rounded-card border border-border p-3">
            <div className="text-caption text-gray2">本月调动</div>
            <div className="font-num text-h1 mt-1">2</div>
            <div className="text-micro text-gray3 mt-1">店长 1 · 基层 1</div>
          </div>
          <div className="bg-white rounded-card border border-border p-3">
            <div className="text-caption text-red-fg">待审账号变更</div>
            <div className="font-num text-h1 mt-1 text-red-fg">1</div>
            <div className="text-micro text-red-fg mt-1">手机号变更</div>
          </div>
        </div>

        <div className="flex gap-2 mb-3">
          {(['全部', '集团', '店长', '厨师长', '基层', '供应商'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-cta text-button ${filter === f ? 'bg-ink text-white' : 'bg-white border border-border text-gray2'}`}
            >{f === '全部' ? '全部' : `${f} ${{ 集团: 3, 店长: 8, 厨师长: 8, 基层: 142, 供应商: 8 }[f as Exclude<typeof f, '全部'>]}`}</button>
          ))}
        </div>

        <div className="bg-white rounded-card border border-border overflow-hidden">
          <div className="px-4 py-2 bg-bg/40 text-micro text-gray3">集团角色 (3)</div>
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 font-normal">姓名 / 角色</th>
                <th className="px-3 py-2 font-normal">所属</th>
                <th className="px-3 py-2 font-normal">入职日期</th>
                <th className="px-3 py-2 font-normal">手机号</th>
                <th className="px-3 py-2 font-normal">状态</th>
                <th className="px-3 py-2 font-normal text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {ROWS_GROUP.map((r, i) => (
                <tr key={i} className="border-t border-border hover:bg-[#FAF8F2]">
                  <td className="px-3 py-2.5 flex items-center gap-2">
                    <span className="w-7 h-7 rounded-md bg-bg flex items-center justify-center font-num text-caption">{r.name[0]}</span>
                    <span className="text-body">{r.name} · <Chip tone={r.role === '老板' ? 'red' : r.role === '总厨' ? 'orange' : 'red'}>{r.role}</Chip></span>
                  </td>
                  <td className="px-3 py-2.5 text-body text-gray2">{r.dept}</td>
                  <td className="px-3 py-2.5 text-body">{r.joined}</td>
                  <td className="px-3 py-2.5 text-body font-num">{r.phone}</td>
                  <td className="px-3 py-2.5"><Chip tone="green">{r.status}</Chip></td>
                  <td className="px-3 py-2.5 text-right">
                    <a href="#" className={`text-caption ${r.op ? 'text-gray3' : 'text-gray2 hover:text-ink'}`}>{r.op || '调动 / 停用 ›'}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="px-4 py-2 bg-bg/40 text-micro text-gray3 border-t border-border">门店人员 (16)</div>
          <table className="w-full">
            <tbody>
              {ROWS_STORE.map((r, i) => (
                <tr key={i} className="border-t border-border hover:bg-[#FAF8F2]">
                  <td className="px-3 py-2.5 flex items-center gap-2">
                    <span className="w-7 h-7 rounded-md bg-bg flex items-center justify-center font-num text-caption">{r.name[0]}</span>
                    <span className="text-body">{r.name} · <Chip tone="gray">{r.role}</Chip></span>
                  </td>
                  <td className="px-3 py-2.5 text-body text-gray2">{r.dept}</td>
                  <td className="px-3 py-2.5 text-body">{r.joined}</td>
                  <td className="px-3 py-2.5 text-body font-num text-gray3">—</td>
                  <td className="px-3 py-2.5"><Chip tone="green">活跃</Chip></td>
                  <td className="px-3 py-2.5 text-right"><a href="#" className="text-caption text-gray2 hover:text-ink">调动 / 停用 ›</a></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-4 py-3 text-center text-caption border-t border-border">
            <a href="#" className="text-gray2 hover:text-ink">另 10 名门店人员(其他店长 / 厨师长) 展开 ›</a>
          </div>
        </div>

        <section className="mt-4 bg-white rounded-card border border-border overflow-hidden">
          <header className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-h2">本月新增基层员工</h2>
            <span className="text-caption text-gray3">12 人 · 由各店店长创建</span>
          </header>
          <table className="w-full">
            <thead className="bg-bg/40">
              <tr className="text-micro text-gray3 text-left">
                <th className="px-3 py-2 font-normal">员工</th>
                <th className="px-3 py-2 font-normal">岗位</th>
                <th className="px-3 py-2 font-normal">所属门店</th>
                <th className="px-3 py-2 font-normal">创建人</th>
                <th className="px-3 py-2 font-normal">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {NEW_STAFF.map((s, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-3 py-2.5 flex items-center gap-2">
                    <span className="w-7 h-7 rounded-md bg-bg flex items-center justify-center font-num text-caption">{s.name[1]}</span>
                    <span className="text-body">{s.name}</span>
                  </td>
                  <td className="px-3 py-2.5 text-body text-gray2">{s.pos}</td>
                  <td className="px-3 py-2.5 text-body">{s.store}</td>
                  <td className="px-3 py-2.5 text-body text-gray2">{s.creator}</td>
                  <td className="px-3 py-2.5 text-body font-num">{s.date}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-4 py-3 text-center text-caption text-gray3">另 9 条 · 全部由店长直接创建,无需老板审批</div>
        </section>
      </main>
    </div>
  )
}
