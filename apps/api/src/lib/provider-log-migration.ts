import { safeProviderCallLog, safeWeComSyncLog } from './provider-log-safety'
const stable=(value:any):any=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value
const equal=(a:any,b:any)=>JSON.stringify(stable(a))===JSON.stringify(stable(b))
const targets=[
 {model:'meituanApiCallLog',table:'meituan_api_call_logs',fields:['requestPublic','requestBiz','signature','responseRaw','responseData','responseMsg','errorMessage','responseCode','traceId','note'],sanitize:safeProviderCallLog},
 {model:'weComSyncLog',table:'wecom_sync_logs',fields:['payload','errorMsg'],sanitize:safeWeComSyncLog},
] as const
/** Both historical integration logs are sanitized atomically. Business source tables are never touched. */
export async function migrateProviderCallLogs(prisma:any,{execute=false}={}) {
 try{
  return await prisma.$transaction(async(tx:any)=>{
   await tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('dianjie-provider-log-sanitization-v1'))::text")
   const summary:any={mode:execute?'execute':'dry-run',rows:0,changedRows:0,rewrittenRows:0,tables:{}}
   for(const target of targets){
    let cursor:string|undefined;const counts={rows:0,changedRows:0,rewrittenRows:0}
    for(;;){
     const batch=await tx[target.model].findMany({take:200,orderBy:{id:'asc'},...(cursor?{cursor:{id:cursor},skip:1}:{})})
     for(const row of batch){
      counts.rows++;const safe=target.sanitize(row),data:any={}
      for(const field of target.fields)if(!equal(row[field],safe[field]))data[field]=safe[field]
      if(!Object.keys(data).length)continue
      counts.changedRows++
      if(execute){
       // Table names come only from the fixed static list above, not caller input.
       await tx.$queryRawUnsafe(`SELECT id FROM ${target.table} WHERE id = $1 FOR UPDATE`,row.id)
       const latest=await tx[target.model].findUnique({where:{id:row.id}})
       if(!latest||target.fields.some(f=>!equal(latest[f],row[f])))throw Error('Concurrent log edit')
       await tx[target.model].update({where:{id:row.id},data});counts.rewrittenRows++
      }
     }
     if(batch.length<200)break
     cursor=batch[batch.length-1].id
    }
    summary.tables[target.model]=counts
    for(const key of ['rows','changedRows','rewrittenRows']as const)summary[key]+=counts[key]
   }
   return summary
  },{timeout:120000,maxWait:10000})
 }catch{throw Object.assign(new Error('历史调用日志脱敏未完成；事务已取消'),{code:'PROVIDER_LOG_MIGRATION_FAILED'})}
}
