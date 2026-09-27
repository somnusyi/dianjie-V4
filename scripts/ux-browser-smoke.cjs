// Local, mocked-data UX smoke. Start Next on UX_WEB_URL (default 127.0.0.1:3218).
const { chromium } = require('playwright')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const baseUrl = process.env.UX_WEB_URL || 'http://127.0.0.1:3218'
if (!['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname)) throw new Error('UX smoke only supports local servers')
const out = '.local/ux-logs/browser'
fs.mkdirSync(out, { recursive: true })
const product = { id:'product-1', code:'DJ001', name:'菌菇酱', category:'酱料', spec:'8袋/箱', purchaseUnit:'箱', inventoryUnit:'袋', purchaseToInventoryFactor:8, unitConversionStatus:'VERIFIED', physicalQty:24,reservedQty:4,availableQty:20,inventoryValue:120,averageUnitCost:5,statusFlag:'OK' }
const supplier = { id:'sup-1',no:'SUP001',name:'井育苗菇' }
const inventory = { canEditOrderEntryPolicy:true, warehouse:{ id:'warehouse-1',code:'default',name:'供应链总仓',rowVersion:3,inventoryMode:'SHADOW',blockZeroStockAtOrderEntry:false }, summary:{ inventoryMode:'SHADOW',totalSku:1,physicalSku:1,negativeSku:0,totalValue:120,activeReservations:0,movementCount:0,strictActivated:false },scope:'stock',scopeCounts:{stockSku:1,bomMappingSku:0,unitReviewSku:0},items:[product] }
const doc = {id:'doc-1',docNo:'RK202609280001',type:'MANUAL_INBOUND',status:'POSTED',effectiveAt:'2026-09-28T01:00:00.000Z',createdAt:'2026-09-28T01:00:00.000Z',supplierName:supplier.name,totalAmount:160,lineCount:1,attachmentCount:2,note:'手机验收示例'}
const record = { id:'movement-1',type:'MANUAL_INBOUND',sourceType:'WarehouseManualInbound',sourceId:'r1',effectiveAt:'2026-09-28T01:00:00Z',recordedAt:'2026-09-28T01:00:00Z',product,supplier,sourceName:supplier.name,originalQuantity:2,originalUnit:'箱',inventoryQuantity:16,inventoryUnit:'袋',inventoryUnitCost:10,amount:160,batchNo:'MI-20260928-abcd1234',expiryDate:'2026-10-01',reversed:false,doc }
const stores=[{id:'store-1',no:'S001',name:'昆明店'},{id:'store-2',no:'S002',name:'大理店'}]
const transfer={id:'tr-1',no:'DB202609280001',transferDate:'2026-09-28',fromStore:stores[0],toStore:stores[1],status:'PENDING',items:[{id:'i1',name:'菌菇酱',quantity:2,unit:'袋',cost:5,settlement:6}],note:'手机调拨',createdAt:'2026-09-28T01:00:00Z'}
const count={no:'PD202609280001',countDate:'2026-09-28',status:'CONFIRMED',totalDifferenceValue:-10,store:{name:'供应链总仓'},items:[{id:'line1',productCodeSnapshot:'DJ001',productNameSnapshot:'菌菇酱',productSpecSnapshot:'8袋/箱',unitSnapshot:'袋',bookQuantity:24,countedQuantity:22,differenceQuantity:-2,differenceAmount:-10,reasonCode:'OTHER',reasonNote:'现场称重核对',evidenceKeys:[],evidenceUrls:[]}]}
;(async()=>{
 const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL || 'chrome'})
 const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1})
 await context.addInitScript(()=>{localStorage.setItem('token','test-token');localStorage.setItem('user',JSON.stringify({id:'u1',name:'验收供应链',role:'SUPPLY_CHAIN'}))})
 const failures=[]; const unknown=[]
 await context.route('**/api/**',async route=>{
  const url=new URL(route.request().url()); const p=url.pathname; let data
  if(p==='/api/warehouse-inventory')data=inventory
  else if(p==='/api/warehouse-inventory/inbound-candidates')data={items:[product]}
  else if(p==='/api/warehouse-inventory/movements')data=[]
  else if(p==='/api/warehouse-inventory/audit')data={readyForStrict:true,blockerCount:0,warningCount:0,checkedSku:1,issues:[]}
  else if(p==='/api/warehouse-inventory/purchase-inbound-price-history')data={items:[]}
  else if(p==='/api/warehouse-inventory/inbound-records')data={items:[record],total:1,page:1,pageSize:Number(url.searchParams.get('pageSize')||20),totalAmount:160}
  else if(p==='/api/warehouse-docs')data={items:[doc],total:1,page:1,pageSize:Number(url.searchParams.get('pageSize')||20)}
  else if(p==='/api/suppliers')data=[supplier]
  else if(p==='/api/supplier-aliases/unclaimed')data={items:[]}
  else if(p==='/api/stores')data=stores
  else if(p==='/api/store-transfers')data=[transfer]
  else if(p==='/api/store-transfers/products')data=[product]
  else if(p==='/api/warehouse-stocktakes/count1/review')data=count
  else if(p.includes('annotations'))return route.fulfill({status:404,json:{message:'disabled'}})
  else {unknown.push(p);data={items:[],total:0}}
  await route.fulfill({status:200,json:data})
 })
 const page=await context.newPage();page.on('pageerror',error=>failures.push(error.message))
 async function shot(name){await page.screenshot({path:`${out}/${name}.png`,fullPage:true}); const width=await page.evaluate(()=>({view:innerWidth,scroll:document.documentElement.scrollWidth})); assert.ok(width.scroll<=width.view+1,`${name}: page overflows ${JSON.stringify(width)}`);console.log(name,width)}
 for(const name of ['docs','inbound','inventory','transfers']){
  await page.goto(`${baseUrl}/v2/supply-chain/${name}`,{waitUntil:'networkidle'});await page.locator('[data-mobile-cards]').first().waitFor(); await shot(`mobile-${name}`)
  if(name==='docs'){
   await page.getByRole('button',{name:'打印 / 保存 PDF'}).click();await page.getByRole('dialog',{name:'单据审核'}).waitFor();await shot('mobile-print-preview');await page.getByRole('button',{name:'关闭预览'}).click()
  }
  if(name==='inventory'){
   await page.getByRole('button',{name:'+ 批量入库',exact:true}).click();await page.getByLabel('选择菌菇酱').check();await page.getByRole('button',{name:/添加选中商品/}).click();await page.getByLabel('菌菇酱采购数量').fill('3');await page.getByLabel('菌菇酱采购单价').fill('40');await shot('mobile-batch-inbound');assert.equal(await page.getByLabel('菌菇酱采购数量').count(),1);await page.setViewportSize({width:1440,height:960});assert.equal(await page.getByLabel('菌菇酱采购数量').inputValue(),'3');await shot('desktop-batch-inbound');await page.setViewportSize({width:390,height:844})
  }
  if(name==='transfers'){
   await page.getByRole('button',{name:'发货',exact:true}).click();await page.getByRole('dialog').waitFor();await shot('mobile-transfer-confirm');await page.getByRole('button',{name:'取消',exact:true}).click()
  }
 }
 await page.goto(`${baseUrl}/v2/supply-chain/stocktake/count/count1?source=warehouse`,{waitUntil:'networkidle'});await page.locator('[data-mobile-cards]').waitFor();await shot('mobile-stocktake-review')
 await page.setViewportSize({width:1440,height:960});await page.locator('table').first().waitFor();await shot('desktop-stocktake-review')
 for (const path of ['/payments', '/reconciliations', '/schedules', '/design-system']) { const response = await page.request.get(`${baseUrl}${path}`); assert.equal(response.status(), 404, `${path} must be closed`) }
 fs.writeFileSync(`${out}/results.json`,JSON.stringify({failures,unknown},null,2));assert.deepEqual(failures,[]);await browser.close();console.log('browser smoke passed')
})().catch(error=>{console.error(error);process.exit(1)})
