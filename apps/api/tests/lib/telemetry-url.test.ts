import{expect,it}from'vitest'
import{safeUrl,safeTelemetryEvent}from'../../src/lib/safe-request-log'
it('strips absolute-URL credentials and secret query before telemetry',()=>{
 const value='https://synthetic-user:synthetic-password@host.example/path?token=synthetic-token'
 expect(safeUrl(value)).toBe('https://host.example/path')
 expect(safeUrl('postgresql://user:synthetic-password@db/private')).toBe('[REDACTED-URL]')
 const event=safeTelemetryEvent({request:{url:value,headers:{Cookie:'synthetic-password'}},breadcrumbs:[{message:'synthetic-token'}],exception:{values:[{value:'synthetic-password'}]},contexts:{trace:{data:{token:'synthetic-token'}}}})
 expect(JSON.stringify(event)).not.toContain('synthetic-')
})
