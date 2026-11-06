#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const directory = process.env.SECRETS_DIR
if (!directory || !path.isAbsolute(directory)) throw new Error('Set the absolute private Huawei test secrets directory')
const parent = fs.lstatSync(directory)
if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) throw new Error('Secrets require a private directory with no group/other access')
const names = ['database_password', 'app_database_password', 'backup_database_password', 'jwt_secret', 'jwt_refresh_secret', 'uat_password', 'credential_keys']
for (const name of names) {
  const file = fs.lstatSync(path.join(directory, name))
  if (!file.isFile() || file.isSymbolicLink()) throw new Error('Mounted secrets must be regular private-directory files')
}
if (process.env.LISTEN_ADDRESS && !['127.0.0.1', '::1', 'localhost'].includes(process.env.LISTEN_ADDRESS)) {
  let secureOrigin = false
  try {
    const url = new URL(process.env.PUBLIC_URL || '')
    secureOrigin = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
  } catch { /* Do not echo an invalid URL or any embedded credentials. */ }
  if (!secureOrigin) throw new Error('Public test deployment requires an explicit HTTPS origin')
}

function command(binary, args, capture = false) {
  const result = spawnSync(binary, args, {cwd: root, env: process.env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit'})
  if (result.error || result.status !== 0) throw new Error('Huawei test startup stopped after a failed prerequisite; no secrets logged')
  return capture ? result.stdout.trim() : ''
}
const docker = process.env.DOCKER_BINARY || 'docker'
const platform = command(docker, ['info', '--format', '{{.Architecture}}'], true)
const arch = ({aarch64: 'arm64', x86_64: 'amd64', arm64: 'arm64', amd64: 'amd64'})[platform]
if (!arch) throw new Error('Unverified Docker host architecture')
const tag = process.env.RELEASE_TAG || 'candidate'
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(tag)) throw new Error('Invalid release tag')
for (const service of ['api', 'web', 'gateway', 'migrate', 'backup']) {
  const actual = command(docker, ['image', 'inspect', `dianjie-huawei-${service}:${tag}`, '--format', '{{.Architecture}}'], true)
  if (actual !== arch) throw new Error('Image/host architecture mismatch; startup refused')
}
function compose(...args) {
  command(process.execPath, [path.join(root, 'scripts/ops/huawei-compose.mjs'), ...args])
}
compose('--profile', 'ops', 'config', '--quiet')
compose('up', '-d', '--wait', 'postgres', 'redis')
compose('--profile', 'ops', 'run', '--rm', '-T', 'migrate')
compose('--profile', 'ops', 'run', '--rm', '-T', 'bootstrap-db')
compose('--profile', 'ops', 'run', '--rm', '-T', 'seed')
compose('up', '-d', '--wait', 'api', 'web', 'gateway')
compose('ps')
console.log('Huawei test containers are healthy. This does not establish cloud resource entitlement, HTTPS or offsite backup.')
