import { z } from 'zod'

export const calendarDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式 YYYY-MM-DD')
  .refine(value => {
    const parsed = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  }, '日期不是有效日历日期')
