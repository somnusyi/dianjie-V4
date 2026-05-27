import * as crypto from 'crypto'

/**
 * 美团技术服务合作中心签名算法
 * Doc: https://developer.meituan.com/docs/biz/comm-dev-isv-sign-rule
 *
 * 步骤（已对照官方 PHP / Java / C# 实现验证）:
 *  1. 取除 sign 外所有非空 key-value
 *  2. key 字典序排序
 *  3. 拼成 "key1value1key2value2..."（无 = 无 &）
 *  4. 前置 signKey (= appSecret)
 *  5. SHA1 → hex 小写
 *
 * 与 CMB 签名（国密）不同，美团这套就是普通 SHA1。
 */
export function signMeituan(
  signKey: string,
  params: Record<string, string | null | undefined>,
): string {
  const keys = Object.keys(params).sort()
  let str = signKey
  for (const k of keys) {
    if (k === 'sign') continue
    const v = params[k]
    if (v == null || v === '') continue
    str += k + v
  }
  return crypto.createHash('sha1').update(str, 'utf8').digest('hex').toLowerCase()
}
