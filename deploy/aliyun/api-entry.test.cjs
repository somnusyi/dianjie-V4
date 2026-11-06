const { test } = require('node:test')
const assert = require('node:assert/strict')
const { configure } = require('./api-entry.cjs')

function fixture() {
  const env = { ALIYUN_DEPLOYMENT_SCOPE: 'uat', PREVIEW_MODE: 'true', PREVIEW_TENANT_SLUG: 'supply-chain-uat' }
  const secrets = {}
  for (const key of ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'CREDENTIAL_ENCRYPTION_KEYS']) {
    env[`${key}_FILE`] = `/run/secrets/${key.toLowerCase()}`
    secrets[env[`${key}_FILE`]] = key === 'DATABASE_URL' ? `postgresql://uat:${'a'.repeat(32)}@db.invalid/dianjie_v4_uat?schema=public` : 'b'.repeat(64)
  }
  return { env, secrets, files: { lstatSync: () => ({ isFile: () => true }), readFileSync: file => secrets[file] } }
}

test('configures the named isolated UAT and disables external execution', () => {
  const f = fixture(); configure(f.env, f.files)
  assert.match(f.env.DATABASE_URL, /\/dianjie_v4_uat\?/)
  for (const key of ['AUTO_FIX_ENABLED', 'CMB_AUTOPAY_ENABLED', 'CMB_INTERNAL_TRANSFER_ENABLED', 'CMB_SYNC_ENABLED', 'MEITUAN_ENABLED']) assert.equal(f.env[key], 'false')
  assert.equal(f.env.MEITUAN_MODE, 'mock')
})
test('rejects production scope and any other tenant', () => {
  for (const changed of [{ ALIYUN_DEPLOYMENT_SCOPE: 'production' }, { PREVIEW_TENANT_SLUG: 'production' }, { PREVIEW_MODE: 'false' }]) {
    const f = fixture(); Object.assign(f.env, changed)
    assert.throws(() => configure(f.env, f.files), /isolated/)
    assert.equal(f.env.DATABASE_URL, undefined)
  }
})
test('rejects a production database even when labelled UAT', () => {
  const f = fixture(); f.secrets[f.env.DATABASE_URL_FILE] = `postgresql://uat:${'a'.repeat(32)}@db.invalid/dianjie_v4`
  assert.throws(() => configure(f.env, f.files), /named UAT/)
  assert.equal(f.env.JWT_SECRET, undefined)
})
test('refuses inline secrets, traversal and symlink-like files', () => {
  for (const mode of ['inline', 'traversal', 'symlink']) {
    const f = fixture()
    if (mode === 'inline') f.env.DATABASE_URL = 'sensitive-value-not-to-log'
    if (mode === 'traversal') f.env.DATABASE_URL_FILE = '/run/secrets/../other'
    if (mode === 'symlink') f.files.lstatSync = () => ({ isFile: () => false })
    assert.throws(() => configure(f.env, f.files), error => !error.message.includes('sensitive-value-not-to-log'))
  }
})
test('refuses attempts to enable external execution before assigning secrets', () => {
  for (const key of ['AUTO_FIX_ENABLED', 'CMB_AUTOPAY_ENABLED', 'CMB_INTERNAL_TRANSFER_ENABLED', 'CMB_SYNC_ENABLED', 'MEITUAN_ENABLED']) {
    const f = fixture(); f.env[key] = 'true'
    assert.throws(() => configure(f.env, f.files), /must be disabled/)
    assert.equal(f.env.DATABASE_URL, undefined)
  }
})
