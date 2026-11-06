import { credentialContext, openCredential, sealCredential, validateCredentialKeys } from './credential-vault'

const targets = [
  { model: 'weComConfig', owner: (r: any) => r.tenantId, table: 'wecom', fields: ['appSecret', 'contactSecret', 'callbackToken', 'encodingAESKey', 'accessToken', 'contactToken'] },
  { model: 'meituanAuthToken', owner: (r: any) => r.orgId, table: 'meituan', fields: ['appAuthToken', 'refreshToken'] },
  { model: 'store', owner: (r: any) => `${r.tenantId}:${r.id}`, table: 'store-payment', fields: ['aggregatorApiKeyEnc', 'aggregatorSecretEnc', 'wechatApiV3KeyEnc', 'alipayPrivateKeyEnc'] },
] as const
const safeFailure = () => Object.assign(new Error('凭据转换未完成；事务已取消，请核对密钥、记录及并发修改'), { code: 'CREDENTIAL_MIGRATION_FAILED' })

/** No values, identifiers, SQL, or driver error messages leave this boundary. */
export async function migrateCredentials(prisma: any, { execute = false } = {}) {
  try {
    validateCredentialKeys()
    return await prisma.$transaction(async (tx: any) => {
      // Lock only conversions against each other; CAS below also guards application edits.
      await tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('dianjie-credential-conversion-v1'))::text")
      const summary: Record<string, { rows: number; legacyFields: number; encryptedFields: number; emptyFields: number; changedRows: number }> = {}
      for (const target of targets) {
        const result = { rows: 0, legacyFields: 0, encryptedFields: 0, emptyFields: 0, changedRows: 0 }
        let cursor: string | undefined
        for (;;) {
          const rows = await tx[target.model].findMany({ take: 200, orderBy: { id: 'asc' }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, ...(target.model !== 'meituanAuthToken' ? { tenantId: true } : { orgId: true }), ...Object.fromEntries(target.fields.map(f => [f, true])) } })
          for (const row of rows) {
            result.rows++
            const data: Record<string, string> = {}, where: Record<string, any> = { id: row.id }
            for (const field of target.fields) {
              const value = row[field]
              if (value == null || value === '') { result.emptyFields++; continue }
              if (typeof value !== 'string') throw safeFailure()
              const contextField = target.table === 'store-payment' ? field.replace(/Enc$/, '') : field
              const context = credentialContext(target.owner(row), target.table, contextField)
              if (value.startsWith('djenc:')) {
                openCredential(value, context) // Verify existing envelopes; never double-encrypt.
                result.encryptedFields++
              } else {
                result.legacyFields++
                data[field] = sealCredential(value, context)!
                where[field] = value
              }
            }
            if (execute && Object.keys(data).length) {
              const updated = await tx[target.model].updateMany({ where, data })
              if (updated.count !== 1) throw safeFailure()
              result.changedRows++
            }
          }
          if (rows.length < 200) break
          cursor = rows[rows.length - 1].id
        }
        summary[target.model] = result
      }
      return { mode: execute ? 'execute' : 'dry-run', summary }
    }, { timeout: 120000, maxWait: 10000 })
  } catch { throw safeFailure() }
}
