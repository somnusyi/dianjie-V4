#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Intentionally creates a new directory. Never resets an existing deployment's keys.
const target = process.argv[2]
if (!target || !path.isAbsolute(target)) throw new Error('Provide a new absolute secrets directory')
if (fs.existsSync(target)) throw new Error('Existing secrets directory is protected; no files changed')
const parent = path.dirname(target)
if (!fs.statSync(parent).isDirectory()) throw new Error('Parent directory must already exist')
const stage = fs.mkdtempSync(path.join(parent, '.huawei-secrets-'))
fs.chmodSync(stage, 0o700)
try {
  const values = {
    database_password: crypto.randomBytes(32).toString('hex'),
    app_database_password: crypto.randomBytes(32).toString('hex'),
    backup_database_password: crypto.randomBytes(32).toString('hex'),
    jwt_secret: crypto.randomBytes(48).toString('base64url'),
    jwt_refresh_secret: crypto.randomBytes(48).toString('base64url'),
    uat_password: crypto.randomBytes(24).toString('base64url'),
    credential_keys: JSON.stringify({current: 'huawei-uat-v1', keys: {'huawei-uat-v1': crypto.randomBytes(32).toString('hex')}}),
  }
  for (const [name, value] of Object.entries(values)) {
    // Compose file mounts preserve host permissions. The enclosing 0700 directory
    // protects these files on the host; 0444 permits the non-root container user.
    fs.writeFileSync(path.join(stage, name), `${value}\n`, {mode: 0o444, flag: 'wx'})
    fs.chmodSync(path.join(stage, name), 0o444)
  }
  fs.renameSync(stage, target)
  console.log('Created seven private mounted-secret files; values were not printed.')
} catch (error) {
  // Keep the private staging directory recoverable rather than deleting key material.
  console.error('Secret initialization failed. Existing deployment keys were not changed.')
  process.exitCode = 1
}
