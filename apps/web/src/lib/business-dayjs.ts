import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
dayjs.extend(utc)
dayjs.extend(timezone)
/** Display business timestamps in Beijing; a date-only value keeps its calendar day. */
const businessDayjs: typeof dayjs = Object.assign((...args: Parameters<typeof dayjs>) => {
  const value=args[0]
  if(typeof value==='string' && args.length===1) {
    if(/^\d{4}-\d{2}$/.test(value)) return dayjs.tz(`${value}-01`,'Asia/Shanghai')
    if(/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?$/.test(value)) return dayjs.tz(value,'Asia/Shanghai')
  }
  return dayjs(...args).tz('Asia/Shanghai')
},dayjs)
export default businessDayjs
