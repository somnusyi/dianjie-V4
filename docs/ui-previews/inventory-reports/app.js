/* Standalone review prototype. All data below is synthetic. No API or storage access. */
const $ = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const quantity = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 });
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const col = (key, label, kind = 'text', group = '') => ({ key, label, kind, group });
const itemCols = [col('name', '物品名称 / 编码'), col('spec', '规格型号'), col('category', '物品类别')];
const reports = [
  { id:'realtime', title:'实时库存查询表', description:'查看各机构、仓库的现有库存，以及预计入库与预计出库。', note:'库存量按所示单位展示', columns:[...itemCols,col('unit','单位'),col('conversion','单位换算'),col('org','机构名称'),col('warehouse','仓库'),col('qty','库存量','qty'),col('amount','库存金额','money'),col('price','均价','price'),col('expectedIn','预计入库','qty'),col('expectedOut','预计出库','qty')] },
  { id:'movements', title:'出入库明细表', description:'逐物品查看出入库记录，追溯上游单据及往来机构。', note:'金额采用不含税口径', columns:[...itemCols,col('unit','单位'),col('org','机构名称'),col('warehouse','仓库'),col('doc','出入库单据号'),col('type','出入库类型'),col('upstream','上游单据号'),col('upstreamType','上游单据类型'),col('reason','原因类型'),col('adjustment','调整单标识'),col('counterparty','对方机构'),col('upstreamDate','上游单据日期'),col('date','出入库日期'),col('inQty','数量','qty','入库'),col('inPrice','单价（不含税）','price','入库'),col('inAmount','金额（不含税）','money','入库'),col('outQty','数量','qty','出库'),col('outPrice','单价（不含税）','price','出库'),col('outAmount','金额（不含税）','money','出库')] },
  { id:'summary', title:'出入库汇总表', description:'按物品汇总所选期间的期初、入库、出库及期末结余。', note:'期末 = 期初 + 入库 − 出库', columns:[...itemCols,col('unit','单位'),col('org','机构名称'),col('warehouse','仓库'),col('type','出入库类型'),col('openingQty','数量','qty','期初'),col('openingAmount','金额','money','期初'),col('inQty','数量','qty','入库'),col('inAmount','金额','money','入库'),col('outQty','数量','qty','出库'),col('outAmount','金额','money','出库'),col('closingQty','数量','qty','期末结余'),col('closingAmount','金额','money','期末结余')] },
  { id:'transfer-detail', title:'机构间调拨明细表', description:'逐单、逐物品核对机构间调拨，分别展示调出成本与调入结算。', note:'调出金额、调入金额分别展示', columns:[...itemCols,col('unit','单位'),col('doc','调拨单号'),col('date','调拨日期'),col('org','调出机构'),col('warehouse','调出仓库'),col('target','调入机构'),col('targetWarehouse','调入仓库'),col('cost','调出成本单价','price'),col('settlement','结算单价','price'),col('transferQty','调拨数量','qty'),col('outAmount','调出金额','money'),col('inAmount','调入金额','money')] },
  { id:'transfer-summary', title:'机构间调拨汇总表', description:'按物品及调出、调入机构汇总调拨数量与金额，保留独立汇总视图。', note:'单价按汇总数量加权展示', columns:[...itemCols,col('unit','单位'),col('org','调出机构'),col('warehouse','调出仓库'),col('target','调入机构'),col('targetWarehouse','调入仓库'),col('cost','调出成本单价','price'),col('settlement','结算单价','price'),col('transferQty','调拨数量','qty'),col('outAmount','调出金额','money'),col('inAmount','调入金额','money')] },
];
const names = ['鲜羊肚菌','人工见手青','云南小土豆','鲜鸡枞菌','鲜竹荪','鲜绣球菌','云南豆腐皮','鲜牛肝菌','黑虎掌菌','豌豆尖','金耳菌','云南饵块','青笋尖','鲜香菇','红葱菌','鲜牛肉片','菌汤底料','昭通酱','蘸水辣椒','山泉水','云南腐竹','茉莉花','鲜老人头菌','甜脆玉米','鲜银耳','土鸡','鲜松茸','腊肉','野生木耳','黑豆花'];
const round = n => Math.round(n * 100) / 100;
const products = names.map((name,i) => {
  const unit = i === 16 || i === 17 ? '包' : i === 19 ? '瓶' : 'kg';
  const price = [105,60,8.5,78,32,28,18,56,92,12][i%10];
  const openingQty = 30 + i * 7;
  return {name,code:`DJ${String(i+1).padStart(5,'0')}`,spec:unit==='kg'?'5kg/箱':unit==='包'?'500g/包':'1.5L/瓶',category:i<15?'菌菇鲜蔬':i<20?'调味与酒水':'食材原料',unit,conversion:unit==='kg'?'1 箱 = 5 kg':unit==='包'?'1 箱 = 20 包':'1 箱 = 12 瓶',org:i%6===5?'示例门店':'总部',warehouse:i%6===5?'门店仓':'供应链总仓',price,openingQty,openingAmount:round(openingQty*price),expectedIn:i%3===0?20:0,expectedOut:i%4===0?10:0};
});
const movements = products.flatMap((p,i) => [0,1].map(side => {
  const n = side===0 ? 15+i%8 : 3+i%5;
  const date = `2026-09-${String(14+i%7+side).padStart(2,'0')}`;
  return {...p,date,doc:`${side?'CK':'RK'}202609${String(i*2+side+1).padStart(5,'0')}`,type:side?'配送出库':'采购入库',upstream:`${side?'PO':'UPO'}202609${String(i+1).padStart(5,'0')}`,upstreamType:side?'门店订货单':'上游采购单',reason:side?'门店配送':'采购收货',adjustment:'否',counterparty:side?'示例门店':'示例食材供应商',upstreamDate:'2026-09-13',inQty:side?0:n,outQty:side?n:0,inPrice:side?null:p.price,outPrice:side?p.price:null,inAmount:side?0:round(n*p.price),outAmount:side?round(n*p.price):0};
}));
const stock = products.map(p => {const rows=movements.filter(r=>r.code===p.code);const qty=p.openingQty+rows.reduce((s,r)=>s+r.inQty-r.outQty,0);return {...p,qty,amount:round(qty*p.price)};});
const transfers = products.slice(0,16).flatMap((p,i)=>[0,1].map(n=>({...p,org:'总部',warehouse:'供应链总仓',target:i%2?'示例门店 B':'示例门店 A',targetWarehouse:'门店仓',doc:`DB202609${String(i*2+n+1).padStart(5,'0')}`,date:`2026-09-${18+n}`,cost:p.price,settlement:round(p.price*1.1),transferQty:4+n,outAmount:round((4+n)*p.price),inAmount:round((4+n)*round(p.price*1.1))})));
let current = reports[0], opened = [], filters = {}, rows = [], page=1, pageSize=20, sortKey='', sortDirection=1;
const hiddenColumns = new Map(reports.map(r=>[r.id,new Set()]));
const number = (value,kind) => value==null?'—':kind==='money'||kind==='price'?money.format(value):quantity.format(value);
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,2600);}

