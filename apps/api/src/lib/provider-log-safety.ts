const PRIVATE = /^(?:authorization|cookie|set-cookie|password|passwordHash|token|refreshToken|accessToken|appAuthToken|app_auth_token|access_token|refresh_token|secret|appSecret|contactSecret|corpsecret|client_secret|encodingAESKey|callbackToken|signature|sign|apiKey|api_key)$/i
const FREE_TEXT = /^(?:msg|message|errmsg|errorMessage|error_description)$/i
/** Known secrets stay only in this synchronous call's memory, never returned or logged. */
export function redactProviderPayload(value: unknown, secrets: string[] = [], depth = 0): any {
  if (depth > 30) return '[REDACTED]'
  if (typeof value === 'string') {
    let text = value
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]')
    if (/^[\s]*[\[{]/.test(text)) {
      try { return JSON.stringify(redactProviderPayload(JSON.parse(text), secrets, depth + 1)) } catch {}
    }
    return text.replace(/(Bearer\s+)[^\s,;"']+/gi,'$1[REDACTED]').replace(/((?:access_token|refresh_token|token|secret|password|corpsecret|appAuthToken|sign)\s*[=:]\s*)[^&\s"']+/gi,'$1[REDACTED]')
  }
  if (Array.isArray(value)) return value.map(v => redactProviderPayload(v,secrets,depth+1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,PRIVATE.test(key)||FREE_TEXT.test(key)?'[REDACTED]':redactProviderPayload(v,secrets,depth+1)]))
  return value
}
/** Invalid/free-form responses are not needed for business replay and cannot be safely retained. */
export function redactProviderRaw(raw: unknown, secrets: string[] = []): string | null {
  if (raw == null) return null
  try { return JSON.stringify(redactProviderPayload(typeof raw==='string'?JSON.parse(raw):raw,secrets)) }
  catch { return '[Provider response withheld]' }
}
export function collectProviderSecrets(value: any): string[] {
 const result:string[]=[]
 const scan=(v:any,depth=0)=>{if(depth>30||!v||typeof v!=='object')return;for(const [key,item]of Object.entries(v)){if(PRIVATE.test(key)&&typeof item==='string'&&item!=='[REDACTED]')result.push(item);else if(typeof item==='object')scan(item,depth+1)}}
 scan(value);return result
}
/** Read guard also protects exports of records written before the sanitizer existed. */
export function safeProviderCallLog(row: any) {
 const secrets=collectProviderSecrets(row.requestPublic)
 if(row.signature)secrets.push(row.signature)
 return {...row,
  ...(row.note!==undefined?{note:redactProviderPayload(row.note,secrets)}:{}),
  ...(row.responseCode!==undefined?{responseCode:row.responseCode==null?null:/^OP_[A-Z0-9_]{1,70}$/.test(row.responseCode)?redactProviderPayload(row.responseCode,secrets):'UNKNOWN'}:{}),
  ...(row.traceId!==undefined?{traceId:redactProviderPayload(row.traceId,secrets)}:{}),
  ...(row.requestPublic!==undefined?{requestPublic:redactProviderPayload(row.requestPublic,secrets)}:{}),
  ...(row.requestBiz!==undefined?{requestBiz:redactProviderPayload(row.requestBiz,secrets)}:{}),
  ...(row.signature!==undefined?{signature:row.signature?'[REDACTED]':row.signature}:{}),
  ...(row.responseRaw!==undefined?{responseRaw:redactProviderRaw(row.responseRaw,secrets)}:{}),
  ...(row.responseData!==undefined?{responseData:redactProviderPayload(row.responseData,secrets)}:{}),
  ...(row.responseMsg!==undefined?{responseMsg:row.responseMsg?'Provider message withheld':row.responseMsg}:{}),
  ...(row.errorMessage!==undefined?{errorMessage:row.errorMessage?'Provider error details withheld':row.errorMessage}:{}),
 }
}
/** Integration audit rows retain routing/counts, not free text, provider payloads or personal profiles. */
export function safeWeComSyncLog(row:any) {
 const payload:any=row.payload
 let safe:any=null
 if(payload&&typeof payload==='object'&&!Array.isArray(payload)){
  safe={}
  if(row.kind==='send_msg'){
   const count=Number.isInteger(payload.recipientCount)?payload.recipientCount:Array.isArray(payload.toUser)?payload.toUser.length:typeof payload.toUser==='string'?payload.toUser.split('|').filter(Boolean).length:0
   safe.recipientCount=Math.max(0,count)
   const code=payload.response?.errcode??payload.resp?.errcode
   safe.response={errcode:Number.isInteger(code)?code:-1}
  }else{
   for(const key of ['created','updated','skipped','matched','unmatched','departmentCount','userCount','deptCount'])if(Number.isInteger(payload[key])&&payload[key]>=0)safe[key]=payload[key]
   if(row.kind==='oauth_login'&&typeof payload.userId==='string')safe.userId=payload.userId
  }
 }
 return {...row,payload:safe,errorMsg:row.errorMsg?'Integration error details withheld':row.errorMsg}
}
