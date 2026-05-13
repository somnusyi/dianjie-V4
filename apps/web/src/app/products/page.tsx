// ══════════════════════════════════════
// products/page.tsx
// ══════════════════════════════════════
'use client'
import { useEffect, useState } from 'react'
import AppLayout from '@/components/AppLayout'
import { PageHeader, Card, Table, Badge, Btn, Modal, Field, Input, Select, fmt, useToast, Pagination } from '@/components/ui'
import api from '@/lib/api'

const PAGE_SIZE = 20

function ProductsPage() {
  const [products, setProducts] = useState<any[]>([])
  const [suppliers, setSuppliers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const { show, ToastEl } = useToast()
  const empty = { code: '', name: '', category: '', unit: 'kg', price: '', stock: '', minStock: '', shelfDays: '7', supplierId: '' }
  const [form, setForm] = useState<any>(empty)

  const load = async (p = page) => {
    setLoading(true)
    try {
      // 商品列表分页；suppliers 不传 page 拿全量用于下拉
      const [pr, s] = await Promise.all([
        api.get(`/api/products?page=${p}&pageSize=${PAGE_SIZE}`),
        api.get('/api/suppliers?status=ENABLED'),
      ])
      const data = pr.data
      setProducts(data.items || [])
      setTotal(data.total || 0)
      setPage(p)
      setSuppliers(Array.isArray(s.data) ? s.data : s.data?.items || [])
    } catch {}
    setLoading(false)
  }
  useEffect(() => { load(1) }, [])

  const openEdit = (row: any) => { setEditing(row); setForm({ ...row, price: String(row.price), stock: String(row.stock), minStock: String(row.minStock) }); setModalOpen(true) }
  const openCreate = () => { setEditing(null); setForm(empty); setModalOpen(true) }

  const submit = async () => {
    if (!form.code || !form.name) return show('请填写商品编码和名称', 'error')
    try {
      const payload = { ...form, price: Number(form.price), stock: Number(form.stock), minStock: Number(form.minStock), shelfDays: Number(form.shelfDays) }
      if (editing) await api.patch(`/api/products/${editing.id}`, payload)
      else await api.post('/api/products', payload)
      show(editing ? '已更新' : '商品已创建'); setModalOpen(false); load(editing ? page : 1)
    } catch (e: any) { show(e.response?.data?.error || '操作失败', 'error') }
  }

  const f = (k: string) => ({ value: form[k] ?? '', onChange: (v: string) => setForm({ ...form, [k]: v }) })
  const cols = [
    { key: 'code', title: '编码', render: (v: string) => <span style={{ color: '#156b43', fontWeight: 600 }}>{v}</span> },
    { key: 'name', title: '商品名称', render: (v: string) => <b>{v}</b> },
    { key: 'category', title: '分类' },
    { key: 'price', title: '参考单价', render: (v: any, row: any) => `${fmt(v)}/${row.unit}` },
    { key: 'stock', title: '当前库存', render: (v: any, row: any) => {
      const low = Number(v) < Number(row.minStock)
      return <span style={{ color: low ? '#dc2626' : '#374151', fontWeight: low ? 700 : 400 }}>{Number(v)} {row.unit} {low ? '⚠️' : ''}</span>
    }},
    { key: 'supplier', title: '供应商', render: (_: any, row: any) => row.supplier?.name || '-' },
    { key: 'status', title: '状态', render: (v: string) => <Badge status={v} /> },
    { key: 'actions', title: '操作', render: (_: any, row: any) => <Btn size="sm" onClick={() => openEdit(row)}>编辑</Btn> },
  ]

  return (
    <AppLayout>
      {ToastEl}
      <div style={{ padding: 28 }}>
        <PageHeader title="商品中心" sub="管理食材 SKU、库存及安全库存预警"
          action={<Btn variant="primary" onClick={openCreate}>＋ 新增商品</Btn>} />
        <Card style={{ padding: 0 }}><Table columns={cols} data={products} loading={loading} /></Card>
      </div>
      <Modal open={modalOpen} title={editing ? '编辑商品' : '新增商品'} onClose={() => setModalOpen(false)}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="商品编码" required><Input {...f('code')} placeholder="MR001" disabled={!!editing} /></Field>
          <Field label="商品名称" required><Input {...f('name')} placeholder="商品名" /></Field>
          <Field label="分类"><Input {...f('category')} placeholder="菌菇类/蔬菜..." /></Field>
          <Field label="单位">
            <Select value={form.unit} onChange={v => setForm({ ...form, unit: v })} options={['kg','g','斤','个','箱','瓶'].map(v => ({ value: v, label: v }))} />
          </Field>
          <Field label="参考单价"><Input {...f('price')} type="number" placeholder="0.00" /></Field>
          <Field label="当前库存"><Input {...f('stock')} type="number" placeholder="0" /></Field>
          <Field label="安全库存"><Input {...f('minStock')} type="number" placeholder="低于此值预警" /></Field>
          <Field label="保质期(天)"><Input {...f('shelfDays')} type="number" placeholder="7" /></Field>
          <Field label="默认供应商">
            <Select value={form.supplierId} onChange={v => setForm({ ...form, supplierId: v })}
              options={suppliers.map(s => ({ value: s.id, label: s.name }))} placeholder="选择供应商" />
          </Field>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20, paddingTop: 16, borderTop: '1px solid #e5e7eb' }}>
          <Btn onClick={() => setModalOpen(false)}>取消</Btn>
          <Btn variant="primary" onClick={submit}>保存</Btn>
        </div>
      </Modal>
    </AppLayout>
  )
}
export default ProductsPage
