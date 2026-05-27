import { describe, it, expect } from 'vitest'
import { classifyMeituanError, classifyUniauthSubCode, MEITUAN_ERROR_CODES } from '../../../src/services/meituan/errors'

describe('classifyMeituanError', () => {
  it('OP_SUCCESS → info', () => {
    expect(classifyMeituanError('OP_SUCCESS').severity).toBe('info')
  })

  it('OP_UNIAUTH_FAILED → inspectData', () => {
    expect(classifyMeituanError('OP_UNIAUTH_FAILED').retry).toBe('inspectData')
  })

  it('OP_TIMEOUT / OP_SOCKET_TIMEOUT_EXCEPTION → retry once', () => {
    expect(classifyMeituanError('OP_TIMEOUT').retry).toBe('once')
    expect(classifyMeituanError('OP_SOCKET_TIMEOUT_EXCEPTION').retry).toBe('once')
  })

  it('OP_LIMITATION_REJECT → backoff', () => {
    expect(classifyMeituanError('OP_LIMITATION_REJECT').retry).toBe('backoff')
  })

  it('未知错误码 → P1 + cat=unknown + 提示补字典', () => {
    const meta = classifyMeituanError('OP_TOTALLY_NEW_CODE_THAT_DOES_NOT_EXIST')
    expect(meta.severity).toBe('P1')
    expect(meta.cat).toBe('unknown')
    expect(meta.retry).toBe(false)
    expect(meta.desc).toContain('未知错误码')
  })

  it('null / undefined / 空 → P0 transport', () => {
    expect(classifyMeituanError(null).severity).toBe('P0')
    expect(classifyMeituanError(undefined).severity).toBe('P0')
    expect(classifyMeituanError(undefined).cat).toBe('transport')
  })

  it('字典完整性 — 至少含文档里的 P0/P1/P2 全集', () => {
    const required = [
      'OP_SUCCESS', 'OP_API_NOT_EXIST', 'OP_SYSTEM_ERROR', 'OP_BIZ_ERROR',
      'OP_TIMEOUT', 'OP_SYSTEM_PARAM_ERROR', 'OP_UNIAUTH_FAILED',
      'OP_API_GRANT_FAILED', 'OP_LIMITATION_REJECT', 'OP_LIMITATION_ERROR',
      'OP_CIRCUITBREAK', 'OP_SOCKET_TIMEOUT_EXCEPTION',
    ]
    for (const code of required) {
      expect(MEITUAN_ERROR_CODES[code], `字典缺 ${code}`).toBeDefined()
    }
  })
})

describe('classifyUniauthSubCode', () => {
  it('subCode 4 → refreshToken action', () => {
    expect(classifyUniauthSubCode(4).action).toBe('refreshToken')
  })

  it('subCode 5 → stop', () => {
    expect(classifyUniauthSubCode(5).action).toBe('stop')
  })

  it('未知 subCode → P0 stop', () => {
    expect(classifyUniauthSubCode(999).severity).toBe('P0')
    expect(classifyUniauthSubCode(999).action).toBe('stop')
  })
})
