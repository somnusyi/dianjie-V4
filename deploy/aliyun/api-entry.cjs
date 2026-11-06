const fs = require('node:fs')

function configure(env = process.env, files = fs) {
  if (env.ALIYUN_DEPLOYMENT_SCOPE !== 'uat' || env.PREVIEW_MODE !== 'true' || env.PREVIEW_TENANT_SLUG !== 'supply-chain-uat') {
    throw new Error('This image requires the explicitly isolated Alibaba UAT configuration')
  }
  const values = {}
  for (const key of ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'CREDENTIAL_ENCRYPTION_KEYS']) {
    if (env[key]) throw new Error('Use mounted secret files; inline secret overrides are refused')
    const file = env[`${key}_FILE`]
    if (!file || !file.startsWith('/run/secrets/') || file.includes('..') || !files.lstatSync(file).isFile()) {
      throw new Error('A required mounted secret file is missing or invalid')
    }
    const value = files.readFileSync(file, 'utf8').trim()
    if (value.length < 32) throw new Error('A required mounted secret is too short')
    values[key] = value
  }
  let database
  try { database = new URL(values.DATABASE_URL) } catch { throw new Error('Invalid mounted database configuration') }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.pathname !== '/dianjie_v4_uat') {
    throw new Error('Only the existing named UAT database is allowed')
  }
  const disabled = ['AUTO_FIX_ENABLED', 'CMB_AUTOPAY_ENABLED', 'CMB_INTERNAL_TRANSFER_ENABLED', 'CMB_SYNC_ENABLED', 'MEITUAN_ENABLED']
  for (const key of disabled) {
    if (env[key] && env[key] !== 'false') throw new Error('External execution must be disabled for this UAT image')
  }
  Object.assign(env, values)
  for (const key of disabled) env[key] = 'false'
  env.MEITUAN_MODE = 'mock'
}

module.exports = { configure }
if (require.main === module) {
  configure()
  require('./dist/lib/credential-vault.js').validateCredentialKeys()
  require('./dist/index.js')
}
