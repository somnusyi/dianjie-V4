import {expect,it} from 'vitest'
import dayjs from './business-dayjs'
it('business timestamps use Beijing across browser zones and date-only values retain their day',()=>{
 const previous=process.env.TZ
 try{for(const zone of ['America/Los_Angeles','UTC','Asia/Shanghai']){process.env.TZ=zone;expect(dayjs('2026-11-03T00:30:00Z').format('YYYY-MM-DD HH:mm')).toBe('2026-11-03 08:30');expect(dayjs('2026-11-05').format('YYYY-MM-DD')).toBe('2026-11-05')}}finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous}
})

it('interprets business months and clocks without an offset in Beijing, including browsers east of China', () => {
 const previous=process.env.TZ
 try {
  for(const zone of ['America/Los_Angeles','UTC','Asia/Shanghai','Pacific/Auckland']) {
   process.env.TZ=zone
   expect(dayjs('2026-11').format('YYYY-MM-DD')).toBe('2026-11-01')
   expect(dayjs('2026-11-05T01:30').format('YYYY-MM-DD HH:mm')).toBe('2026-11-05 01:30')
   expect(dayjs('2026-11-05T01:30Z').format('YYYY-MM-DD HH:mm')).toBe('2026-11-05 09:30')
   expect(dayjs(new Date('2026-11-05T01:30Z')).valueOf()).toBe(Date.parse('2026-11-05T01:30Z'))
  }
 } finally {
  if(previous===undefined) delete process.env.TZ
  else process.env.TZ=previous
 }
})
