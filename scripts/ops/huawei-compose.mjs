#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const secretDir = process.env.SECRETS_DIR
if (!secretDir || !path.isAbsolute(secretDir) || !fs.statSync(secretDir).isDirectory()) {
  throw new Error('Set SECRETS_DIR to the absolute private test secrets directory')
}
// Explicitly disable Compose's automatic loading of a developer/production .env.
const result = spawnSync(process.env.DOCKER_BINARY || 'docker', [
  'compose', '--env-file', '/dev/null', '-f', path.join(root, 'deploy/huawei/compose.yml'),
  ...process.argv.slice(2),
], { cwd: root, env: process.env, stdio: 'inherit' })
if (result.error) throw new Error('Docker Compose could not start')
process.exit(result.status ?? 1)
