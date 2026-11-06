import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const PREFIX = 'djenc:v1:'
const failure = () => Object.assign(new Error('凭据加密配置或记录不可用，请联系管理员核对'), { statusCode: 503, code: 'CREDENTIAL_UNAVAILABLE' })

function keyring() {
  try {
    const config = JSON.parse(process.env.CREDENTIAL_ENCRYPTION_KEYS || '')
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(config.current) || !config.keys || typeof config.keys !== 'object') throw failure()
    const keys = new Map<string, Buffer>()
    for (const [id, value] of Object.entries(config.keys)) {
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) throw failure()
      keys.set(id, Buffer.from(value, 'hex'))
    }
    if (!keys.has(config.current)) throw failure()
    return { current: config.current as string, keys }
  } catch { throw failure() }
}

export function validateCredentialKeys() { keyring() }

/** Context binds a credential to its tenant/owner, table and field. */
export function sealCredential(value: string | null | undefined, context: string): string | null {
  if (value == null) return null
  if (!value) return ''
  const { current, keys } = keyring()
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keys.get(current)!, nonce)
  cipher.setAAD(Buffer.from(`${PREFIX}${current}:${context}`))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${PREFIX}${current}:${nonce.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`
}

export function openCredential(value: string | null | undefined, context: string): string | null {
  if (value == null) return null
  if (!value) return ''
  if (!value.startsWith(PREFIX)) {
    if (value.startsWith('djenc:')) throw failure()
    // A deliberate rollout compatibility setting, never an implicit fallback.
    // Reading legacy data does not rewrite any record.
    if (process.env.CREDENTIAL_LEGACY_READ_ALLOWED === 'true') return value
    throw failure()
  }
  try {
    const parts = value.slice(PREFIX.length).split(':')
    if (parts.length !== 4 || parts.some(p => !p) || !parts.slice(1).every(p => /^[A-Za-z0-9_-]+$/.test(p))) throw failure()
    const [id, nonceText, tagText, encryptedText] = parts
    const { keys } = keyring()
    const key = keys.get(id)
    const nonce = Buffer.from(nonceText, 'base64url'), tag = Buffer.from(tagText, 'base64url')
    if (!key || nonce.length !== 12 || tag.length !== 16) throw failure()
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(Buffer.from(`${PREFIX}${id}:${context}`))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8')
  } catch { throw failure() }
}

export const credentialContext = (owner: string | number, table: string, field: string) => `${table}:${owner}:${field}`