// A small delay bridges normal pointer travel between the trigger and flyout.
let closeTimer;
function openMenu(){clearTimeout(closeTimer);const menu=$('#report-menu');menu.hidden=false;const rect=$('#report-trigger').getBoundingClientRect();menu.style.top=`${Math.max(12,Math.min(rect.top,innerHeight-menu.offsetHeight-16))}px`;$('#report-trigger').setAttribute('aria-expanded','true');}
function closeMenu(){clearTimeout(closeTimer);$('#report-menu').hidden=true;$('#report-trigger').setAttribute('aria-expanded','false');}
function scheduleClose(){closeTimer=setTimeout(closeMenu,150);}
for(const element of [$('#report-trigger'),$('#report-menu')]){element.addEventListener('mouseenter',openMenu);element.addEventListener('mouseleave',scheduleClose);element.addEventListener('focusin',openMenu);element.addEventListener('focusout',e=>{if(!$('#report-menu').contains(e.relatedTarget)&&e.relatedTarget!==$('#report-trigger'))scheduleClose();});}
$('#report-trigger').onclick=openMenu;
$('#mobile-menu').onclick=openMenu;
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeMenu();document.body.classList.remove('focused');$('#fullscreen').textContent='⛶ 专注表格';}});
document.addEventListener('pointerdown',e=>{if(!$('#report-menu').contains(e.target)&&!e.target.closest('#report-trigger,#mobile-menu'))closeMenu();});
$('#report-links').innerHTML=reports.map(r=>`<a href="#${r.id}" data-report="${r.id}">${r.title}</a>`).join('');
$('#report-links').addEventListener('click',e=>{if(e.target.closest('a'))closeMenu();});
function renderTabs(){
  $('#workspace-tabs').innerHTML=opened.map(id=>{const r=reports.find(x=>x.id===id);return `<div class="workspace-tab ${id===current?.id?'active':''}"><a href="#${id}" ${id===current?.id?'aria-current="page"':''}>${r.title}</a><button class="tab-close" data-close-report="${id}" aria-label="关闭${r.title}" title="关闭${r.title}">×</button></div>`;}).join('');
  document.querySelectorAll('[data-report]').forEach(a=>a.classList.toggle('active',a.dataset.report===current?.id));
}
$('#workspace-tabs').addEventListener('click',e=>{
  const button=e.target.closest('[data-close-report]');
  if(!button)return;
  const id=button.dataset.closeReport;
  const index=opened.indexOf(id);
  if(index<0)return;
  opened.splice(index,1);
  if(current?.id===id){
    location.hash=opened[index]||opened[index-1]||'reports';
  }else{
    renderTabs();
  }
});
$('#open-report').onclick=openMenu;
const selectField=(key,label,options,value='')=>`<label>${label}<select name="${key}">${options.map(v=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(v||'全部')}</option>`).join('')}</select></label>`;
const textField=(key,label,placeholder)=>`<label>${label}<input name="${key}" placeholder="${placeholder}"></label>`;
const rangeField=(key,label)=>`<label>${label}<span class="number-range"><input aria-label="${label}最小值" type="number" step="any" name="${key}Min" placeholder="最小值"><span>—</span><input aria-label="${label}最大值" type="number" step="any" name="${key}Max" placeholder="最大值"></span></label>`;
function renderFilters(){
  const transfer=current.id.startsWith('transfer');
  let primary=selectField('org',transfer?'调出机构':'机构名称',['','总部','示例门店'],'总部')+selectField('warehouse',transfer?'调出仓库':'仓库',['','供应链总仓','门店仓'],'供应链总仓')+textField('keyword','物品搜索','输入物品名称 / 编码')+selectField('category','物品类别',['','菌菇鲜蔬','调味与酒水','食材原料']);
  if(current.id!=='realtime') primary+=`<label class="wide">${transfer?'调拨日期':'出入库日期'}<span class="date-range"><input aria-label="开始日期" name="start" type="date" value="2026-09-01"><span>至</span><input aria-label="结束日期" name="end" type="date" value="2026-09-21"></span></label>`;
  if(transfer) primary+=selectField('target','调入机构',['','示例门店 A','示例门店 B']);
  if(current.id==='movements'||current.id==='summary')primary+=selectField('type','出入库类型',['','采购入库','配送出库']);
  if(current.id==='movements'||current.id==='transfer-detail')primary+=textField('doc','单据号','输入单据号');
  let advanced=selectField('unit','单位',['','kg','包','瓶']);
  if(current.id==='realtime') advanced+=textField('conversion','单位换算','例如：1 箱 = 5 kg')+['qty:库存量','amount:库存金额','price:均价','expectedIn:预计入库','expectedOut:预计出库'].map(v=>rangeField(...v.split(':'))).join('');
  if(current.id==='movements')advanced+=textField('upstream','上游单据号','输入上游单据号')+selectField('upstreamType','上游单据类型',['','上游采购单','门店订货单'])+selectField('counterparty','对方机构',['','示例食材供应商','示例门店'])+selectField('reason','原因类型',['','采购收货','门店配送'])+selectField('adjustment','调整单标识',['','是','否']);
  if(transfer)advanced+=selectField('targetWarehouse','调入仓库',['','门店仓'])+rangeField('transferQty','调拨数量');
  $('#filters').innerHTML=primary;$('#advanced-filters').innerHTML=advanced;$('#advanced-filters').hidden=true;$('#advanced-toggle').setAttribute('aria-expanded','false');$('#advanced-toggle').textContent='更多筛选 ⌄';
}
function matches(row, options = {}){
  for(const [k,v] of Object.entries(filters)){
    if(!v)continue;
    if(options.ignoreTransferQuantity && (k==='transferQtyMin'||k==='transferQtyMax'))continue;
    if(k==='start'||k==='end'){if(row.date&&(k==='start'?row.date<v:row.date>v))return false;continue;}
    if(k==='keyword'){if(!`${row.name} ${row.code}`.toLowerCase().includes(v.toLowerCase()))return false;continue;}
    if(k.endsWith('Min')||k.endsWith('Max')){const value=Number(row[k.slice(0,-3)]);if(k.endsWith('Min')?value<Number(v):value>Number(v))return false;continue;}
    if(['doc','upstream','conversion'].includes(k)){if(!String(row[k]??'').includes(v))return false;continue;}
    if(row[k]!==v)return false;
  }return true;
}
function sourceRows(){
  if(current.id==='realtime')return stock;
  if(current.id==='movements')return movements;
  if(current.id==='transfer-detail')return transfers;
  if(current.id==='transfer-summary'){
    const grouped=new Map();
    for(const r of transfers.filter(r=>matches(r,{ignoreTransferQuantity:true}))){const key=`${r.code}/${r.org}/${r.target}`;let a=grouped.get(key);if(!a){a={...r,transferQty:0,outAmount:0,inAmount:0};delete a.date;grouped.set(key,a);}a.transferQty+=r.transferQty;a.outAmount+=r.outAmount;a.inAmount+=r.inAmount;}
    return [...grouped.values()].map(r=>({...r,cost:r.outAmount/r.transferQty,settlement:r.inAmount/r.transferQty}));
  }
  return products.map(p=>{
    const ledger=movements.filter(r=>r.code===p.code);
    const before=ledger.filter(r=>filters.start&&r.date<filters.start);
    const period=ledger.filter(r=>(!filters.start||r.date>=filters.start)&&(!filters.end||r.date<=filters.end)&&(!filters.type||r.type===filters.type));
    const sum=k=>period.reduce((s,r)=>s+r[k],0);
    const openingQty=p.openingQty+before.reduce((s,r)=>s+r.inQty-r.outQty,0);
    const inQty=sum('inQty'),outQty=sum('outQty');
    return {...p,type:filters.type||'全部类型',openingQty,openingAmount:round(openingQty*p.price),inQty,inAmount:sum('inAmount'),outQty,outAmount:sum('outAmount'),closingQty:openingQty+inQty-outQty,closingAmount:round((openingQty+inQty-outQty)*p.price)};
  });
}
function query(){
  filters=Object.fromEntries(new FormData($('#query-form')));
  if(filters.start&&filters.end&&filters.start>filters.end){toast('开始日期不能晚于结束日期');return;}
  for(const k of Object.keys(filters).filter(k=>k.endsWith('Min'))){const max=filters[k.slice(0,-3)+'Max'];if(filters[k]!==''&&max!==''&&Number(filters[k])>Number(max)){toast('最小值不能大于最大值');return;}}
  rows=sourceRows().filter(matches);page=1;renderTable();$('#query-hint').textContent='已按当前条件查询 · 示例数据';
}
function visibleColumns(){return current.columns.filter(c=>!hiddenColumns.get(current.id).has(c.key));}
function renderTable(){
  const columns=visibleColumns();
  const grouped=columns.some(c=>c.group);
  let head='';
  const cellHeader=c=>`<th class="${c.key==='name'?'frozen ':''}${c.kind!=='text'?'numeric':''}" aria-sort="${sortKey===c.key?(sortDirection===1?'ascending':'descending'):'none'}"><button data-sort="${c.key}">${c.label}<span class="sort-mark">${sortKey===c.key?(sortDirection===1?'↑':'↓'):'↕'}</span></button></th>`;
  if(grouped){let groups=[];for(const c of columns){const name=c.group||'物品与单据信息';const last=groups.at(-1);if(last&&last.name===name)last.count++;else groups.push({name,count:1});}head=`<tr class="group-header">${groups.map(g=>`<th colspan="${g.count}">${g.name}</th>`).join('')}</tr>`;}
  head+=`<tr>${columns.map(cellHeader).join('')}</tr>`;
  const sorted=[...rows].sort((a,b)=>{if(!sortKey)return 0;return sortDirection*(typeof a[sortKey]==='number'?a[sortKey]-b[sortKey]:String(a[sortKey]??'').localeCompare(String(b[sortKey]??''),'zh-CN'));});
  const pageRows=sorted.slice((page-1)*pageSize,page*pageSize);
  let body=pageRows.map(r=>`<tr>${columns.map(c=>`<td class="${c.key==='name'?'frozen ':''}${c.kind!=='text'?'numeric':''}">${c.key==='name'?`<span class="item-name">${esc(r.name)}</span><span class="item-code">${r.code}</span>`:c.kind==='text'?esc(r[c.key]):number(r[c.key],c.kind)}</td>`).join('')}</tr>`).join('');
  if(!rows.length)body=`<tr><td class="empty" colspan="${columns.length}">没有符合条件的示例记录，请调整筛选条件或重置。</td></tr>`;
  let totals='';if(rows.length)totals=`<tfoot><tr class="summary-row">${columns.map((c,i)=>`<td class="${i===0?'frozen ':''}${c.kind!=='text'?'numeric':''}">${i===0?'合计<small>当前筛选的全部记录</small>':c.kind==='money'?number(rows.reduce((s,r)=>s+(r[c.key]||0),0),'money'):c.kind==='qty'&&new Set(rows.map(r=>r.unit)).size===1?number(rows.reduce((s,r)=>s+(r[c.key]||0),0),'qty'):'—'}</td>`).join('')}</tr></tfoot>`;
  $('#report-table').className=grouped?'grouped':'';$('#report-table').innerHTML=`<thead>${head}</thead><tbody>${body}</tbody>${totals}`;
  $('#count').textContent=`共 ${rows.length} 条`;
  $('#result-note').textContent=current.note;
  const pages=Math.max(1,Math.ceil(rows.length/pageSize));
  $('#page-summary').textContent=rows.length?`第 ${(page-1)*pageSize+1}–${Math.min(page*pageSize,rows.length)} 条，共 ${rows.length} 条记录`:'共 0 条记录';
  $('#page-index').textContent=`${page} / ${pages}`;$('#prev').disabled=page<=1;$('#next').disabled=page>=pages;
  document.querySelectorAll('[data-sort]').forEach(b=>b.onclick=()=>{sortDirection=sortKey===b.dataset.sort?-sortDirection:1;sortKey=b.dataset.sort;renderTable();});
}
function navigate(){
  const id=location.hash.slice(1);
  const empty=id==='reports';
  $('.workspace').hidden=empty;
  $('#empty-workspace').hidden=!empty;
  if(empty){current=null;document.title='库存报表 · 滇界 UI 预览';renderTabs();closeMenu();return;}
  current=reports.find(r=>r.id===id)||reports[0];
  if(!opened.includes(current.id))opened.push(current.id);
  $('#report-title').textContent=current.title;$('#report-description').textContent=current.description;document.title=`${current.title} · 滇界 UI 预览`;sortKey='';renderTabs();renderFilters();query();closeMenu();$('.table-scroll').scrollTo(0,0);
}
window.addEventListener('hashchange',navigate);
$('#query-form').onsubmit=e=>{e.preventDefault();query();};
$('#reset').onclick=()=>{renderFilters();query();};
$('#advanced-toggle').onclick=()=>{const section=$('#advanced-filters');section.hidden=!section.hidden;$('#advanced-toggle').setAttribute('aria-expanded',String(!section.hidden));$('#advanced-toggle').textContent=section.hidden?'更多筛选 ⌄':'收起筛选 ⌃';};
$('#prev').onclick=()=>{page--;renderTable();$('.table-scroll').scrollTop=0;};$('#next').onclick=()=>{page++;renderTable();$('.table-scroll').scrollTop=0;};$('#page-size').onchange=e=>{pageSize=Number(e.target.value);page=1;renderTable();};
$('#density').onclick=()=>{document.body.classList.toggle('compact');$('#density').textContent=document.body.classList.contains('compact')?'标准行高':'紧凑行高';};
$('#fullscreen').onclick=()=>{document.body.classList.toggle('focused');$('#fullscreen').textContent=document.body.classList.contains('focused')?'⛶ 退出专注':'⛶ 专注表格';closeMenu();};
function renderColumnOptions(){const hidden=hiddenColumns.get(current.id);$('#column-options').innerHTML=current.columns.map(c=>`<label><input type="checkbox" data-column="${c.key}" ${hidden.has(c.key)?'':'checked'} ${c.key==='name'?'disabled':''}> ${c.group?c.group+' · ':''}${c.label}</label>`).join('');document.querySelectorAll('[data-column]').forEach(box=>box.onchange=()=>{box.checked?hidden.delete(box.dataset.column):hidden.add(box.dataset.column);renderTable();});}
$('#columns').onclick=()=>{renderColumnOptions();$('#column-dialog').showModal();};$('#close-columns').onclick=$('#done-columns').onclick=()=>$('#column-dialog').close();$('#all-columns').onclick=()=>{hiddenColumns.get(current.id).clear();renderColumnOptions();renderTable();};
$('#export').onclick=()=>{
  const columns=visibleColumns();
  const csvCell=v=>`"${String(v??'').replace(/"/g,'""')}"`;
  const lines=[['数据说明','UI 预览示例数据，非业务记录'],['查询条件',JSON.stringify(filters)],['物品编码',...columns.map(c=>(c.group?c.group+' · ':'')+c.label)],...rows.map(r=>[r.code,...columns.map(c=>r[c.key]??'')])];
  const blob=new Blob(['\ufeff'+lines.map(r=>r.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8;'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`${current.title}-示例预览.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast(`已导出 ${rows.length} 条示例记录（当前筛选与显示列）`);
};
navigate();
