import {expect,it} from 'vitest'
import {safeErrorLog,safeTelemetryEvent,safeUrl} from '../../src/lib/safe-request-log'
it('does not serialize raw errors, stack messages, driver config or unknown extra fields',()=>{
 const secret='synthetic-private-credential';const error={name:secret,message:secret,stack:secret,config:{password:secret},code:'P2002',statusCode:500}
 expect(JSON.stringify(safeErrorLog(error))).not.toContain(secret)
 const event=safeTelemetryEvent({event_id:'id',timestamp:123,exception:{values:[{type:secret,value:secret,stacktrace:{frames:[{vars:{secret}}]}}]},request:{url:'/api/auth?token='+secret,headers:{authorization:secret},data:secret},extra:{url:secret},breadcrumbs:[{message:secret}],user:{secret},tags:{secret}})
 expect(JSON.stringify(event)).not.toContain(secret);expect(event.request.url).toBe('/api/auth')
})
it('scrubs all query and invitation/download path secrets',()=>{
 expect(safeUrl('/api/invite-accept/synthetic-private-credential/accept?token=hidden')).toBe('/api/invite-accept/[REDACTED]/accept')
 expect(safeUrl('/api/cmb/receipt/synthetic-private-credential')).toBe('/api/cmb/receipt/[REDACTED]')
})
