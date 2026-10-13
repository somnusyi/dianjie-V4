import {Prisma} from '@dianjie/db'
import {z} from 'zod'
import {resolveTenantWarehouseId} from './defaultWarehouse'
import {resolveProductFourUnits} from './inventoryUnits'
const unitSchema=z.object({purchaseUnit:z.string(),inventoryUnit:z.string(),orderUnit:z.string(),costUnit:z.string(),inventoryUnitsPerPurchaseUnit:z.number(),inventoryUnitsPerOrderUnit:z.number(),inventoryUnitsPerCostUnit:z.number(),status:z.enum(['PENDING','INFERRED','VERIFIED']),structured:z.object({purchase:z.boolean(),order:z.boolean(),cost:z.boolean()})}).strict()
export const warehouseDraftSnapshotSchema=z.object({version:z.literal(1),warehouse:z.object({id:z.string(),code:z.string(),name:z.string(),inventoryMode:z.string()}).strict(),products:z.array(z.object({id:z.string(),code:z.string().nullable(),name:z.string().nullable(),spec:z.string().nullable(),category:z.string().nullable(),enabled:z.boolean(),displayMatched:z.boolean().default(true),units:unitSchema.nullable()}).strict()).max(200)}).strict()
export type WarehouseDraftSnapshot=z.infer<typeof warehouseDraftSnapshotSchema>
const fail=(message:string)=>Object.assign(new Error(message),{statusCode:409})
export async function captureWarehouseDraftSnapshot(tx:Prisma.TransactionClient,tenantId:string,warehouseId:string|undefined,ids:string[]){
 const resolved=await resolveTenantWarehouseId(tx,tenantId,warehouseId)
 await tx.$queryRaw`SELECT id FROM warehouses WHERE id=${resolved} AND "tenantId"=${tenantId} FOR UPDATE`
 const warehouse=await tx.warehouse.findFirst({where:{id:resolved,tenantId,isActive:true},select:{id:true,code:true,name:true,inventoryMode:true}})
 if(!warehouse)throw fail('草稿仓库已停用或不存在，请重新核对')
 const sorted=[...new Set(ids.filter(Boolean))].sort()
 if(sorted.length)await tx.$queryRaw(Prisma.sql`SELECT id FROM products WHERE "tenantId"=${tenantId} AND id IN (${Prisma.join(sorted)}) ORDER BY id FOR UPDATE`)
 const products=await tx.product.findMany({where:{tenantId,id:{in:sorted}}})
 return warehouseDraftSnapshotSchema.parse({version:1,warehouse,products:sorted.map(id=>{
   const product=products.find(row=>row.id===id)
   if(!product)return{id,code:null,name:null,spec:null,category:null,enabled:false,units:null}
   const contract=resolveProductFourUnits(product)
   const {legacyUnit,...units}=contract
   return{id,code:product.code,name:product.name,spec:product.spec,category:product.category,enabled:product.status==='ENABLED',units:contract.status==='VERIFIED'?units:null}
 })})
}
export async function assertWarehouseDraftSnapshot(tx:Prisma.TransactionClient,tenantId:string,snapshot:WarehouseDraftSnapshot|undefined,ids:string[],outbound:boolean){
 if(!snapshot)throw fail('旧草稿尚未核对仓库和单位，请先重新核对，再提交')
 const current=await captureWarehouseDraftSnapshot(tx,tenantId,snapshot.warehouse.id,ids)
 if(current.warehouse.inventoryMode!==snapshot.warehouse.inventoryMode)throw fail('仓库库存模式已变化，请重新核对草稿')
 for(const id of new Set(ids)){
   const saved=snapshot.products.find(row=>row.id===id),live=current.products.find(row=>row.id===id)
   if(!saved?.displayMatched||!saved?.units||!live?.units||!live.enabled||saved.enabled!==live.enabled||saved.units.status!=='VERIFIED'||live.units.status!=='VERIFIED'||(!outbound&&!live.units.structured.purchase))throw fail('草稿包含不存在、停用或单位待核验商品，请重新核对')
   if(JSON.stringify(saved.units)!==JSON.stringify(live.units))throw fail(`${saved.name||id}的单位或换算已变化，请重新核对草稿，不会按新换算直接入账`)
 }
 return current
}
