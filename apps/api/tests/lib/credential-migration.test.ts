import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { migrateCredentials } from '../../src/lib/credential-migration'
import { credentialContext, openCredential, sealCredential } from '../../src/lib/credential-vault'
let records: Record<string, any[]>
beforeEach(() => {
 vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS', JSON.stringify({current:'test',keys:{test:'ab'.repeat(32)}}))
 vi.stubEnv('CREDENTIAL_LEGACY_READ_ALLOWED','false')
 records={weComConfig:[{id:'w',tenantId:'t',appSecret:'synthetic-app-secret'}],meituanAuthToken:[{id:'m',orgId:7,appAuthToken:'synthetic-provider-token'}],store:[{id:'s',tenantId:'t',aggregatorApiKeyEnc:'synthetic-payment-key'}]}
})
afterEach(()=>vi.unstubAllEnvs())
function fakeDb(fail=false) {
 return {$transaction:async(fn:any)=>{
  const copy=structuredClone(records),tx:any={$queryRawUnsafe:vi.fn()}
  for(const model of Object.keys(copy))tx[model]={findMany:async()=>copy[model],updateMany:async({where,data}:any)=>{
   if(fail&&model==='store')return {count:0}
   const row=copy[model].find(r=>Object.entries(where).every(([k,v])=>r[k]===v));if(!row)return{count:0};Object.assign(row,data);return{count:1}
  }}
  const result=await fn(tx);records=copy;return result
 }}
}
it('dry run exposes counts only and never rewrites plaintext',async()=>{
 const before=JSON.stringify(records),result=await migrateCredentials(fakeDb())
 expect(JSON.stringify(records)).toBe(before);expect(result.mode).toBe('dry-run');expect(result.summary.weComConfig.legacyFields).toBe(1);expect(JSON.stringify(result)).not.toContain('synthetic')
})
it('converts each owner context, preserves metadata and is idempotent',async()=>{
 await migrateCredentials(fakeDb(),{execute:true})
 expect(openCredential(records.weComConfig[0].appSecret,credentialContext('t','wecom','appSecret'))).toBe('synthetic-app-secret')
 expect(openCredential(records.store[0].aggregatorApiKeyEnc,credentialContext('t:s','store-payment','aggregatorApiKey'))).toBe('synthetic-payment-key')
 const before=JSON.stringify(records),result=await migrateCredentials(fakeDb(),{execute:true});expect(JSON.stringify(records)).toBe(before);expect(result.summary.weComConfig.changedRows).toBe(0)
})
it('rolls back earlier tables if a concurrent edit prevents one update',async()=>{
 const before=JSON.stringify(records);await expect(migrateCredentials(fakeDb(true),{execute:true})).rejects.toThrow('凭据转换未完成');expect(JSON.stringify(records)).toBe(before)
})
it('rejects bad or cross-owner ciphertext without double encryption or leakage',async()=>{
 records.weComConfig[0].appSecret=sealCredential('synthetic-app-secret',credentialContext('other','wecom','appSecret'))
 const before=JSON.stringify(records);await expect(migrateCredentials(fakeDb(),{execute:true})).rejects.toThrow('凭据转换未完成');expect(JSON.stringify(records)).toBe(before)
})
it('refuses missing keys before reading records',async()=>{
 vi.stubEnv('CREDENTIAL_ENCRYPTION_KEYS','');const tx=vi.fn();await expect(migrateCredentials({$transaction:tx})).rejects.toThrow('凭据转换未完成');expect(tx).not.toHaveBeenCalled()
})
