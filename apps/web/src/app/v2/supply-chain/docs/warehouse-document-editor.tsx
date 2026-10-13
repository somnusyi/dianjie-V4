'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ConfirmSheet, useConfirmSheet } from '@/components/v2/confirm-sheet'
import sheet from '@/components/v2/document-sheet.module.css'
import { SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT } from '@/components/v2/supply-chain-shell'
import { apiFetch } from '@/lib/v2-auth'
import { useWarehouseInboundDraft } from '@/lib/use-warehouse-inbound-draft'
import { warehouseDocumentDecimalChanged } from '@/lib/warehouse-document-decimal'
import { showTableReport } from '@/lib/table-report'
import {DocumentQualityImageButton} from '@/components/v2/document-quality-image'

// ── 类型 ──────────────────────────────────────────────
type DocRow = {
  id: string
  docNo: string
  type: 'MANUAL_INBOUND' | 'MANUAL_OUTBOUND'
  supplierId: string | null
  supplierName: string | null
  reason: string | null
  note: string | null
  effectiveAt: string
  status: 'POSTED' | 'CONFIRMED'
  reviewStatus: 'UNREVIEWED' | 'REVIEWED'
  lineCount: number
  totalAmount: number
  createdAt: string
  confirmedAt: string | null
  unauditedAt: string | null
  unauditReason: string | null
  attachmentCount: number
}

type DocAttachment = { name: string; mime: string; size: number; url: string }

type DocLine = {
  id: string
  lineNo: number
  productId: string
  productName: string
  productCode?: string | null
  productSpec?: string | null
  productCategory?: string | null
  quantity: number
  unit: string
  unitPrice: number | null
  amount: number
  isGift?: boolean
  inventoryQuantity: number
  inventoryUnit: string
  note: string | null
  batchNo: string | null
  manufactureDate: string | null
  expiryDate: string | null
}

type DocLog = {
  id: string
  action: 'CREATE' | 'CONFIRM' | 'UNCONFIRM' | 'EDIT' | 'REVIEW' | 'UNREVIEW'
  actorName: string | null
  reason: string | null
  detail: any
  createdAt: string
}

type DocDetail = DocRow & { warehouse?: { id: string; code: string; name: string } | null; organizationName?: string | null; lines: DocLine[]; logs: DocLog[]; attachments: DocAttachment[] }

type Candidate = {eligible?:boolean;unitConversionStatus?:string; id: string; code: string; name: string; spec?: string | null; category?: string | null; purchaseUnit: string; inventoryUnit: string; purchaseToInventoryFactor: number }
type NewAttachment = DocAttachment & { key: string }

type SupplierOption = { id: string; name: string; no?: string }

const LOG_ACTION_LABEL: Record<DocLog['action'], string> = {
  REVIEW: '复审',
  UNREVIEW: '取消复审',
  CREATE: '制单',
  CONFIRM: '审核',
  UNCONFIRM: '反审核',
  EDIT: '修改',
}

function money(value: number | null | undefined) {
  return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtQty(value: number | null | undefined) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 3 })
}

function fmtTime(value: string | null | undefined) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function fmtDay(value: string | null | undefined) {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
}

function StatusBadge({ status }: { status: DocRow['status'] }) {
  if (status === 'CONFIRMED') {
    return <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-caption text-emerald-700">已审核</span>
  }
  return <span className="rounded-full bg-amber-50 px-2 py-0.5 text-caption text-amber-fg">待审核</span>
}

// ── 单据详情 / 改单 / 审核 ─────────────────────────────
export type WarehouseDocumentAction = 'audit' | 'unconfirm' | 'review' | 'print' | 'quality'

