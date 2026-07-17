type CryptoLike = {
  randomUUID?: () => string
  getRandomValues?: (values: Uint8Array) => Uint8Array
}

let fallbackSequence = 0

function browserCrypto(): CryptoLike | null {
  if (typeof globalThis === 'undefined') return null
  return (globalThis.crypto as CryptoLike | undefined) || null
}

function uuidFromBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Browser-safe UUID for idempotency keys.
 * `crypto.randomUUID` is unavailable in older WebViews and non-secure HTTP contexts.
 */
export function clientRequestId(cryptoSource: CryptoLike | null = browserCrypto()): string {
  if (typeof cryptoSource?.randomUUID === 'function') return cryptoSource.randomUUID()

  const bytes = new Uint8Array(16)
  if (typeof cryptoSource?.getRandomValues === 'function') {
    cryptoSource.getRandomValues(bytes)
  } else {
    const sequence = ++fallbackSequence
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
    const now = Date.now()
    for (let i = 0; i < 6; i += 1) bytes[i] ^= (now / (2 ** (i * 8))) & 0xff
    bytes[14] ^= (sequence >>> 8) & 0xff
    bytes[15] ^= sequence & 0xff
  }
  return uuidFromBytes(bytes)
}
