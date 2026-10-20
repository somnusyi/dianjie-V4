'use client'
import {useCallback,useEffect,useRef,useState} from 'react'
import {apiFetch,getUser} from '@/lib/v2-auth'
import {clientRequestId} from '@/lib/client-id'
import {procurementDecimalProduct,procurementDecimalMin,procurementDecimalQuotient,procurementDecimalProportion} from '@/lib/procurement-decimal-preview'
import {ConfirmSheet,useConfirmSheet} from './confirm-sheet'
import {DocumentQualityImageButton,LegacyQualityImagesButton} from './document-quality-image'
import {procurementApprovalActions,procurementApprovalRequest,PROCUREMENT_APPROVAL_LABELS,type ProcurementApprovalSource,type ProcurementApprovalAction} from '@/lib/procurement-approval'
import {SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT} from './supply-chain-shell'
import {showTableReport} from '@/lib/table-report'
import {procurementDocumentReport} from '@/lib/procurement-document-report'
import sheet from './document-sheet.module.css'
type Kind='RECEIPT'|'RETURN'
type Line={id:string;receiptLineId?:string;sourceQuantity?:string|number;sourceAmount?:string|number;remainingSettlementAmount?:string|number;returnableQuantity?:string|number;unavailableReason?:string|null;purchaseUnit:string;inventoryUnit:string;inventoryUnitsPerPurchaseUnit:string|number;acceptedQty?:string|number;purchaseQuantity?:string|number;arrivedQty?:string|number;damagedQty?:string|number;rejectedQty?:string|number;unitPrice?:string|number;settlementUnitPrice?:string|number;payableAmount?:string|number;settlementAmount?:string|number;batchNo?:string|null;manufactureDate?:string|null;expiryDate?:string|null;note?:string|null;product?:{code:string;name:string;spec?:string|null;category?:string};purchaseOrderLine?:{productCodeSnapshot:string;productNameSnapshot:string;productSpecSnapshot?:string|null};receiptLine?:{acceptedQty?:string|number;payableAmount?:string|number;receipt:{no:string}}}
type Doc=ProcurementApprovalSource&{no:string;note:string|null;organizationName?:string|null;arrivedAt?:string|null;createdAt:string;supplier:{no:string;name:string};warehouse?:{code:string;name:string};purchaseOrder?:{no:string};lines:Line[]}
type Edit={basisAmount:string;basisQty:string;quantity:string;unitPrice:string;amount:string;arrivedQty:string;damagedQty:string;rejectedQty:string;batchNo:string;manufactureDate:string;expiryDate:string;note:string}
const day=(value?:string|null)=>value?.slice(0,10)||''
const businessDay=(value?:string|null)=>{if(!value)return '';const stamp=new Date(value).getTime();return Number.isFinite(stamp)?new Date(stamp+8*60*60*1000).toISOString().slice(0,10):''}
function fields(line:Line,kind:Kind):Edit{return{basisAmount:kind==='RECEIPT'?String(line.payableAmount??''):'',basisQty:kind==='RECEIPT'?String(line.acceptedQty??''):'',quantity:String(kind==='RECEIPT'?line.acceptedQty??0:line.purchaseQuantity??0),unitPrice:String(kind==='RECEIPT'?line.unitPrice??'':line.settlementUnitPrice??''),amount:String(kind==='RECEIPT'?line.payableAmount??'':line.settlementAmount??''),arrivedQty:String(line.arrivedQty??0),damagedQty:String(line.damagedQty??0),rejectedQty:String(line.rejectedQty??0),batchNo:line.batchNo||'',manufactureDate:day(line.manufactureDate),expiryDate:day(line.expiryDate),note:line.note||''}}
function editableValues(edit:Edit|undefined){if(!edit)return edit;const{basisAmount,basisQty,...values}=edit;return values}
export function ProcurementDocumentEditor({kind,sourceId,shipmentId,supplierId,warehouseId,onCreated,onClose}:{kind:Kind;sourceId:string;shipmentId?:string;supplierId?:string;warehouseId?:string;onCreated?:(id:string,action?:string)=>void;onClose:()=>void}){
 const creating=sourceId==='new'&&(kind==='RECEIPT'?Boolean(shipmentId):Boolean(supplierId&&warehouseId))
 const creationScope=kind==='RECEIPT'?shipmentId:`${supplierId}:${warehouseId}`
 const cacheKey=`dj:${kind==='RECEIPT'?'receipt':'return'}-create:${getUser()?.id}:${creationScope}`
 const endpoint=creating?(kind==='RECEIPT'?`/api/upstream/shipments/${encodeURIComponent(shipmentId!)}/receipt-context`:`/api/upstream/purchase-returns/create-context?supplierId=${encodeURIComponent(supplierId!)}&warehouseId=${encodeURIComponent(warehouseId!)}`):`/api/upstream/${kind==='RECEIPT'?'receipts':'purchase-returns'}/${encodeURIComponent(sourceId)}`
 const [reason,setReason]=useState(''),[nextCursor,setNextCursor]=useState<string|null>(null)
 const [doc,setDoc]=useState<Doc|null>(null),[edits,setEdits]=useState<Record<string,Edit>>({}),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[blocked,setBlocked]=useState(false)
 const [comparisonRequired,setComparisonRequired]=useState(false)
 const [confirm,openConfirm]=useConfirmSheet(),busyRef=useRef(false),owner=useRef(0),pendingSave=useRef<{body:unknown;metadataOnly:boolean}|null>(null)
 const activeEndpoint=useRef(endpoint)
 const sourceScope=useRef({endpoint,epoch:0})
 if(sourceScope.current.endpoint!==endpoint)sourceScope.current={endpoint,epoch:sourceScope.current.epoch+1}
 const scopeCurrent=(current:number,epoch:number)=>owner.current===current&&sourceScope.current.endpoint===endpoint&&sourceScope.current.epoch===epoch
 const progressRequest=useRef<{key:string;body:unknown;action:ProcurementApprovalAction;endpoint:string;epoch:number;unknown:boolean}|null>(null)
 const [unknownApproval,setUnknownApproval]=useState(false)
 const actionLabels:Record<ProcurementApprovalAction,string>={save:'保存',submit:'提交',audit:'审核',unconfirm:'反审核',review:'复审'}
 const loadSequence=useRef(0)
 const printed=useRef(false)
 const creation=useRef<{key:string;body?:any;sourceId?:string;submitKey?:string;action?:string}>({key:clientRequestId()})
 const role=getUser()?.role||'',canWrite=['SUPPLY_CHAIN','ADMIN','SUPER_ADMIN'].includes(role),canAudit=role==='SUPPLY_CHAIN'
 const editable=Boolean(doc&&canWrite&&(creating||(!['POSTED','APPROVED','RECEIVED','REVERSED','CANCELLED','REJECTED'].includes(doc.status)&&['DRAFT','PENDING'].includes(doc.approvalStatus||'DRAFT'))))
 const dirty=Boolean(doc&&(note!==(doc.note||'')||(creating&&Boolean(reason))||doc.lines.some(line=>JSON.stringify(editableValues(edits[line.id]))!==JSON.stringify(editableValues(fields(line,kind))))))
 const load=useCallback(async(preserve=false)=>{
   if(activeEndpoint.current!==endpoint)return
   const current=owner.current,sequence=++loadSequence.current
   let result:Doc
   try{
     if(creating){
       const sourceIds=kind==='RETURN'?creation.current.body?.lines?.map((row:any)=>row.receiptLineId).join(','):''
       const context=await apiFetch<any>(kind==='RETURN'?`${endpoint}&requestKey=${encodeURIComponent(creation.current.key)}${sourceIds?`&sourceIds=${encodeURIComponent(sourceIds)}`:''}`:endpoint)
       if(owner.current!==current||sequence!==loadSequence.current)return false
       setNextCursor(context.nextCursor||null)
       if(context.existingSourceId){if(kind==='RETURN')sessionStorage.removeItem(cacheKey);onCreated?.(context.existingSourceId);return false}
       if(creation.current.sourceId){
         sessionStorage.removeItem(cacheKey)
         creation.current={key:clientRequestId()}
       }
       result={...context,id:'new',no:'保存后自动生成',status:'DRAFT',approvalStatus:'DRAFT',approvalVersion:1,rowVersion:0,note:null}
     }else result=await apiFetch<Doc>(endpoint)
   }catch(reason){if(owner.current!==current||sequence!==loadSequence.current)return false;throw reason}
   if(owner.current!==current||activeEndpoint.current!==endpoint||sequence!==loadSequence.current)return false
   setDoc(result);setBlocked(false)
   if(!preserve){
     const cached=creating?creation.current.body:null
     setEdits(Object.fromEntries(result.lines.map(line=>{
       const saved=cached?.lines?.find((row:any)=>(kind==='RECEIPT'?row.shipmentLineId:row.receiptLineId)===line.id)
       if(!saved)return [line.id,fields(line,kind)]
       const restored={...line,...saved,acceptedQty:saved.acceptedQty??line.acceptedQty,purchaseQuantity:saved.purchaseQuantity??line.purchaseQuantity}
       // Old creation requests contain only quantity and unit price. Their own
       // product is authoritative, not the current context's original amount.
       if(kind==='RECEIPT'&&!Object.prototype.hasOwnProperty.call(saved,'payableAmount'))restored.payableAmount=procurementDecimalProduct(String(restored.acceptedQty??''),String(restored.unitPrice??''))
       return [line.id,fields(restored,kind)]
     })))
     setNote(cached?.note??result.note??'');if(creating)setReason(cached?.reason||'')
     if(cached)setNotice('原创建请求结果待核对，已恢复本次填写内容，请核对原保存')
   }else setEdits(current=>({...Object.fromEntries(result.lines.map(line=>[line.id,fields(line,kind)])),...current}))
   return true
 },[endpoint,kind,creating,cacheKey])
 async function loadMore(){
   if(!nextCursor||busyRef.current||!creating||kind!=='RETURN')return
   busyRef.current=true;setBusy(true);const current=owner.current
   try{
     const result=await apiFetch<any>(`${endpoint}&cursor=${encodeURIComponent(nextCursor)}`)
     if(owner.current!==current)return
     setNextCursor(result.nextCursor||null)
     setDoc(original=>original?{...original,lines:[...new Map([...original.lines,...result.lines].map(line=>[line.id,line])).values()]}:original)
     setEdits(original=>({...Object.fromEntries(result.lines.map((line:Line)=>[line.id,fields(line,kind)])),...original}))
   }catch(reason:any){if(owner.current===current)setError(reason.message||'更多来源加载失败')}
   finally{if(owner.current===current){busyRef.current=false;setBusy(false)}}
 }
 async function reload(){
   if(busyRef.current)return
   busyRef.current=true;setBusy(true);const current=owner.current
   try{if(await load(true)){setComparisonRequired(true);setError('');setNotice('已加载最新单据，本页输入保留，请对照后选择保留或采用最新内容')}}
   catch(reason:any){if(owner.current===current)setError(reason.message||'最新单据加载失败')}
   finally{if(owner.current===current){busyRef.current=false;setBusy(false)}}
 }
 useEffect(()=>{activeEndpoint.current=endpoint;const current=++owner.current;confirm.close();printed.current=false;setReason('');setNextCursor(null);setDoc(null);setError('');setNotice('');setBusy(false);busyRef.current=false;setBlocked(false);setComparisonRequired(false);pendingSave.current=null;progressRequest.current=null;setUnknownApproval(false);
   if(creating){creation.current={key:clientRequestId()};try{const cached=JSON.parse(sessionStorage.getItem(cacheKey)||'null');if(cached&&typeof cached.key==='string'){creation.current=cached}}catch{}}
   void load().catch(reason=>{if(owner.current===current)setError(reason.message||'单据加载失败')});return()=>{owner.current++}},[load])
 function close(proceed=onClose){if(busyRef.current)return;if(dirty||pendingSave.current||progressRequest.current?.unknown||(creating&&creation.current.body))openConfirm({title:'离开编辑页？',body:progressRequest.current?.unknown?'原审批结果待核对；离开前请先核对原审批。':'当前修改尚未保存；若提交结果未知，请先核对原保存。',confirmLabel:'离开',onConfirm:proceed});else proceed()}
 useEffect(()=>{
   const warn=(event:BeforeUnloadEvent)=>{if(dirty||busyRef.current||pendingSave.current||progressRequest.current?.unknown||(creating&&creation.current.body)){event.preventDefault();event.returnValue=''}}
   const navigate=(event:Event)=>{if(!dirty&&!busyRef.current&&!pendingSave.current&&!progressRequest.current?.unknown&&!(creating&&creation.current.body))return;event.preventDefault();close((event as CustomEvent<{proceed?:()=>void}>).detail?.proceed||onClose)}
   window.addEventListener('beforeunload',warn);window.addEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT,navigate)
   return()=>{window.removeEventListener('beforeunload',warn);window.removeEventListener(SUPPLY_CHAIN_BEFORE_NAVIGATE_EVENT,navigate)}
 },[dirty,onClose,openConfirm,creating,unknownApproval])
 function update(id:string,key:keyof Edit,value:string){setEdits(current=>{
   const next={...current[id],[key]:value}
   if(kind==='RECEIPT'){
     if(key==='amount'){
       next.basisAmount=value;next.basisQty=next.quantity
       next.unitPrice=Number(next.quantity)>0?procurementDecimalQuotient(value,next.quantity):value.trim()&&Number(value)===0?'0':'—'
     }
     if(key==='quantity'){
       if(Number(next.basisQty)>0&&next.basisAmount.trim()!==''){
         next.amount=procurementDecimalProportion(next.basisAmount,next.quantity,next.basisQty)
         next.unitPrice=procurementDecimalQuotient(next.basisAmount,next.basisQty)
       }else next.amount=procurementDecimalProduct(next.quantity,next.unitPrice)
     }
     if(key==='unitPrice'){
       next.basisAmount='';next.basisQty=''
       next.amount=procurementDecimalProduct(next.quantity,next.unitPrice)
     }
   }
   return {...current,[id]:next}
 })}
 function buildBody(){
   if(!doc)throw Error('单据尚未加载')
   return {...procurementApprovalRequest(doc,clientRequestId()),note,lines:doc.lines.map(line=>{
     const edit=edits[line.id],quantity=Number(edit.quantity),unitPrice=Number(edit.unitPrice)
     if(kind==='RECEIPT'&&quantity===0&&Number(edit.amount)>0)throw Error('数量为0时金额必须为0')
     if(!edit.quantity.trim()||!Number.isFinite(quantity)||quantity<0||(kind==='RETURN'&&!creating&&quantity<=0)||!edit.unitPrice.trim()||!Number.isFinite(unitPrice)||unitPrice<0)throw Error('请填写有效数量和单价')
     if(kind==='RETURN'){if(creating&&line.returnableQuantity!=null&&quantity>Number(line.returnableQuantity))throw Error('退货数量不能超过可退数量');return{id:line.id,quantity,note:edit.note}}
     const arrivedQty=Number(edit.arrivedQty),damagedQty=Number(edit.damagedQty),rejectedQty=Number(edit.rejectedQty)
     if([edit.arrivedQty,edit.damagedQty,edit.rejectedQty].some(value=>!value.trim())||[arrivedQty,damagedQty,rejectedQty].some(value=>!Number.isFinite(value)||value<0))throw Error('实到、破损和拒收数量必须有效')
     if(!/^\d+(?:\.\d{1,4})?$/.test(edit.amount.trim()))throw Error('请填写非负金额，最多四位小数')
     return{id:line.id,quantity,unitPrice,payableAmount:edit.amount.trim(),arrivedQty,damagedQty,rejectedQty,batchNo:edit.batchNo||null,manufactureDate:edit.manufactureDate||null,expiryDate:edit.expiryDate||null,note:edit.note}
   })}
 }
 async function save(){
   if(!doc||activeEndpoint.current!==endpoint||busyRef.current||blocked||comparisonRequired||progressRequest.current?.unknown||!canWrite)return false
   if(creating)return createReceiptDraft()
   busyRef.current=true;setBusy(true);setError('');setNotice('');let acknowledged=false;const current=owner.current
   try{
     pendingSave.current ||= editable?{body:buildBody(),metadataOnly:false}:{body:{note,sourceVersion:doc.sourceVersion??doc.rowVersion,requestId:clientRequestId()},metadataOnly:true}
     const metadataOnly=pendingSave.current.metadataOnly
     await apiFetch(metadataOnly?`${endpoint}/note`:endpoint,{method:metadataOnly?'PATCH':'PUT',body:JSON.stringify(pendingSave.current.body)});acknowledged=true;if(owner.current!==current)return false;pendingSave.current=null
     setNotice(metadataOnly?'备注已保存，业务字段及审批状态未改变':'修改已保存，尚未改变库存');await load();return true
   }catch(reason:any){
     if(owner.current!==current)return false
     if(acknowledged){setBlocked(true);setError('修改已保存，但最新单据加载失败，请重新加载后继续')}
     else{if([400,403,404,409,422].includes(reason.status))pendingSave.current=null;if(reason.status===409)setBlocked(true);setError(`${reason.message||'保存失败'}${pendingSave.current?'；结果待核对，请重试原保存，不要重复新建':''}`)}
     return false
   }finally{if(owner.current===current){busyRef.current=false;setBusy(false)}}
 }
 async function createReceiptDraft(action?:string){
   if(!doc||!creating||busyRef.current||blocked||comparisonRequired||!canWrite)return false
   busyRef.current=true;setBusy(true);setError('');const current=owner.current
   const attempt=creation.current
   try{
     if(attempt.sourceId){onCreated?.(attempt.sourceId);return true}
     if(!attempt.body){const editsBody=buildBody();
       if(kind==='RETURN'){
         if(reason.trim().length<2||reason.trim().length>240)throw Error('退货原因需为2至240个字符')
         const lines=editsBody.lines.filter(row=>row.quantity>0).map(row=>({receiptLineId:row.id,purchaseQuantity:row.quantity,note:row.note}))
         if(!lines.length||lines.length>500)throw Error('请选择1至500行并填写本次退货数量')
         attempt.body={idempotencyKey:attempt.key,supplierId,warehouseId,reason:reason.trim(),note:editsBody.note||undefined,lines}
       }else attempt.body={idempotencyKey:attempt.key,finalForShipment:true,note:editsBody.note,lines:editsBody.lines.map(row=>({shipmentLineId:row.id,arrivedQty:(row as any).arrivedQty,acceptedQty:row.quantity,damagedQty:(row as any).damagedQty,rejectedQty:(row as any).rejectedQty,unitPrice:(row as any).unitPrice,payableAmount:(row as any).payableAmount,batchNo:(row as any).batchNo||undefined,manufactureDate:(row as any).manufactureDate||undefined,expiryDate:(row as any).expiryDate||undefined,note:row.note}))}
     }
     attempt.action ||= action
     sessionStorage.setItem(cacheKey,JSON.stringify(attempt))
     const response=await apiFetch<any>(kind==='RECEIPT'?`/api/upstream/shipments/${encodeURIComponent(shipmentId!)}/receipts`:'/api/upstream/purchase-returns',{method:'POST',body:JSON.stringify(attempt.body)})
     const result=kind==='RECEIPT'?response:response.purchaseReturn
     if(!result?.id)throw Error('创建响应缺少单据标识，请核对原请求')
     attempt.sourceId=result.id;sessionStorage.setItem(cacheKey,JSON.stringify(attempt))
     if(owner.current!==current)return true
     if(attempt.action==='submit'&&result.approvalStatus==='DRAFT'){
       attempt.submitKey ||= clientRequestId();sessionStorage.setItem(cacheKey,JSON.stringify(attempt))
       await apiFetch(`/api/upstream/${kind==='RECEIPT'?'receipts':'purchase-returns'}/${encodeURIComponent(result.id)}/approval/submit`,{method:'POST',body:JSON.stringify({approvalVersion:result.approvalVersion,sourceVersion:result.rowVersion,requestId:attempt.submitKey})})
     }
     if(owner.current===current){if(kind==='RETURN')sessionStorage.removeItem(cacheKey);setNotice('草稿已保存，库存未改变');onCreated?.(result.id)}
     return true
   }catch(reason:any){if(owner.current===current){if(attempt.sourceId){setError('草稿已保存，提交结果待核对，请打开原单继续');onCreated?.(attempt.sourceId)}else{if([400,403,404,409,422].includes(reason.status)){attempt.body=undefined;sessionStorage.removeItem(cacheKey)}setError(`${reason.message||'保存失败'}${attempt.body?'；原创建请求已保留，请核对原保存':''}`)}}return false}
   finally{if(owner.current===current){busyRef.current=false;setBusy(false)}}
 }
 async function progress(action:ProcurementApprovalAction,retryOriginal=false){
   if(!doc||activeEndpoint.current!==endpoint||busyRef.current||blocked||comparisonRequired)return
   const original=progressRequest.current
   if(original?.unknown&&!retryOriginal)return
   if(retryOriginal&&(!original?.unknown||original.action!==action||original.endpoint!==endpoint||original.epoch!==sourceScope.current.epoch))return
   if(dirty){setError('请先保存修改，再提交或审核');return}
   busyRef.current=true;setBusy(true);setError('');setNotice('');let acknowledged=false,sent=false;const current=owner.current,epoch=sourceScope.current.epoch
   let attempt:NonNullable<typeof progressRequest.current>|null=null
   try{
     const key=`${sourceId}:${action}:${doc.approvalVersion}:${doc.rowVersion}`
     if(retryOriginal)attempt=original!
     else{
       if(progressRequest.current?.key!==key)progressRequest.current={key,body:procurementApprovalRequest(doc,clientRequestId()),action,endpoint,epoch,unknown:false}
       attempt=progressRequest.current!
     }
     sent=true
     await apiFetch(`${attempt.endpoint}/approval/${attempt.action}`,{method:'POST',body:JSON.stringify(attempt.body)});acknowledged=true
     if(!scopeCurrent(current,epoch))return
     if(progressRequest.current===attempt)progressRequest.current=null
     setUnknownApproval(false)
     setNotice(action==='review'?'复审完成，库存已生效':'审批进度已更新，库存未改变');await load()
   }catch(reason:any){
     if(!scopeCurrent(current,epoch))return
     if(acknowledged||reason.status===409){if(attempt)attempt.unknown=false;setBlocked(true);if(progressRequest.current===attempt)progressRequest.current=null;setUnknownApproval(false)}
     else if(sent&&attempt&&!([400,401,403,404,405,422,429].includes(reason.status))){attempt.unknown=true;setUnknownApproval(true)}
     else{if(attempt)attempt.unknown=false;if(progressRequest.current===attempt)progressRequest.current=null;setUnknownApproval(false)}
     const message=acknowledged?'进度已更新，但最新单据加载失败，请重新加载':attempt?.unknown?`${reason.message||'操作结果未确认'}；原审批结果待核对，请核对原${actionLabels[action]}`:reason.message||'操作失败'
     setError(message);throw new Error(message)
   }finally{if(scopeCurrent(current,epoch)){busyRef.current=false;setBusy(false)}}
 }
 function recheckApproval(){
   const attempt=progressRequest.current,current=owner.current,epoch=sourceScope.current.epoch
   if(busyRef.current||blocked||!attempt?.unknown||attempt.endpoint!==endpoint||attempt.epoch!==epoch)return
   openConfirm({title:'核对原审批',body:`核对刚才的${actionLabels[attempt.action]}，保持原操作，不另发起其他审批。`,confirmLabel:'核对原审批',onConfirm:async()=>{if(!scopeCurrent(current,epoch)||progressRequest.current!==attempt)return;await progress(attempt.action,true)}})
 }
 function ask(action:'submit'|'audit'|'unconfirm'|'review'){
   if(busyRef.current||blocked||comparisonRequired||progressRequest.current?.unknown)return
   const current=owner.current,epoch=sourceScope.current.epoch
   if(creating){openConfirm({title:'保存并提交草稿',body:'先保存本次单据，提交后待审核，不增减库存。',confirmLabel:'提交',onConfirm:()=>scopeCurrent(current,epoch)?createReceiptDraft('submit').then(()=>{}):undefined});return}
   const label={submit:'提交',audit:'审核',unconfirm:'反审核',review:'复审'}[action]
   openConfirm({title:label,body:action==='review'?'另一名供应链人员复审后实际过账，完成后不能取消复审。':'本操作只改变进度，不增减库存。',confirmLabel:label,onConfirm:()=>scopeCurrent(current,epoch)?progress(action):undefined})
 }
 function print(){
   if(!doc)return
   const current={...doc,note,...(creating&&kind==='RETURN'?{reason}:{}),lines:doc.lines.map(line=>{const edit=edits[line.id]||fields(line,kind);return kind==='RECEIPT'?{...line,acceptedQty:edit.quantity,unitPrice:edit.unitPrice,payableAmount:edit.amount,batchNo:edit.batchNo,manufactureDate:edit.manufactureDate||null,expiryDate:edit.expiryDate||null,note:edit.note}:{...line,purchaseQuantity:edit.quantity,settlementAmount:displayAmount(line),note:edit.note}})}
   const report=procurementDocumentReport(kind,current)
   if(creating||dirty)report.subtitle=`未保存预览 · ${report.subtitle||''}`
   showTableReport(report)
 }
 useEffect(()=>{if(!doc||printed.current||creating||blocked||comparisonRequired||progressRequest.current?.unknown)return;const action=new URLSearchParams(window.location.search).get('action');if(action==='print'){printed.current=true;print()}if(['submit','audit','unconfirm','review'].includes(action||'')&&procurementApprovalActions(doc,role).includes(action as ProcurementApprovalAction)){printed.current=true;ask(action as 'submit'|'audit'|'unconfirm'|'review')}},[doc,blocked,comparisonRequired])
 if(!doc)return <div className="p-6"><button onClick={()=>close()}>返回列表</button><p role={error?'alert':'status'}>{error||'正在加载单据…'}</p></div>
 const disabled=busy||blocked||comparisonRequired||unknownApproval||Boolean(pendingSave.current)||Boolean(creating&&creation.current.body)
 const displayAmount=(line:Line)=>{
   const edit=edits[line.id]||fields(line,kind)
   if(kind==='RECEIPT')return procurementDecimalProduct(edit.amount,'1')
   if(!edit.quantity.trim()||!Number.isFinite(Number(edit.quantity))||Number(edit.quantity)<0)return '—'
   if(Number(edit.quantity)===Number(line.purchaseQuantity))return procurementDecimalProduct(String(line.settlementAmount??0),'1')
   const sourceQuantity=line.sourceQuantity??line.receiptLine?.acceptedQty,sourceAmount=line.sourceAmount??line.receiptLine?.payableAmount
   if(sourceQuantity!=null&&sourceAmount!=null){
     if(line.returnableQuantity!=null&&line.remainingSettlementAmount!=null&&Number(edit.quantity)===Number(line.returnableQuantity))return procurementDecimalProduct(String(line.remainingSettlementAmount),'1')
     const proportional=procurementDecimalProportion(String(sourceAmount),edit.quantity,String(sourceQuantity))
     return line.remainingSettlementAmount!=null?procurementDecimalMin(proportional,String(line.remainingSettlementAmount)):proportional
   }
   return procurementDecimalProduct(edit.quantity,edit.unitPrice)
 }
 const displaySum=(values:string[],places:number)=>{if(values.some(value=>!/^\d+\.\d+$/.test(value)))return '—';const sum=values.reduce((total,value)=>total+BigInt(value.replace('.','')),BigInt(0)).toString().padStart(places+1,'0');return `${sum.slice(0,-places)}.${sum.slice(-places)}`}
 const confirmationOwner=owner.current,confirmationEpoch=sourceScope.current.epoch
 return <div className={sheet.page}><ConfirmSheet key={`${endpoint}:${confirmationEpoch}`} {...confirm} close={()=>{if(scopeCurrent(confirmationOwner,confirmationEpoch))confirm.close()}}/>
   <header className={sheet.header}><div className="flex items-center gap-3"><button disabled={busy} onClick={()=>close()}>← 返回</button><h1 className="text-2xl font-bold">{creating?(kind==='RECEIPT'?'新建采购入库单':'新建采购退货单'):'编辑'}</h1><span>{doc.approvalStatus?PROCUREMENT_APPROVAL_LABELS[doc.approvalStatus]:doc.status==='DRAFT'?'待提交':doc.status}</span></div><div className="flex items-center gap-4">{doc.approvalStatus==='AUDITED'&&canAudit&&!['POSTED','APPROVED','RECEIVED'].includes(doc.status)&&<><button disabled={disabled||dirty} onClick={()=>ask('unconfirm')}>反审核</button><button disabled={disabled||dirty} onClick={()=>ask('review')}>复审</button></>}<button disabled={busy} onClick={print}>打印</button><button disabled={!canWrite||disabled} onClick={()=>void save()}>保存</button></div></header>
   {error&&<p role="alert" className="my-3 text-red-600">{error}</p>}{notice&&<p role="status" className="my-3 text-green-700">{notice}</p>}
   {unknownApproval&&<section aria-label="原审批结果待核对"><p>原审批结果待核对，其他修改和审批暂不可用。</p><button disabled={busy||blocked} onClick={recheckApproval}>核对原审批</button></section>}
   {pendingSave.current&&<button disabled={busy} onClick={()=>void save()}>核对原保存</button>}{creating&&creation.current.body&&<button disabled={busy} onClick={()=>void createReceiptDraft()}>核对原保存</button>}{blocked&&<button disabled={busy} onClick={()=>void reload()}>重新加载最新单据</button>}
   {comparisonRequired&&<section aria-label="最新单据对照" className="my-3 rounded-lg border border-border bg-bg p-3">
    <h2>最新单据对照</h2><p>服务器最新备注：{doc.note||'（空）'}</p><p>本页备注：{note||'（空）'}</p>
    <div className="overflow-x-auto"><table><thead><tr><th>服务器最新物品</th><th>单位</th><th>字段</th><th>服务器最新值</th><th>本页输入</th></tr></thead><tbody>{doc.lines.flatMap(line=>{
      const saved=fields(line,kind),local=edits[line.id]||saved,labels:Record<Exclude<keyof Edit,'basisAmount'|'basisQty'>,string>={quantity:'数量',unitPrice:'单价',amount:'金额',arrivedQty:'实到',damagedQty:'破损',rejectedQty:'拒收',batchNo:'批次号',manufactureDate:'生产日期',expiryDate:'到期日期',note:'行备注'}
      return (Object.keys(labels) as Array<keyof typeof labels>).filter(key=>saved[key]!==local[key]).map(key=><tr key={`${line.id}:${key}`}><td>{line.purchaseOrderLine?.productNameSnapshot||line.product?.name||line.id}</td><td>{line.purchaseUnit}</td><td>{labels[key]}</td><td>{saved[key]||'（空）'}</td><td>{local[key]||'（空）'}</td></tr>)
    })}</tbody></table></div>
    {Object.keys(edits).some(id=>!doc.lines.some(line=>line.id===id))&&<p>服务器已移除部分原行；这些行的本页输入保留，但不会随本次单据保存。</p>}
    <button className="mr-3 mt-2 rounded border border-border px-3 py-2" disabled={busy||blocked} onClick={()=>{setComparisonRequired(false);setNotice('已选择保留本页修改，再点保存才会写入')}}>确认保留本页修改</button>
    <button className="mt-2 rounded border border-border px-3 py-2" disabled={busy||blocked} onClick={()=>{setEdits(Object.fromEntries(doc.lines.map(line=>[line.id,fields(line,kind)])));setNote(doc.note||'');setComparisonRequired(false);setNotice('已采用服务器最新内容，未写入单据')}}>使用服务器最新内容</button>
   </section>}
   <div className={sheet.meta}><div>单据编号：{doc.no}</div><div>机构：{doc.organizationName||'—'}</div><div title={`${doc.supplier.no} · ${doc.supplier.name}`}>供应商：{doc.supplier.no} · {doc.supplier.name}</div><div>仓库：{doc.warehouse?.name||'—'}</div><div>日期：{businessDay(doc.arrivedAt||doc.createdAt)}</div><div title={doc.purchaseOrder?.no||doc.lines[0]?.receiptLine?.receipt.no||undefined}>来源：{doc.purchaseOrder?.no||doc.lines[0]?.receiptLine?.receipt.no||'—'}</div>{creating&&kind==='RETURN'&&<label className={sheet.wide}>退货原因<input aria-label="退货原因" maxLength={240} disabled={disabled} className="input ml-3 w-3/4" value={reason} onChange={event=>setReason(event.target.value)}/></label>}<label className={sheet.wide}>备注<input aria-label="单据备注" className="input ml-3 w-3/4" disabled={!canWrite||disabled} value={note} onChange={event=>setNote(event.target.value)}/></label></div>
   {creating&&kind==='RETURN'&&<div className="my-3">{doc.lines.length===0&&<p>{nextCursor?'当前页没有可退数量，请继续加载更早来源。':'所选供应商与仓库暂无可退的已入库商品。'}</p>}{nextCursor&&<button disabled={disabled} onClick={()=>void loadMore()}>加载更多原收货明细</button>}</div>}
   <div className={sheet.toolbar}><strong>商品明细</strong><span>共 {doc.lines.length} 项</span></div>
   {!creating&&<div className="mb-2"><LegacyQualityImagesButton kind={kind} sourceId={sourceId}/></div>}
   <div className={sheet.tableWrap}><table className="w-full whitespace-nowrap text-sm"><thead><tr>{['序号','物品编码','物品名称','规格型号','物品类别','仓库','采购单位',...(kind==='RECEIPT'?['实到','破损','拒收']:creating?['原收货单','可退数量']:[]),'数量','单价','金额','辅助单位','辅助数量',...(kind==='RECEIPT'?['批次号','生产日期','到期日期']:[]),'备注','质检'].map(text=><th key={text} data-column={text==='物品编码'?'code':text==='物品名称'?'name':text==='质检'?'quality':undefined} className="border-b p-2 text-left">{text}</th>)}</tr></thead><tbody>{doc.lines.map((line,index)=>{
     const edit=edits[line.id]||fields(line,kind),cell=(key:keyof Edit,type='text',readonly=false)=><input aria-label={`${index+1}行${key}`} type={type} step={type==='number'?'0.000001':undefined} className="w-28 rounded border p-1" disabled={!editable||disabled||readonly} value={edit[key]} onChange={event=>update(line.id,key,event.target.value)}/>
     return <tr key={line.id} className="border-b"><td className="p-2">{index+1}</td><td data-column="code" className="p-2">{line.purchaseOrderLine?.productCodeSnapshot||line.product?.code}</td><td data-column="name" className="p-2">{line.purchaseOrderLine?.productNameSnapshot||line.product?.name}</td><td className="p-2">{line.purchaseOrderLine?.productSpecSnapshot||line.product?.spec||'—'}</td><td className="p-2">{line.product?.category||'—'}</td><td className="p-2">{doc.warehouse?.name||'—'}</td><td className="p-2">{line.purchaseUnit}</td>{kind==='RECEIPT'&&<><td className="p-2">{cell('arrivedQty','number')}</td><td className="p-2">{cell('damagedQty','number')}</td><td className="p-2">{cell('rejectedQty','number')}</td></>}{creating&&kind==='RETURN'&&<><td className="p-2">{line.receiptLine?.receipt.no}</td><td className="p-2">{line.returnableQuantity}{line.unavailableReason&&<span className="ml-2 text-red-600">{line.unavailableReason}</span>}</td></>}<td className="p-2">{cell('quantity','number')}</td><td className="p-2">{cell('unitPrice','number',kind==='RETURN')}</td><td className="p-2">{kind==='RECEIPT'?cell('amount'):displayAmount(line)}</td><td className="p-2">{line.inventoryUnit}</td><td className="p-2">{procurementDecimalProduct(edit.quantity,String(line.inventoryUnitsPerPurchaseUnit),6)}</td>{kind==='RECEIPT'&&<><td className="p-2">{cell('batchNo')}</td><td className="p-2">{cell('manufactureDate','date')}</td><td className="p-2">{cell('expiryDate','date')}</td></>}<td className="p-2">{cell('note')}</td><td data-column="quality" className="p-2"><DocumentQualityImageButton kind="BATCH" sourceId={kind==='RECEIPT'?`${creating?'S':'R'}:${line.id}`:`R:${creating?line.id:line.receiptLineId}`} /></td></tr>
   })}</tbody><tfoot><tr><td colSpan={kind==='RECEIPT'?10:creating?9:7}>合计</td><td>{displaySum(doc.lines.map(line=>procurementDecimalProduct((edits[line.id]||fields(line,kind)).quantity,'1',6)),6)}</td><td></td><td>{displaySum(doc.lines.map(displayAmount),4)}</td><td colSpan={kind==='RECEIPT'?7:4}></td></tr></tfoot></table></div>
   <footer className={sheet.footer}><button disabled={busy} onClick={()=>close()}>取消</button><button disabled={!canWrite||disabled} onClick={()=>void save()}>保存</button><button disabled={!editable||disabled||(!creating&&dirty)||(doc.approvalStatus||'DRAFT')!=='DRAFT'} onClick={()=>ask('submit')}>提交</button><button disabled={!canAudit||disabled||dirty||doc.approvalStatus!=='PENDING'} onClick={()=>ask('audit')}>审核</button></footer>
 </div>
}
