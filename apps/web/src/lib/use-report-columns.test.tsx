// @vitest-environment jsdom
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {expect,it,vi} from 'vitest'
import {useReportColumns} from './use-report-columns'
const identity=vi.hoisted(()=>({user:{id:'one',tenantId:'tenant'}}))
vi.mock('./v2-auth',()=>({getUser:()=>identity.user}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
function Demo({report='realtime'}:{report?:string}){const [hidden,setHidden]=useReportColumns('inventory',report);return <><span>{hidden.join(',')||'全部显示'}</span><button onClick={()=>setHidden(['orgCode'])}>隐藏</button><button onClick={()=>setHidden([])}>恢复全部列</button></>}
it('remembers the chosen columns across mounts and isolates account and report',()=>{
 localStorage.clear();const host=document.createElement('div');document.body.append(host);let root=createRoot(host)
 act(()=>root.render(<Demo/>));expect(host.textContent).toContain('全部显示');act(()=>host.querySelector('button')!.click());expect(host.textContent).toContain('orgCode')
 act(()=>root.unmount());root=createRoot(host);act(()=>root.render(<Demo/>));expect(host.textContent).toContain('orgCode')
 act(()=>root.render(<Demo report="summary"/>));expect(host.textContent).toContain('全部显示')
 identity.user={id:'two',tenantId:'tenant'};act(()=>root.render(<Demo/>));expect(host.textContent).toContain('全部显示')
 identity.user={id:'one',tenantId:'tenant'};act(()=>root.render(<Demo/>));expect(host.textContent).toContain('orgCode');act(()=>(host.querySelectorAll('button')[1] as HTMLButtonElement).click());expect(host.textContent).toContain('全部显示')
 act(()=>root.unmount());host.remove();localStorage.clear()
})
