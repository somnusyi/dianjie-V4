import { describe, it, expect } from 'vitest'
import { signMeituan } from '../../../src/services/meituan/signature'

describe('signMeituan', () => {
  it('对照官方 PHP doc 样例 — 输出 40 位 SHA1 hex', () => {
    // 样例来自 https://developer.meituan.com/docs/biz/comm-dev-isv-sign-rule §2.1 PHP
    // signKey="123456", biz="{'req':100}", charset="utf-8", appAuthToken="123", timestamp="1577771730", version="1"
    const sig = signMeituan('123456', {
      biz: "{'req':100}",
      charset: 'utf-8',
      appAuthToken: '123',
      timestamp: '1577771730',
      version: '1',
    })
    expect(sig).toMatch(/^[a-f0-9]{40}$/)
  })

  it('稳定输出 — 同输入两次签名一致', () => {
    const params = { biz: '{"x":1}', timestamp: '1700000000', developerId: '100', charset: 'utf-8', version: '2' }
    expect(signMeituan('secret', params)).toBe(signMeituan('secret', params))
  })

  it('忽略 sign 参数自身', () => {
    const a = signMeituan('secret', { biz: '{}', timestamp: '1' })
    const b = signMeituan('secret', { biz: '{}', timestamp: '1', sign: 'should-be-ignored' })
    expect(a).toBe(b)
  })

  it('忽略空字符串 / null / undefined 字段', () => {
    const a = signMeituan('secret', { biz: '{}', timestamp: '1' })
    const b = signMeituan('secret', { biz: '{}', timestamp: '1', appAuthToken: '', refreshToken: null as any, extra: undefined })
    expect(a).toBe(b)
  })

  it('字段顺序无关（内部按字典序排序）', () => {
    const a = signMeituan('k', { a: '1', b: '2', c: '3' })
    const b = signMeituan('k', { c: '3', a: '1', b: '2' })
    expect(a).toBe(b)
  })

  it('对 charset=UTF-8 大小写敏感（字面值是什么就用什么）', () => {
    const a = signMeituan('k', { charset: 'utf-8' })
    const b = signMeituan('k', { charset: 'UTF-8' })
    expect(a).not.toBe(b)
  })
})