export function WarehouseDocumentEditor({ docId, canAudit, canEdit, canReview, onClose, onChanged, fullPage = false, initialAction, onCreated, newType = 'MANUAL_INBOUND' }: {
  fullPage?: boolean
  initialAction?: WarehouseDocumentAction
  docId?: string
  onCreated?: (id: string, message?: string) => void
  newType?: 'MANUAL_INBOUND' | 'MANUAL_OUTBOUND'
  canAudit: boolean
  canReview: boolean
  canEdit: boolean
  onClose: () => void
  onChanged: (message: string) => void
}) {
  const creating = !docId
  const creatingOutbound = creating && newType === 'MANUAL_OUTBOUND'
  const [outboundPurpose,setOutboundPurpose] = useState('')
  const [outboundReason,setOutboundReason] = useState('')
  const [outboundResponsibility,setOutboundResponsibility] = useState('')
  const [outboundSource,setOutboundSource] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [selectedProduct, setSelectedProduct] = useState('')
  const [candidateQuery,setCandidateQuery]=useState(''),[candidateAppliedQuery,setCandidateAppliedQuery]=useState(''),[candidateCursor,setCandidateCursor]=useState<string|null>(null),[candidateBusy,setCandidateBusy]=useState(false)
  const candidateSequence=useRef(0)
  useEffect(()=>()=>{candidateSequence.current++},[])
  const [newAttachments, setNewAttachments] = useState<NewAttachment[]>([])
  const [submissionUnknown, setSubmissionUnknown] = useState(false)
  const pendingSubmission = useRef<{ id: string; version: number; auditOnSubmit: boolean } | null>(null)
  const [doc, setDoc] = useState<DocDetail | null>(null)
  const [restoredDraftTime,setRestoredDraftTime]=useState<{raw:string;iso:string;display:string}|null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [documentStateUnverified, setDocumentStateUnverified] = useState(false)
  const documentStateUnverifiedRef = useRef(false)
  const documentReadSequence = useRef(0)
  const documentScope = useRef({ id: docId, epoch: 0, alive: true })
  if (documentScope.current.id !== docId) documentScope.current = { id: docId, epoch: documentScope.current.epoch + 1, alive: true }
  const isDocumentScopeCurrent = (scope: { id: string | undefined; epoch: number }) => documentScope.current.alive && scope.id === documentScope.current.id && scope.epoch === documentScope.current.epoch
  const markDocumentStateUnverified = () => { documentStateUnverifiedRef.current = true; setDocumentStateUnverified(true) }
  const documentReadOwner = useRef(docId)
  documentReadOwner.current = docId
  useEffect(() => { documentScope.current.alive = true; return () => { documentReadSequence.current++; documentScope.current.alive = false } }, [])
  function requireDocumentStateReload(message: string) {
    documentStateUnverifiedRef.current = true
    setDocumentStateUnverified(true)
    setError(`${message}。请先加载最新单据状态后再继续审批。`)
  }
  function handleDocumentWriteFailure(reason: any) {
    const message = String(reason?.message || reason)
    if (reason?.status === 409) requireDocumentStateReload(message)
    // A transport/parse error or 5xx can follow a committed write. Never retry
    // automatically or allow another action using an unverified old document.
    else if (![400, 401, 403, 404, 405, 422, 429].includes(reason?.status)) {
      requireDocumentStateReload(`操作结果未确认：${message}`)
    } else setError(message)
    return message
  }

  const [suppliers, setSuppliers] = useState<SupplierOption[]>([])

  // 编辑态
  const [editReason, setEditReason] = useState('')
  const [lineEdits, setLineEdits] = useState<Record<string, { amount?: string; quantity?: string; note?: string }>>({})
  const [supplierId, setSupplierId] = useState('')
  const [headerNote, setHeaderNote] = useState('')
  const [unauditReason, setUnauditReason] = useState('')
  const [unauditOpen, setUnauditOpen] = useState(false)
  const [confirmation, openConfirmation] = useConfirmSheet()
  const editorInputs = useRef({ doc, supplierId, headerNote, lineEdits, editReason })
  editorInputs.current = { doc, supplierId, headerNote, lineEdits, editReason }

  const load = useCallback((options?: { preserveInputs?: boolean }) => {
    const sequence = ++documentReadSequence.current
    const owner = docId
    const isCurrent = () => sequence === documentReadSequence.current && owner === documentReadOwner.current
    setLoading(true)
    setError(null)
    if (creating) {
      if (!canEdit) { setError('无权新建仓库单据'); setLoading(false); return Promise.resolve() }
      return Promise.all([
        apiFetch<{ warehouse: { id: string; code: string; name: string } }>('/api/warehouse-inventory?page=1&pageSize=1'),
        apiFetch<{ items: Candidate[];nextCursor?:string|null }>('/api/warehouse-inventory/inbound-candidates?limit=100&paged=1'),
      ]).then(([inventory, options]) => {
        if (!isCurrent()) return
        const now = new Date().toISOString()
        let organizationName: string | null = null
        try { organizationName = JSON.parse(localStorage.getItem('tenant') || 'null')?.name || null } catch {}
        setCandidates(options.items || []);setCandidateCursor(options.nextCursor||null)
        setDoc({ id: '', docNo: '提交后生成', type: newType, supplierId: null, supplierName: null, reason: null, note: null,
          effectiveAt: now, status: 'POSTED', reviewStatus: 'UNREVIEWED', lineCount: 0, totalAmount: 0, createdAt: now,
          confirmedAt: null, unauditedAt: null, unauditReason: null, attachmentCount: 0, attachments: [], lines: [], logs: [], warehouse: inventory.warehouse, organizationName })
      }).catch(reason => { if (isCurrent()) setError(String(reason?.message || reason)) }).finally(() => { if (isCurrent()) setLoading(false) })
    }
    return apiFetch<DocDetail>(`/api/warehouse-docs/${docId}`)
      .then(data => {
        if (!isCurrent()) return
        if (data.id !== owner) throw new Error('单据来源不匹配，请重新加载')
        setDoc(data)
        documentStateUnverifiedRef.current = false
        setDocumentStateUnverified(false)
        setUnauditOpen(false)
        const previous = options?.preserveInputs ? editorInputs.current : null
        setSupplierId(previous && previous.supplierId !== (previous.doc?.supplierId || '') ? previous.supplierId : data.supplierId || '')
        setHeaderNote(previous && previous.headerNote !== (previous.doc?.note || '') ? previous.headerNote : data.note || '')
        const preserved: typeof lineEdits = {}
        if (previous) for (const [id, edit] of Object.entries(previous.lineEdits)) {
          const original = previous.doc?.lines.find(line => line.id === id)
          if (!original || !data.lines.some(line => line.id === id)) continue
          const changed: typeof edit = {}
          if (edit.amount !== undefined && edit.amount !== String(original.amount)) changed.amount = edit.amount
          if (edit.quantity !== undefined && edit.quantity !== String(original.quantity)) changed.quantity = edit.quantity
          if (edit.note !== undefined && edit.note !== (original.note || '')) changed.note = edit.note
          if (Object.keys(changed).length) preserved[id] = changed
        }
        setLineEdits(preserved)
        setEditReason(previous?.editReason || '')
      })
      .catch(reason => { if (isCurrent()) requireDocumentStateReload(String(reason?.message || reason)) })
      .finally(() => { if (isCurrent()) setLoading(false) })
  }, [docId, creating, canEdit, newType])

  useEffect(() => {
    confirmation.close(); setUnauditOpen(false); setUnauditReason('')
    busyRef.current = false; setBusy(false)
    if (!creating) markDocumentStateUnverified()
  }, [docId])
  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (doc?.type !== 'MANUAL_INBOUND' || !canEdit) return
    apiFetch<SupplierOption[]>('/api/suppliers?status=ENABLED&businessScope=WAREHOUSE_UPSTREAM')
      .then(list => setSuppliers(Array.isArray(list) ? list : []))
      .catch(() => {})
  }, [doc?.type, canEdit])

  async function loadCandidates(more=false){
    const sequence=++candidateSequence.current
    setCandidateBusy(true);setError(null)
    try{
      const query=new URLSearchParams({limit:'100',paged:'1',q:more?candidateAppliedQuery:candidateQuery})
      if(more&&candidateCursor)query.set('cursor',candidateCursor)
      const result=await apiFetch<{items:Candidate[];nextCursor?:string|null}>(`/api/warehouse-inventory/inbound-candidates?${query}`)
      if(sequence!==candidateSequence.current)return
      setCandidates(current=>more?[...new Map([...current,...result.items].map(row=>[row.id,row])).values()]:result.items)
      setCandidateCursor(result.nextCursor||null);if(!more)setCandidateAppliedQuery(candidateQuery);setSelectedProduct('')
    }catch(reason:any){if(sequence===candidateSequence.current)setError(reason.message||'物品查询失败')}
    finally{if(sequence===candidateSequence.current)setCandidateBusy(false)}
  }
  const inboundPayload = {
    displayUnits:(doc?.lines||[]).map(line=>({productId:line.productId,unit:line.unit,inventoryUnit:line.inventoryUnit,conversionFactor:creatingOutbound?1:line.quantity>0?line.inventoryQuantity/line.quantity:null})),
    mode: 'BATCH', warehouseId:doc?.warehouse?.id||'', supplierId, note: headerNote, effectiveAt: restoredDraftTime&&doc?.effectiveAt===restoredDraftTime.display?restoredDraftTime.raw:doc?.effectiveAt||'', effectiveAtIso: restoredDraftTime&&doc?.effectiveAt===restoredDraftTime.display?restoredDraftTime.iso:doc?.effectiveAt||'',
    attachments: newAttachments.map(({ key, name, mime, size }) => ({ key, name, mime, size })),
    rows: (doc?.lines || []).map(line => {
      const edit = lineEdits[line.id] || {}
      return { productId: line.productId, purchaseQuantity: edit.quantity ?? String(line.quantity),
        amount: edit.amount ?? String(line.amount), unitPrice: Number(edit.quantity ?? line.quantity) > 0 ? String(Number(edit.amount ?? line.amount) / Number(edit.quantity ?? line.quantity)) : '',
        note: edit.note ?? line.note ?? '', batchNo: line.batchNo || '', manufactureDate: line.manufactureDate?.slice(0,10) || '', expiryDate: line.expiryDate?.slice(0,10) || '', isGift: line.isGift === true, priceSource: 'manual', amountSource: 'manual' }
    }),
  }
  const newPayload = creatingOutbound ? {
    ...inboundPayload, mode:'OUTBOUND',purpose:outboundPurpose,reason:outboundReason,responsibility:outboundResponsibility,sourceName:outboundSource,
    rows:inboundPayload.rows.map(row=>({productId:row.productId,inventoryQuantity:row.purchaseQuantity,totalAmount:row.amount,note:row.note}))
  } : inboundPayload
  const newDraft = useWarehouseInboundDraft(creatingOutbound ? 'OUTBOUND' : 'BATCH', creating && !!doc && !loading, newPayload, value => {
    setOutboundPurpose(value.purpose||'');setOutboundReason(value.reason||'');setOutboundResponsibility(value.responsibility||'');setOutboundSource(value.sourceName||'')
    setSupplierId(value.supplierId || '')
    setHeaderNote(value.note || '')
    setNewAttachments(value.attachments || [])
    const edits: typeof lineEdits = {}
    const missingIds=(value.rows||[]).map((row:any)=>row.productId).filter((id:string)=>!candidates.some(candidate=>candidate.id===id))
    if(missingIds.length){const sequence=candidateSequence.current;void apiFetch<{items:Candidate[]}>(`/api/warehouse-inventory/inbound-candidates?productIds=${encodeURIComponent(missingIds.join(','))}`).then(result=>{
      if(sequence!==candidateSequence.current)return
      setCandidates(current=>[...new Map([...current,...result.items].map(row=>[row.id,row])).values()])
      setDoc(current=>current?{...current,lines:current.lines.map(line=>{
        const source=result.items.find(row=>row.id===line.productId)
        if(!source||value.executionSnapshot?.products?.some((row:any)=>row.id===line.productId))return line
        return {...line,productName:source.name,productCode:source.code,productSpec:source.spec||null,productCategory:source.category||null}
      })}:current)
    }).catch(reason=>{if(sequence===candidateSequence.current)setError(reason.message||'草稿商品资料补读失败，原行保留')})}
    const lines = (value.rows || []).map((row: any, index: number) => {
      const frozen=value.executionSnapshot?.products?.find((item:any)=>item.id===row.productId)
      const candidate=candidates.find(candidate=>candidate.id===row.productId)
      const displayed=value.displayUnits?.find((item:any)=>item.productId===row.productId)
      const product=frozen?{...frozen,purchaseUnit:frozen.units?.purchaseUnit||'',inventoryUnit:frozen.units?.inventoryUnit||'',purchaseToInventoryFactor:frozen.units?.structured?.purchase?frozen.units.inventoryUnitsPerPurchaseUnit:0}:displayed?{...candidate,purchaseUnit:creatingOutbound?(candidate?.purchaseUnit||''):displayed.unit,inventoryUnit:displayed.inventoryUnit,purchaseToInventoryFactor:displayed.conversionFactor||0}:candidate
      edits[row.productId] = { quantity: (creatingOutbound ? row.inventoryQuantity : row.purchaseQuantity) || '', amount: (creatingOutbound ? row.totalAmount : row.amount) || '', note: row.note || '' }
      return { id: row.productId, lineNo: index + 1, productId: row.productId, productName: product?.name || '商品资料待核对',
        productCode: product?.code || null, productSpec: product?.spec || null, productCategory: product?.category || null,
        quantity: 1, unit: (creatingOutbound ? product?.inventoryUnit : product?.purchaseUnit) || '', unitPrice: null, amount: 0,
        inventoryQuantity: creatingOutbound ? 1 : product?.purchaseToInventoryFactor || 0, inventoryUnit: product?.inventoryUnit || '',
        note: null, isGift: row.isGift === true, batchNo: row.batchNo || null, manufactureDate: row.manufactureDate || null, expiryDate: row.expiryDate || null }
    })
    setLineEdits(edits)
    setRestoredDraftTime({raw:value.effectiveAt||'',iso:value.effectiveAtIso||'',display:value.effectiveAtIso||doc?.effectiveAt||''})
    setDoc(current => current ? { ...current, warehouse:value.executionSnapshot?.warehouse||current.warehouse,effectiveAt: value.effectiveAtIso || current.effectiveAt, lines, attachments: value.attachments || [], attachmentCount: (value.attachments || []).length } : current)
  })
  useEffect(() => { if (creating && newDraft.submittedDocId) onCreated?.(newDraft.submittedDocId) }, [creating, newDraft.submittedDocId, onCreated])

  useEffect(()=>{
    if(!creating||!newDraft.snapshot)return
    const frozen=newDraft.snapshot
    setDoc(current=>current?{...current,warehouse:frozen.warehouse,lines:current.lines.map(line=>{
      const product=frozen.products.find((row:any)=>row.id===line.productId)
      if(!product)return line
      return {...line,productName:product.name||'商品资料待核对',productCode:product.code,productSpec:product.spec,productCategory:product.category,
        unit:(creatingOutbound?product.units?.inventoryUnit:product.units?.purchaseUnit)||'',inventoryUnit:product.units?.inventoryUnit||'',inventoryQuantity:creatingOutbound?line.quantity:line.quantity*(product.units?.structured?.purchase?product.units.inventoryUnitsPerPurchaseUnit:0)}
    })}:current)
  },[creating,creatingOutbound,newDraft.snapshot])
  function reconfirmDraft(){
    openConfirmation({title:newDraft.reconfirmPending?'核对原请求':'重新核对仓库与单位',body:newDraft.reconfirmPending?'按原内容和原请求核对结果，不重新接受现在的换算；本操作不入账。':'按当前仓库和商品单位重新核对草稿。请核对采购数量、换算后的库存数量及金额，再提交；本操作不入账。',confirmLabel:newDraft.reconfirmPending?'核对原请求':'重新核对',onConfirm:async()=>{
      if(busyRef.current||submissionUnknown)return
      busyRef.current=true;setBusy(true);setError(null)
      try{const result=await newDraft.flush(true);if(result.requiresReload)return;onChanged('仓库与单位已重新核对，请检查数量和金额后再提交')}
      catch(reason:any){setError(String(reason.message||reason));throw reason}
      finally{busyRef.current=false;setBusy(false)}
    }})
  }
  async function saveNewDraft() {
    if (busyRef.current || submissionUnknown) return
    busyRef.current = true; setBusy(true); setError(null)
    try { await newDraft.flush(); onChanged(`草稿已保存，换设备可恢复；尚未生成${creatingOutbound ? '出库' : '入库'}单`) }
    catch (reason: any) { setError(String(reason?.message || reason)) }
    finally { busyRef.current = false; setBusy(false) }
  }
  async function submitNew(auditOnSubmit: boolean) {
    if (busyRef.current) return
    if (!pendingSubmission.current) {
      if (creatingOutbound) {
        const rows = (newPayload as {rows:Array<{inventoryQuantity:string;totalAmount:string}>}).rows
        if (!outboundPurpose || outboundReason.trim().length < 2 || !doc?.lines.length || rows.some(row=>!row.inventoryQuantity.trim() || !Number.isFinite(Number(row.inventoryQuantity)) || Number(row.inventoryQuantity)<=0 || row.totalAmount.trim()!=='' && (!Number.isFinite(Number(row.totalAmount)) || Number(row.totalAmount)<=0))) {setError('请选择出库用途，填写原因/去向及有效数量；指定成本须大于0，可留空自动计算');return}
      } else if (!supplierId || !doc?.lines.length || inboundPayload.rows.some(row=>!row.purchaseQuantity.trim() || !row.amount.trim() || !Number.isFinite(Number(row.purchaseQuantity)) || Number(row.purchaseQuantity)<=0 || !Number.isFinite(Number(row.amount)) || (row.isGift ? Number(row.amount)!==0 : Number(row.amount)<=0))) {setError('请选择供应商，添加物品，并填写有效且大于0的数量和金额');return}
      if (!creatingOutbound && inboundPayload.rows.some(row=>row.manufactureDate && row.expiryDate && row.expiryDate < row.manufactureDate)) {setError('到期日期不能早于生产日期，输入已保留');return}
    }
    busyRef.current = true; setBusy(true); setError(null)
    try {
      const request = pendingSubmission.current || { ...await newDraft.flush(), auditOnSubmit }
      pendingSubmission.current = request
      const result = await apiFetch<{ doc: { id: string; docNo: string; status: string }; gateWarnings: string[] }>(`/api/warehouse-inventory/inbound-drafts/${request.id}/submit`, { method: 'POST', body: JSON.stringify({ version: request.version, auditOnSubmit: request.auditOnSubmit }) })
      newDraft.completed(); pendingSubmission.current = null; setSubmissionUnknown(false)
      const message = `单据 ${result.doc.docNo} ${result.doc.status === 'CONFIRMED' ? '已审核' : '待审核'}${result.gateWarnings?.length ? `；${result.gateWarnings.join('；')}` : ''}`
      onChanged(message)
      onCreated?.(result.doc.id, message)
    } catch (reason: any) {
      // Keep the same draft/version/intent on an uncertain response; never create
      // a replacement receipt. Refresh recovery also resolves the original id.
      if ([400, 403, 404, 409, 422].includes(reason?.status)) pendingSubmission.current = null
      setSubmissionUnknown(Boolean(pendingSubmission.current))
      setError(`${String(reason?.message || reason)}${pendingSubmission.current ? '；请核对原提交，当前输入保留，不要重复新建' : ''}`)
    } finally { busyRef.current = false; setBusy(false) }
  }
  function requestNewSubmit(audit: boolean) {
    openConfirmation({ title: audit ? '审核新单据' : '提交单据', body: audit ? `保存当前草稿并生成${creatingOutbound ? '出库' : '入库'}单，审核标记为已审核。不会在审核阶段重复过账。` : `保存当前草稿并生成待审核${creatingOutbound ? '出库' : '入库'}单。`, confirmLabel: audit ? '确认审核' : '确认提交', layerClassName: 'z-[100]', onConfirm: () => submitNew(audit) })
  }
  async function uploadNewAttachments(files: File[]) {
    if (busyRef.current || submissionUnknown) return
    const room = 9 - newAttachments.length
    if (files.length > room) { setError('随货附件最多9份，请减少所选文件'); return }
    if (files.some(file => file.size > 10 * 1024 * 1024 || !['image/jpeg','image/png','image/webp','image/gif','application/pdf'].includes(file.type))) { setError('附件仅支持图片/PDF，单份最大10MB'); return }
    busyRef.current = true; setBusy(true); setError(null)
    try {
      for (const file of files) {
        const form = new FormData(); form.append('file', file, file.name)
        const uploaded = await apiFetch<NewAttachment>('/api/upload?category=warehouse-docs', { method: 'POST', body: form as any })
        setNewAttachments(current => [...current, uploaded])
        setDoc(current => current ? { ...current, attachments: [...current.attachments, uploaded], attachmentCount: current.attachmentCount + 1 } : current)
      }
    } catch (reason: any) { setError(`部分附件上传未成功，已成功附件保留：${reason?.message || reason}`) }
    finally { busyRef.current = false; setBusy(false) }
  }
  function addProduct() {
    if (!doc || busyRef.current || submissionUnknown) return
    const product = candidates.find(candidate => candidate.id === selectedProduct)
    if (!product || doc.lines.some(line => line.productId === product.id)) return
    if (doc.lines.length >= 200) { setError('单张入库单最多200种商品'); return }
    setDoc({ ...doc, lines: [...doc.lines, { id: product.id, lineNo: doc.lines.length + 1, productId: product.id,
      productName: product.name, productCode: product.code, productSpec: product.spec || null, productCategory: product.category || null,
      quantity: 1, unit: creatingOutbound ? product.inventoryUnit : product.purchaseUnit, unitPrice: null, amount: 0, inventoryQuantity: creatingOutbound ? 1 : product.purchaseToInventoryFactor,
      inventoryUnit: product.inventoryUnit, note: null, batchNo: null, manufactureDate: null, expiryDate: null }] })
    setLineEdits(current => ({ ...current, [product.id]: { quantity: '', amount: '' } }))
    setSelectedProduct('')
  }

  const dirty = Boolean(doc && (supplierId !== (doc.supplierId || '') || headerNote !== (doc.note || '') ||
    Object.entries(lineEdits).some(([id, edit]) => {
      const line = doc.lines.find(item => item.id === id)
      if (!line) return false
      return (edit.amount !== undefined && edit.amount !== String(line.amount)) ||
        (edit.quantity !== undefined && edit.quantity !== String(line.quantity)) ||
        (edit.note !== undefined && edit.note !== (line.note || ''))
    })))

  function protectClose(proceed = onClose) {
    if (submissionUnknown) { setError('提交结果尚未核对，请先核对原提交'); return }
    if (busyRef.current || confirmation.open) return
    if(creating&&newDraft.terminalStatus){proceed();return}
    if(creating&&newDraft.reconfirmPending){openConfirmation({title:'原核对结果待确认',body:'原请求已保留。离开后返回会先核对原请求，不会重复确认新换算。',confirmLabel:'保留并离开',onConfirm:proceed});return}
    if (creating) {
      busyRef.current = true; setBusy(true)
      void newDraft.flush().then(() => proceed()).catch(reason => setError(String(reason?.message || reason))).finally(() => { busyRef.current = false; setBusy(false) })
      return
    }
    if (!dirty) { proceed(); return }
    openConfirmation({ title: '放弃未保存的单据修改？', body: '当前输入尚未保存，继续离开会丢失这些修改。',
      confirmLabel: '放弃并离开', tone: 'danger', layerClassName: 'z-[100]', onConfirm: proceed })
  }

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (creating && newDraft.ready && !newDraft.unsaved && !newDraft.failure && !busyRef.current && !submissionUnknown) return
      if (!dirty && !busyRef.current && !submissionUnknown) return
      event.preventDefault(); event.returnValue = ''
    }
    const navigate = (event: Event) => {
      if (!dirty && !busyRef.current && !confirmation.open && !submissionUnknown) return
      event.preventDefault()
      const proceed = (event as CustomEvent<{ proceed?: () => void }>).detail?.proceed
      protectClose(() => proceed?.())
    }
    window.addEventListener('beforeunload', warn)
    window.addEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, navigate)
    return () => { window.removeEventListener('beforeunload', warn); window.removeEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT, navigate) }
  }, [dirty, confirmation.open, onClose, openConfirmation, submissionUnknown, creating, newDraft.ready, newDraft.unsaved, newDraft.failure])

  const startedAction = useRef<string>('')
  useEffect(() => {
    if (!doc || loading || documentStateUnverified || !initialAction) return
    const key = `${doc.id}:${initialAction}`
    if (startedAction.current === key) return
    startedAction.current = key
    // Opening the audit page only displays the document; the footer audit button performs the action.
    if (initialAction === 'unconfirm' && canAudit && doc.status === 'CONFIRMED' && doc.reviewStatus !== 'REVIEWED') setUnauditOpen(true)
    else if (initialAction === 'review' && canReview && doc.status === 'CONFIRMED' && doc.reviewStatus !== 'REVIEWED') review()
    else if (initialAction === 'print') showTableReport({
      title: `${doc.type === 'MANUAL_INBOUND' ? '入库单' : '出库单'} ${doc.docNo}`,
      subtitle: `日期：${fmtDay(doc.effectiveAt)}；${doc.supplierName || doc.reason || ''}；状态：${doc.status === 'CONFIRMED' ? '已审核' : '待审核'}`,
      headers: ['序号','物品编码','物品名称','规格型号','物品类别','仓库','数量','单位','单价','金额','是否赠品','辅助单位','辅助数量','批次号','生产日期','到期日期','备注'],
      rows: doc.lines.map(line => [line.lineNo,line.productCode,line.productName,line.productSpec,line.productCategory,doc.warehouse?.name,line.quantity,line.unit,line.unitPrice,line.amount,line.isGift === true ? '是' : '否',line.inventoryUnit,line.inventoryQuantity,line.batchNo,fmtDay(line.manufactureDate),fmtDay(line.expiryDate),line.note]),
    })
  }, [doc, loading, documentStateUnverified, initialAction, canAudit, canReview, openConfirmation])

  const currentDocumentAvailable = !!doc && (creating || doc.id === docId)
  if (!currentDocumentAvailable && loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
        <div className="rounded-card bg-white p-10 text-gray2" onClick={event => event.stopPropagation()}>加载中…</div>
      </div>
    )
  }
  if (!doc || !currentDocumentAvailable) return <div role="alert" className="p-6"><p>{error || '单据无法加载'}</p><button onClick={() => void load()}>重试</button><button onClick={onClose}>返回</button></div>

  const editable = (creating || doc.status === 'POSTED') && doc.reviewStatus !== 'REVIEWED' && canEdit
  const inbound = doc.type === 'MANUAL_INBOUND'
  const auditAllowed = canAudit && (!inbound || canReview)

  function lineEdit(lineId: string) {
    return lineEdits[lineId] || {}
  }

  function setLineEdit(lineId: string, field: 'amount' | 'quantity' | 'note', value: string) {
    if (busyRef.current || loading || submissionUnknown) return
    setLineEdits(current => ({ ...current, [lineId]: { ...current[lineId], [field]: value } }))
  }

  function hasEdits() {
    if (doc && headerNote !== (doc.note || '')) return true
    if (supplierId && doc && supplierId !== doc.supplierId) return true
    return Object.entries(lineEdits).some(([lineId, edit]) => {
      const line = doc?.lines.find(row => row.id === lineId)
      if (!line) return false
      if (edit.amount !== undefined && edit.amount !== '' && warehouseDocumentDecimalChanged(edit.amount, line.amount, 4)) return true
      if (edit.quantity !== undefined && edit.quantity !== '' && warehouseDocumentDecimalChanged(edit.quantity, line.quantity, 6)) return true
      if (edit.note !== undefined && edit.note !== (line.note || '')) return true
      return false
    })
  }

  async function saveEdit() {
    if (!doc || busyRef.current || documentStateUnverifiedRef.current || doc.id !== documentScope.current.id) return
    if (Object.entries(lineEdits).some(([id, edit]) => ['amount', 'quantity'].some(field => {
      const value = edit[field as 'amount' | 'quantity']
      if (value === undefined) return false
      return !value.trim() || !Number.isFinite(Number(value)) || (field === 'amount' && doc.lines.find(line => line.id === id)?.isGift ? Number(value) !== 0 : Number(value) <= 0)
    }))) { setError('数量和金额必须是有效且大于0的数字；明确赠品金额固定为0'); return }
    if (editReason.trim().length < 2) { setError('请填写修改原因'); return }
    const scope = { ...documentScope.current }
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const lines = Object.entries(lineEdits).map(([lineId, edit]) => {
        const line = doc.lines.find(row => row.id === lineId)!
        return {
          lineId,
          amount: edit.amount !== undefined && edit.amount !== '' && warehouseDocumentDecimalChanged(edit.amount, line.amount, 4) ? Number(edit.amount) : undefined,
          quantity: edit.quantity !== undefined && edit.quantity !== '' && warehouseDocumentDecimalChanged(edit.quantity, line.quantity, 6) ? Number(edit.quantity) : undefined,
          note: edit.note !== undefined && edit.note !== (line.note || '') ? edit.note : undefined,
        }
      }).filter(row => row.amount !== undefined || row.quantity !== undefined || row.note !== undefined)
      const result = await apiFetch<{ ok: boolean; changed: boolean }>(`/api/warehouse-docs/${doc.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          editReason: editReason.trim(),
          supplierId: supplierId !== (doc.supplierId || '') ? supplierId : undefined,
          note: headerNote !== (doc.note || '') ? headerNote : undefined,
          lines,
        }),
      })
      if (!isDocumentScopeCurrent(scope)) return
      markDocumentStateUnverified()
      onChanged(result.changed ? `单据 ${doc.docNo} 已修改，金额变化已同步库存台账` : `单据 ${doc.docNo} 无实质修改`)
      await load()
    } catch (reason: any) {
      if (!isDocumentScopeCurrent(scope)) return
      handleDocumentWriteFailure(reason)
    } finally {
      if (isDocumentScopeCurrent(scope)) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  function review() {
    if (!doc || busyRef.current || documentStateUnverifiedRef.current || doc.id !== documentScope.current.id) return
    const scope = { ...documentScope.current }
    openConfirmation({
      title: '复审',
      body: '确认复审该单据？复审后流程结束，不能取消复审或反审核。库存数量和金额保持不变。',
      confirmLabel: '确认复审',
      layerClassName: 'z-[100]',
      onConfirm: async () => {
        if (!isDocumentScopeCurrent(scope) || documentStateUnverifiedRef.current || busyRef.current) return
        busyRef.current = true
        setBusy(true); setError(null)
        try {
          await apiFetch(`/api/warehouse-docs/${doc.id}/review`, { method: 'POST', body: '{}' })
          if (!isDocumentScopeCurrent(scope)) return
          markDocumentStateUnverified()
          onChanged(`单据 ${doc.docNo} 已复审`)
          await load()
        } catch (reason: any) { if (!isDocumentScopeCurrent(scope)) return; throw new Error(handleDocumentWriteFailure(reason)) }
        finally { if (isDocumentScopeCurrent(scope)) { busyRef.current = false; setBusy(false) } }
      },
    })
  }

  async function confirm() {
    if (!doc || busyRef.current || documentStateUnverifiedRef.current || doc.id !== documentScope.current.id) return
    if (dirty) { setError('请先保存修改，再审核单据'); return }
    const scope = { ...documentScope.current }
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`/api/warehouse-docs/${doc.id}/confirm`, { method: 'POST', body: JSON.stringify({}) })
      if (!isDocumentScopeCurrent(scope)) return
      markDocumentStateUnverified()
      onChanged(`单据 ${doc.docNo} 已审核锁定`)
      await load()
    } catch (reason: any) {
      if (!isDocumentScopeCurrent(scope)) return
      handleDocumentWriteFailure(reason)
    } finally {
      if (isDocumentScopeCurrent(scope)) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  async function unconfirm() {
    if (!doc || busyRef.current || documentStateUnverifiedRef.current || doc.id !== documentScope.current.id) return
    if (unauditReason.trim().length < 2) { setError('请填写退回原因'); return }
    const scope = { ...documentScope.current }
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`/api/warehouse-docs/${doc.id}/unconfirm`, {
        method: 'POST',
        body: JSON.stringify({ reason: unauditReason.trim() }),
      })
      if (!isDocumentScopeCurrent(scope)) return
      markDocumentStateUnverified()
      onChanged(`单据 ${doc.docNo} 已退回，仓库可修改`)
      setUnauditOpen(false)
      await load()
    } catch (reason: any) {
      if (!isDocumentScopeCurrent(scope)) return
      handleDocumentWriteFailure(reason)
    } finally {
      if (isDocumentScopeCurrent(scope)) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  const confirmationScope = { ...documentScope.current }
  return (
    <div className={fullPage ? sheet.page : 'fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4'} onClick={() => { if (!fullPage) protectClose() }}>
      <ConfirmSheet key={`${docId || newType}:${confirmationScope.epoch}`} {...confirmation} close={() => { if (isDocumentScopeCurrent(confirmationScope)) confirmation.close() }} />
      <div
        className={fullPage ? 'w-full bg-white' : 'max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-card bg-white p-6'}
        onClick={event => event.stopPropagation()}
      >
        <div className={fullPage ? sheet.header : "mb-4 flex items-start justify-between"}>
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-title font-semibold font-num">{creating ? creatingOutbound ? '新建出库单' : '新建入库单' : fullPage ? '编辑' : doc.docNo}</h2>
              {creating ? <span className="text-caption text-gray2">草稿</span> : <StatusBadge status={doc.status} />}
              <span className="text-caption text-gray2">{inbound ? '入库单' : '出库单'}</span>
              {!creating && <DocumentQualityImageButton kind="WAREHOUSE" sourceId={doc.id} initialOpen={initialAction === 'quality'} />}
            </div>
            <p className="mt-1 text-caption text-gray2">
              单据日期 {fmtDay(doc.effectiveAt)} · 制单 {fmtTime(doc.createdAt)}
              {doc.confirmedAt ? ` · 审核 ${fmtTime(doc.confirmedAt)}` : ''}
            </p>
          </div>
          <button disabled={busy || confirmation.open} onClick={() => protectClose()} className="rounded-cta border border-border px-3 py-1.5 text-button text-gray2">{fullPage ? '返回列表' : '关闭'}</button>
        </div>

        {doc.unauditReason && doc.status === 'POSTED' && (
          <div className="mb-3 rounded-card border border-amber-200 bg-amber-50 px-4 py-2 text-body text-amber-fg">
            已退回：{doc.unauditReason}（{fmtTime(doc.unauditedAt)}）—— 修改后重新审核
          </div>
        )}
        {error && <div role="alert" className="mb-3 rounded-card border border-red-200 bg-red-50 px-4 py-2 text-body text-red-600">{error}</div>}

        {documentStateUnverified && <div className="mb-3"><p role="status">本页审批状态尚未核对，请先加载最新状态；本页输入已保留。</p><button disabled={busy || loading} onClick={() => void load({ preserveInputs: true })}>加载最新单据状态</button></div>}
        {creating && <div className="mb-4 space-y-2"><p role="status">{newDraft.status}</p>{newDraft.ready&&(!newDraft.snapshot||newDraft.snapshot.products.some((row:any)=>!row.units||!row.enabled||!row.displayMatched||(!creatingOutbound&&!row.units.structured?.purchase)))&&<p className="text-amber-700">草稿仓库或单位尚未核对，请先重新核对，再提交。</p>}{newDraft.failure && <p role="alert" className="text-red-600">{newDraft.failure}</p>}{(newDraft.failure || error) && !newDraft.terminalStatus && <><button disabled={busy || submissionUnknown ||newDraft.reloading || (creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} onClick={() => void newDraft.reload(false).catch(reason => setError(reason.message))}>加载服务器草稿</button><button disabled={busy || submissionUnknown ||newDraft.reloading || (creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} onClick={() => void newDraft.reload(true).catch(reason => setError(reason.message))}>保留本页输入并重新保存</button></>}{submissionUnknown && <button disabled={busy} onClick={() => void submitNew(false)}>核对原提交</button>}</div>}
        {/* 表头 */}
        <div className={fullPage ? sheet.meta : "mb-4 grid grid-cols-1 gap-3 rounded-card border border-border p-4 sm:grid-cols-2 lg:grid-cols-4"}>
          <div className="space-y-1 text-caption text-gray2">{inbound ? '采购机构' : '机构'}<div className="text-body text-ink">{doc.organizationName || '—'}</div></div>
          <div className="space-y-1 text-caption text-gray2">单据编号<div className="text-body text-ink">{doc.docNo}</div></div>
          <div className="space-y-1 text-caption text-gray2">{inbound ? '入库日期' : '出库日期'}{creating ? <input aria-label={inbound ? "入库日期" : "出库日期"} type="date" disabled={busy || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} value={new Date(doc.effectiveAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })} onChange={event => { if (event.target.value) setDoc({ ...doc, effectiveAt: new Date(`${event.target.value}T00:00:00+08:00`).toISOString() }) }} className="h-9 w-full rounded-cta border border-border px-2 text-body text-ink" /> : <div className="text-body text-ink">{fmtDay(doc.effectiveAt)}</div>}</div>
          {inbound ? (
            <label className="space-y-1 text-caption text-gray2">
              供应商
              {editable ? (
                <select
                  aria-label="供应商"
                  disabled={busy || loading || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))}
                  value={supplierId}
                  onChange={event => setSupplierId(event.target.value)}
                  className="h-9 w-full rounded-cta border border-border bg-white px-2 text-body text-ink"
                >
                  {!supplierId && <option value="">未指定</option>}
                  {suppliers.map(supplier => (
                    <option key={supplier.id} value={supplier.id}>{supplier.no ? `${supplier.no} ` : ''}{supplier.name}</option>
                  ))}
                </select>
              ) : (
                <div className="text-body text-ink">{doc.supplierName || '—'}</div>
              )}
            </label>
          ) : (
            <div className="space-y-1 text-caption text-gray2">
              去向/原因
              {creating ? <input aria-label="出库原因/去向" maxLength={120} value={outboundReason} disabled={busy || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} onChange={e=>setOutboundReason(e.target.value)} className="h-9 w-full rounded-cta border border-border px-2 text-body text-ink" /> : <div className="text-body text-ink">{doc.reason || '—'}</div>}
            </div>
          )}
          {creatingOutbound && <><label className="space-y-1 text-caption text-gray2">出库用途<select aria-label="出库用途" value={outboundPurpose} disabled={busy || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} onChange={e=>setOutboundPurpose(e.target.value)} className="h-9 w-full rounded-cta border border-border text-body text-ink"><option value="">请选择用途</option><option value="STORE_REALLOCATION">门店拨补</option><option value="SAMPLE_ISSUE">样品领用</option><option value="HISTORICAL_CORRECTION">历史补录</option></select></label><label className="space-y-1 text-caption text-gray2">责任归属<input aria-label="责任归属" value={outboundResponsibility} maxLength={114} disabled={busy || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} onChange={e=>setOutboundResponsibility(e.target.value)} className="h-9 w-full rounded-cta border border-border px-2 text-body text-ink" /></label><label className="space-y-1 text-caption text-gray2">去向名称<input aria-label="去向名称" value={outboundSource} maxLength={120} disabled={busy || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} onChange={e=>setOutboundSource(e.target.value)} className="h-9 w-full rounded-cta border border-border px-2 text-body text-ink" /></label><p className="text-caption text-gray2 sm:col-span-2">数量使用库存基准单位，成本留空时按提交时台账成本计算；总仓自损仍使用独立自损入口，不能从此处绕过责任和证据要求。</p></>}
          <div className={fullPage ? sheet.wide : "space-y-1 text-caption text-gray2"}>
            备注
            {editable ? <input disabled={busy || loading || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} aria-label="单据备注" value={headerNote} maxLength={240} onChange={event => setHeaderNote(event.target.value)} className="h-9 w-full rounded-cta border border-border px-2 text-body text-ink" /> : <div className="text-body text-ink">{doc.note || '—'}</div>}
          </div>
          <div className={fullPage ? `${sheet.wide} ${sheet.attachments}` : "space-y-2 text-caption text-gray2 sm:col-span-2"}>
            {creating && <label className="block text-accent">上传附件<input aria-label="上传随货附件" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" disabled={busy || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; void uploadNewAttachments(files) }} /></label>}
            <div>{inbound ? '供应商随货单据' : '现场证据'}（{doc.attachments?.length || 0}份）</div>
            {doc.attachments?.length ? <div className="flex flex-wrap gap-2">{doc.attachments.map((item, index) => (
              <a key={`${item.name}-${index}`} href={item.url} target="_blank" rel="noreferrer" className="rounded-cta border border-border bg-bg px-3 py-2 text-caption text-accent hover:underline">
                {item.name} · {(item.size / 1024 / 1024).toFixed(1)}MB
              </a>
            ))}</div> : <div className="text-body text-gray3">未上传</div>}
          </div>
        </div>

        {creating && <div className={sheet.toolbar}><input aria-label="查询可用物品" placeholder="名称 / 编码 / 规格" maxLength={100} value={candidateQuery} disabled={busy||submissionUnknown||candidateBusy || (creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} onChange={event=>setCandidateQuery(event.target.value)}/><button disabled={busy||submissionUnknown||candidateBusy || (creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} onClick={()=>void loadCandidates()}>查询物品</button>{candidateCursor&&<button disabled={busy||submissionUnknown||candidateBusy || (creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} onClick={()=>void loadCandidates(true)}>加载更多物品</button>}<button disabled={busy||submissionUnknown||Boolean(newDraft.terminalStatus)} onClick={reconfirmDraft} className="rounded-cta border border-border px-3">{newDraft.reconfirmPending?'核对原请求':'重新核对仓库与单位'}</button><select aria-label={inbound ? "添加入库物品" : "添加出库物品"} value={selectedProduct} disabled={busy || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} onChange={event => setSelectedProduct(event.target.value)} className="h-9 min-w-64 border border-border px-2"><option value="">选择物品</option>{candidates.filter(product => product.eligible!==false&&!doc.lines.some(line => line.productId === product.id)).map(product => <option key={product.id} value={product.id}>{product.code} {product.name}</option>)}</select><button disabled={busy || submissionUnknown || !selectedProduct || (creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} onClick={addProduct} className="rounded-cta border border-border px-3">添加物品</button></div>}
        {/* 行明细 */}
        <div className={sheet.tableWrap}><table data-row-actions={creating} className="mb-4 w-full min-w-[1400px] text-body">
          <thead>
            <tr className="border-b border-border text-left text-caption text-gray2">
              <th className="py-2 pr-2">#</th>{creating && <th className="py-2 pr-2">操作</th>}
              <th data-column="code" className="py-2 pr-2">物品编码</th>
              <th data-column="name" className="py-2 pr-2">物品名称</th>
              <th className="py-2 pr-2">规格型号</th>
              <th className="py-2 pr-2">物品类别</th>
              <th className="py-2 pr-2">仓库</th>
              <th className="py-2 pr-2 text-right">数量</th>
              <th className="py-2 pr-2">{inbound ? '采购单位' : '库存单位'}</th>
              <th className="py-2 pr-2 text-right">单价</th>
              <th className="py-2 pr-2 text-right">金额{inbound ? '（价税合计）' : '（成本）'}</th>
              <th className="py-2 pr-2">是否赠品</th>
              <th className="py-2 pr-2">辅助单位</th>
              <th className="py-2 pr-2 text-right">辅助数量</th>
              <th className="py-2 pr-2">批次号</th>
              <th className="py-2 pr-2">生产日期</th>
              <th className="py-2 pr-2">到期日期</th>
              <th className="py-2">备注</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.map(line => {
              const edit = lineEdit(line.id)
              return (
                <tr key={line.id} className="border-b border-border last:border-0">
                  <td className="py-2 pr-2 font-num text-gray2">{line.lineNo}</td>{creating && <td><button disabled={busy || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} onClick={() => { setDoc({ ...doc, lines: doc.lines.filter(item => item.id !== line.id).map((item, index) => ({ ...item, lineNo: index + 1 })) }); setLineEdits(current => { const next = { ...current }; delete next[line.id]; return next }) }}>移除</button></td>}
                  <td data-column="code" className="py-2 pr-2" title="物品编码、规格和类别为当前商品资料">{line.productCode || '—'}</td>
                  <td data-column="name" className="py-2 pr-2">{line.productName}</td>
                  <td className="py-2 pr-2">{line.productSpec || '—'}</td>
                  <td className="py-2 pr-2">{line.productCategory || '—'}</td>
                  <td className="py-2 pr-2">{doc.warehouse?.name || '—'}</td>
                  <td className="py-2 pr-2 text-right font-num">
                    {editable && (inbound || creating) ? (
                      <input
                        disabled={busy || loading || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))}
                        aria-label={`${line.productName}数量`}
                        value={edit.quantity ?? String(line.quantity)}
                        onChange={event => setLineEdit(line.id, 'quantity', event.target.value)}
                        className="h-8 w-24 rounded-cta border border-border px-2 text-right font-num"
                      />
                    ) : fmtQty(line.quantity)}
                  </td>
                  <td className="py-2 pr-2">{line.unit}</td>
                  <td className="py-2 pr-2 text-right font-num">{editable && inbound ? <input
                    aria-label={`${line.productName}入库单价`} disabled={busy || loading || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus))) || line.isGift === true}
                    value={Number(edit.quantity ?? line.quantity) > 0 && (edit.amount ?? String(line.amount)) !== '' ? String(Number((Number(edit.amount ?? line.amount) / Number(edit.quantity ?? line.quantity)).toFixed(6))) : ''}
                    onChange={event => {
                      const price = event.target.value
                      setLineEdit(line.id, 'amount', price.trim() && Number.isFinite(Number(price)) ? String(Number((Number(price) * Number(edit.quantity ?? line.quantity)).toFixed(4))) : '')
                    }} className="h-8 w-24 rounded-cta border border-border px-2 text-right font-num" />
                    : creatingOutbound ? (edit.amount?.trim() && Number(edit.quantity)>0 ? money(Number(edit.amount)/Number(edit.quantity)) : '提交时计算') : Number(line.quantity) > 0 ? money(Number(line.amount) / Number(line.quantity)) : '—'}</td>
                  <td className="py-2 pr-2 text-right font-num">
                    {editable ? (
                      <input
                        disabled={busy || loading || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus))) || line.isGift === true}
                        aria-label={`${line.productName}金额`}
                        placeholder={creatingOutbound ? "留空自动计算成本" : undefined} value={edit.amount ?? String(line.amount)}
                        onChange={event => setLineEdit(line.id, 'amount', event.target.value)}
                        className="h-8 w-28 rounded-cta border border-border px-2 text-right font-num"
                      />
                    ) : money(line.amount)}
                  </td>
                  <td className="py-2 pr-2"><input type="checkbox" aria-label={`${line.productName}是否赠品`} checked={line.isGift === true} disabled={!creating || creatingOutbound || busy || submissionUnknown || (creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} onChange={event => {
                    const isGift = event.target.checked
                    setDoc({ ...doc, lines: doc.lines.map(item => item.id === line.id ? { ...item, isGift } : item) })
                    setLineEdits(current => ({ ...current, [line.id]: { ...current[line.id], amount: isGift ? '0' : '' } }))
                  }} /></td>
                  <td className="py-2 pr-2">{line.inventoryUnit}</td>
                  <td className="py-2 pr-2 text-right font-num">{creating&&inbound&&(!line.unit||!line.inventoryUnit||Number(line.inventoryQuantity)<=0)?'待核对':Number(line.quantity) > 0 ? fmtQty(Number(edit.quantity ?? line.quantity) * Number(line.inventoryQuantity) / Number(line.quantity)) : '—'}</td>
                  <td className="py-2 pr-2">{creating && inbound ? <input aria-label={`${line.productName}批次号`} maxLength={80} disabled={busy || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} value={line.batchNo || ''} onChange={event => setDoc(current => current ? { ...current, lines: current.lines.map(item => item.id === line.id ? { ...item, batchNo: event.target.value || null } : item) } : current)} className="h-8 w-28 rounded-cta border border-border px-2" /> : line.batchNo || '—'}</td>
                  <td className="py-2 pr-2">{creating && inbound ? <input type="date" aria-label={`${line.productName}生产日期`} disabled={busy || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} value={line.manufactureDate?.slice(0,10) || ''} onChange={event => setDoc(current => current ? { ...current, lines: current.lines.map(item => item.id === line.id ? { ...item, manufactureDate: event.target.value || null } : item) } : current)} className="h-8 w-36 rounded-cta border border-border px-2" /> : fmtDay(line.manufactureDate)}</td>
                  <td className="py-2 pr-2">{creating && inbound ? <input type="date" aria-label={`${line.productName}到期日期`} disabled={busy || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))} value={line.expiryDate?.slice(0,10) || ''} onChange={event => setDoc(current => current ? { ...current, lines: current.lines.map(item => item.id === line.id ? { ...item, expiryDate: event.target.value || null } : item) } : current)} className="h-8 w-36 rounded-cta border border-border px-2" /> : fmtDay(line.expiryDate)}</td>
                  <td className="py-2">
                    {editable ? (
                      <input
                        disabled={busy || loading || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))}
                        aria-label={`${line.productName}备注`}
                        value={edit.note ?? (line.note || '')}
                        onChange={event => setLineEdit(line.id, 'note', event.target.value)}
                        className="h-8 w-32 rounded-cta border border-border px-2"
                      />
                    ) : (line.note || '—')}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="text-body font-semibold">
              <td colSpan={creating ? 10 : 9} className="py-2 text-right text-gray2">合计</td>
              <td className="py-2 text-right font-num">{creatingOutbound && doc.lines.some(line=>!(lineEdit(line.id).amount || '').trim()) ? '提交时计算' : money(doc.lines.reduce((sum, line) => sum + Number(lineEdit(line.id).amount ?? line.amount), 0))}</td>
              <td colSpan={7}></td>
            </tr>
          </tfoot>
        </table></div>

        {/* 改单操作区 */}
        {editable && !creating && (
          <div className="mb-4 space-y-2 rounded-card border border-border p-4">
            <p className="text-caption text-gray2">
              可改：金额/单价、{inbound ? '数量（批次未被消耗时）、供应商、' : ''}备注。保存后同步库存数量和金额，并保留原流水及批次历史。出库单数量不能改（数量差错请走实盘/报损）。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                disabled={busy || loading || submissionUnknown ||(creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus)))}
                value={editReason}
                onChange={event => setEditReason(event.target.value)}
                placeholder="修改原因（必填，如：供应商后补运费）"
                className="h-9 min-w-64 flex-1 rounded-cta border border-border px-3 text-body"
              />
              {!fullPage && <button
                onClick={saveEdit}
                disabled={busy || loading || documentStateUnverified || !hasEdits()}
                className="h-9 rounded-cta bg-accent px-4 text-button text-white disabled:opacity-40"
              >{busy ? '保存中…' : '保存修改'}</button>}
            </div>
          </div>
        )}

        {/* 审核操作区 */}
        <p className="mb-2 text-caption text-gray2">供应链复审：{doc.reviewStatus==='REVIEWED'?'已复审（锁定）':'未复审'}</p>
        {doc.status==='CONFIRMED' && doc.reviewStatus!=='REVIEWED' && canReview && <button disabled={busy || loading || documentStateUnverified} onClick={()=>void review()} className="mb-3 h-9 rounded-cta bg-ink px-4 text-button text-white disabled:opacity-40">复审</button>}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {!creating && !fullPage && doc.status === 'POSTED' && auditAllowed && (
            <button
              onClick={confirm}
              disabled={busy || loading || documentStateUnverified}
              className="h-9 rounded-cta bg-emerald-600 px-4 text-button text-white disabled:opacity-40"
            >{busy ? '处理中…' : '审核（锁定单据）'}</button>
          )}
          {doc.status === 'CONFIRMED' && doc.reviewStatus !== 'REVIEWED' && auditAllowed && !unauditOpen && (
            <button
              onClick={() => setUnauditOpen(true)}
              disabled={busy || loading || documentStateUnverified}
              className="h-9 rounded-cta border border-amber-300 bg-amber-50 px-4 text-button text-amber-fg disabled:opacity-40"
            >反审核（退回仓库修改）</button>
          )}
          {unauditOpen && (
            <div className="flex w-full flex-wrap items-center gap-2 rounded-card border border-amber-200 bg-amber-50 p-3">
              <input
                value={unauditReason}
                onChange={event => setUnauditReason(event.target.value)}
                placeholder="退回原因（必填，仓库人员会看到）"
                className="h-9 min-w-64 flex-1 rounded-cta border border-border bg-white px-3 text-body"
              />
              <button
                onClick={unconfirm}
                disabled={busy || loading || documentStateUnverified}
                className="h-9 rounded-cta bg-amber-600 px-4 text-button text-white disabled:opacity-40"
              >确认退回</button>
              <button onClick={() => setUnauditOpen(false)} className="h-9 rounded-cta border border-border bg-white px-3 text-button text-gray2">取消</button>
            </div>
          )}
          {!auditAllowed && (
            <span className="text-caption text-gray2">审核、反审核与复审由供应链操作</span>
          )}
        </div>

        {fullPage && <footer className={sheet.footer}>
          <button disabled={busy || confirmation.open || submissionUnknown} onClick={() => protectClose()}>取消</button>
          <button disabled={busy || loading || documentStateUnverified || submissionUnknown || (creating&&(newDraft.reconfirmPending||Boolean(newDraft.terminalStatus))) || !editable} onClick={() => void (creating ? saveNewDraft() : saveEdit())}>保存</button>
          <button disabled={busy || loading || documentStateUnverified || submissionUnknown || (creating&&newDraft.reconfirmPending) || !editable || (creating && (!newDraft.ready||!newDraft.snapshot||doc.lines.some(line=>{const saved=newDraft.snapshot.products.find((row:any)=>row.id===line.productId);return !saved?.units||!saved.enabled||!saved.displayMatched||(!creatingOutbound&&!saved.units.structured?.purchase)})))} onClick={() => creating ? requestNewSubmit(false) : hasEdits() ? void saveEdit() : onChanged('当前单据已处于待审核状态')}>提交</button>
          <button disabled={busy || loading || documentStateUnverified || submissionUnknown || (creating&&newDraft.reconfirmPending) || !auditAllowed || doc.status !== 'POSTED' || (creating && (!newDraft.ready||!newDraft.snapshot||doc.lines.some(line=>{const saved=newDraft.snapshot.products.find((row:any)=>row.id===line.productId);return !saved?.units||!saved.enabled||!saved.displayMatched||(!creatingOutbound&&!saved.units.structured?.purchase)})))} onClick={() => creating ? requestNewSubmit(true) : void confirm()}>审核</button>
        </footer>}

        {/* 操作日志 */}
        <details className={sheet.records}>
          <summary>操作记录（{doc.logs.length}条）</summary>
          <ul className="space-y-1 text-caption text-gray2">
            {doc.logs.map(log => (
              <li key={log.id} className="flex flex-wrap gap-2">
                <span className="font-num">{fmtTime(log.createdAt)}</span>
                <span className="text-ink">{LOG_ACTION_LABEL[log.action]}</span>
                <span>{log.actorName || '系统'}</span>
                {log.reason && <span className="text-amber-fg">{log.reason}</span>}
                {log.action === 'EDIT' && log.detail?.lines?.length > 0 && (
                  <span>
                    {log.detail.lines.map((line: any) =>
                      `第${line.lineNo}行${line.productName}${line.amount ? ` 金额${line.amount.from}→${line.amount.to}` : ''}${line.quantity ? ` 数量${line.quantity.from}→${line.quantity.to}` : ''}`
                    ).join('；')}
                  </span>
                )}
                {log.action === 'EDIT' && log.detail?.header?.supplier && (
                  <span>供应商 {log.detail.header.supplier.from || '—'} → {log.detail.header.supplier.to}</span>
                )}
              </li>
            ))}
            {doc.logs.length === 0 && <li>暂无记录</li>}
          </ul>
        </details>
      </div>
    </div>
  )
}
