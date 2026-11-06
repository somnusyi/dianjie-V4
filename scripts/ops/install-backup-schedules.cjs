// Update existing backups only. No application restart, schema change, or data import.
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const {parseEnv} = require('node:util')

function schedulePlan(base, environment, existingTiers = {}) {
  if (!['production', 'uat'].includes(environment)) throw Error('Unknown environment')
  const common = {...base, offsite_deferred: true}
  delete common.failure_webhook_env // User explicitly declined external notifications.
  // Keep legacy weekly instance/archive paths; critical data now runs daily.
  return ['weekly', 'monthly'].map(frequency => ({
    instance: `${environment}-${frequency}`,
    calendar: frequency === 'weekly'
      ? '*-*-* 02:30:00 Asia/Shanghai' : '*-*-01 02:30:00 Asia/Shanghai',
    config: {...common,
      ...(Object.prototype.hasOwnProperty.call(existingTiers[frequency] || {}, 'encryption') ? {encryption: existingTiers[frequency].encryption} : {}),
      ...(Object.prototype.hasOwnProperty.call(existingTiers[frequency] || {}, 'backup_python') ? {backup_python: existingTiers[frequency].backup_python} : {}),
      directory: `/var/lib/dianjie-backups/${environment}-${frequency}`,
      backup_tier: frequency === 'weekly' ? 'critical' : 'full',
      ...(frequency === 'weekly' ? {table_policy: '/etc/dianjie/backup-table-policy.json'} : {}),
      maximum_age_hours: frequency === 'weekly' ? 36 : 35 * 24,
      retention_days: frequency === 'weekly' ? 63 : 190,
    },
  }))
}

// Verify the configured executable and every lexical/resolved parent. A venv's
// final python symlink is allowed only when both its ownership and target are safe.
function validateBackupPython(file, io = fs) {
  if (typeof file !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(file) || path.normalize(file) !== file) throw Error('backup_python must be an absolute normalized executable path')
  const checked = new Set()
  const inspect = (entry, final) => {
    if (checked.has(entry + ':' + final)) return
    checked.add(entry + ':' + final)
    const stat = io.lstatSync(entry)
    if (stat.uid !== 0) throw Error('Backup interpreter and parents must be root-owned')
    if (stat.isSymbolicLink()) {
      const resolved = io.realpathSync(entry)
      if (resolved === entry) throw Error('Invalid interpreter symlink')
      inspect(resolved, final)
    } else if ((stat.mode & 0o022) || (final ? !stat.isFile() || !(stat.mode & 0o111) : !stat.isDirectory())) {
      throw Error('Backup interpreter and parents must not be group/world writable')
    }
    const parent = path.dirname(entry)
    if (parent !== entry) inspect(parent, false)
  }
  inspect(file, true)
  return file
}

function unitPython(config) {
  return config.encryption != null ? config.backup_python : '/usr/bin/python3'
}

function pythonUnitDropin(config) {
  const python = unitPython(config)
  return `[Service]\nExecStart=\nExecStart=/usr/bin/flock --wait 3600 /var/lib/dianjie-backups/.daily.lock ${python} /app/dianjie-v4/scripts/ops/backup.py backup --config /etc/dianjie/backup-%i.json\n`
}

// Uses the SAME interpreter and service identity as the installed systemd unit.
// No dependency installation, key generation or config opt-in happens implicitly.
function preflightEncryption(plans, staged, run, io = fs) {
  const configured = plans.filter(p => p.config.encryption != null)
  if (!configured.length) return {enabled: false, helper: null, recipients: []}
  const helper = path.join(staged, 'backup_envelope.py')
  const helperStat = io.lstatSync(helper)
  if (!helperStat.isFile() || helperStat.isSymbolicLink()) throw Error('Missing regular staged encryption helper')
  const recipients = new Set()
  const runtimes = new Map()
  for (const p of configured) {
    const e = p.config.encryption
    if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).length !== 1 || typeof e.public_key_file !== 'string') throw Error('Encryption accepts only public_key_file')
    const file = e.public_key_file
    if (!path.isAbsolute(file) || path.normalize(file) !== file) throw Error('Backup recipient path must be absolute and normalized')
    const stat = io.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw Error('Backup recipient must be a root-owned, non-writable regular public-key file')
    recipients.add(file)
    const python = validateBackupPython(p.config.backup_python, io)
    if (!runtimes.has(python)) runtimes.set(python, new Set())
    runtimes.get(python).add(file)
  }
  // Load only this reviewed helper's source; no need to expose the staging directory
  // (which may also contain private config) to the service identity.
  const requirementFile = path.join(staged, 'requirements-backup.txt')
  const requirementStat = io.lstatSync(requirementFile)
  if (!requirementStat.isFile() || requirementStat.isSymbolicLink()) throw Error('Missing regular staged backup dependency pin')
  const requirements = io.readFileSync(requirementFile, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  const pin = requirements.length === 1 && /^cryptography==(\d+\.\d+\.\d+)$/.exec(requirements[0])
  if (!pin) throw Error('Backup dependency manifest must contain exactly one cryptography version pin')
  const expectedVersion = pin[1]
  const helperSource = io.readFileSync(helper, 'utf8')
  const code = `from importlib.metadata import version
import cryptography
if version('cryptography') != '${expectedVersion}' or cryptography.__version__ != '${expectedVersion}': raise RuntimeError('Backup cryptography version differs from the reviewed pin')
` + helperSource + `
import sys,os,tempfile
from pathlib import Path
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
for p in sys.argv[1:]: load_public(p)
with tempfile.TemporaryDirectory(prefix='dianjie-crypto-preflight-') as folder:
 root=Path(folder);plain=root/'source';plain.write_bytes(b'synthetic-preflight-only')
 generated=rsa.generate_private_key(public_exponent=65537,key_size=3072)
 public=root/'recipient.pub';public.write_bytes(generated.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo))
 private=root/'recovery.key';private.write_bytes(generated.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()));private.chmod(0o600)
 encrypted=root/'sealed.enc';seal_file(plain,encrypted,public);recover_file(encrypted,root/'out',private)
 assert (root/'out').read_bytes()==plain.read_bytes()
`
  try {
    for (const [python, keys] of runtimes) run(['runuser', '-u', 'dianjie-backup', '--', python, '-I', '-c', code, ...keys])
  } catch {
    throw Error('Encryption preflight failed: service Python needs the exact requirements-backup.txt cryptography version and a readable valid public key; existing configuration was not changed')
  }
  return {enabled: true, helper, recipients: [...recipients], cryptographyVersion: expectedVersion, interpreters: [...runtimes.keys()]}
}

function main(staged) {
  if (process.getuid() !== 0) throw Error('Run on the known server as root')
  const run = argv => cp.execFileSync(argv[0], argv.slice(1), {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})
  const required = ['backup.py', 'backup-table-policy.json', 'dianjie-backup@.service', 'dianjie-backup@.timer']
  for (const file of required) if (!fs.statSync(path.join(staged, file)).isFile()) throw Error('Missing staged input')
  const policy = JSON.parse(fs.readFileSync(path.join(staged, 'backup-table-policy.json')))
  if (policy.version !== 1 || !policy.monthly_only_tables.length) throw Error('Invalid table policy')
  const plans = []
  for (const environment of ['production', 'uat']) {
    const original = JSON.parse(fs.readFileSync(`/etc/dianjie/backup-${environment}.json`))
    const values = parseEnv(fs.readFileSync(`/etc/dianjie/backup-${environment}.env`, 'utf8'))
    if (new URL(values.DATABASE_URL).pathname !== (environment === 'production' ? '/dianjie_v4' : '/dianjie_v4_uat')) throw Error('Database boundary mismatch')
    const existingTiers = {}
    for (const frequency of ['weekly', 'monthly']) {
      const file = `/etc/dianjie/backup-${environment}-${frequency}.json`
      if (fs.existsSync(file)) existingTiers[frequency] = JSON.parse(fs.readFileSync(file))
    }
    plans.push(...schedulePlan(original, environment, existingTiers))
  }
  // Validate crypto dependency/key access before ANY installation, config write or timer change.
  const encryption = preflightEncryption(plans, staged, run)
  const before = '/etc/dianjie/backup-schedule-before-20261027'
  fs.mkdirSync(before, {recursive: true, mode: 0o700})
  for (const file of ['dianjie-backup@.service', 'dianjie-backup@.timer']) {
    const source = '/etc/systemd/system/' + file, saved = path.join(before, file)
    if (fs.existsSync(source) && !fs.existsSync(saved)) fs.copyFileSync(source, saved, fs.constants.COPYFILE_EXCL)
  }
  const oldScript = '/app/dianjie-v4/scripts/ops/backup.py'
  if (!fs.existsSync(path.join(before, 'backup.py'))) fs.copyFileSync(oldScript, path.join(before, 'backup.py'), fs.constants.COPYFILE_EXCL)
  if (encryption.enabled) {
    const currentHelper = path.join(path.dirname(oldScript), 'backup_envelope.py')
    const savedHelper = path.join(before, 'backup_envelope.py')
    if (fs.existsSync(currentHelper) && !fs.existsSync(savedHelper)) fs.copyFileSync(currentHelper, savedHelper, fs.constants.COPYFILE_EXCL)
    const currentPin = path.join(path.dirname(oldScript), 'requirements-backup.txt')
    const savedPin = path.join(before, 'requirements-backup.txt')
    if (fs.existsSync(currentPin) && !fs.existsSync(savedPin)) fs.copyFileSync(currentPin, savedPin, fs.constants.COPYFILE_EXCL)
    run(['install', '-m', '644', path.join(staged, 'requirements-backup.txt'), currentPin])
    run(['install', '-m', '644', encryption.helper, currentHelper])
  }
  run(['install', '-m', '755', path.join(staged, 'backup.py'), oldScript])
  run(['install', '-m', '640', '-o', 'root', '-g', 'dianjie-backup', path.join(staged, 'backup-table-policy.json'), '/etc/dianjie/backup-table-policy.json'])
  for (const item of plans) {
    run(['install', '-d', '-m', '700', '-o', 'dianjie-backup', '-g', 'dianjie-backup', item.config.directory])
    const config = `/etc/dianjie/backup-${item.instance}.json`
    fs.writeFileSync(config + '.partial', JSON.stringify(item.config, null, 2) + '\n', {mode: 0o640})
    // A private release process may inherit umask 077; the service group still needs read access.
    fs.chmodSync(config + '.partial', 0o640)
    run(['chown', 'root:dianjie-backup', config + '.partial'])
    fs.renameSync(config + '.partial', config)
    const env = `/etc/dianjie/backup-${item.instance}.env`
    const originalEnv = `/etc/dianjie/backup-${item.instance.split('-')[0]}.env`
    if (fs.existsSync(env)) {
      if (!fs.lstatSync(env).isSymbolicLink() || fs.readlinkSync(env) !== originalEnv) throw Error('Unexpected existing credential path')
    } else fs.symlinkSync(originalEnv, env)
    const serviceDropin = `/etc/systemd/system/dianjie-backup@${item.instance}.service.d`
    const runtimeFile = path.join(serviceDropin, '10-backup-python.conf')
    const savedRuntime = path.join(before, `${item.instance}.service-python.conf`)
    if (fs.existsSync(runtimeFile) && !fs.existsSync(savedRuntime)) fs.copyFileSync(runtimeFile, savedRuntime, fs.constants.COPYFILE_EXCL)
    fs.mkdirSync(serviceDropin, {recursive: true, mode: 0o755})
    fs.writeFileSync(runtimeFile, pythonUnitDropin(item.config), {mode: 0o644})
    const dropin = `/etc/systemd/system/dianjie-backup@${item.instance}.timer.d`
    fs.mkdirSync(dropin, {recursive: true, mode: 0o755})
    fs.writeFileSync(path.join(dropin, 'schedule.conf'), `[Timer]\nOnCalendar=\nOnCalendar=${item.calendar}\n`, {mode: 0o644})
  }
  for (const file of ['dianjie-backup@.service', 'dianjie-backup@.timer']) run(['install', '-m', '644', path.join(staged, file), '/etc/systemd/system/' + file])
  run(['systemd-analyze', 'verify', '/etc/systemd/system/dianjie-backup@.service', '/etc/systemd/system/dianjie-backup@.timer'])
  run(['systemctl', 'daemon-reload'])
  for (const item of plans) {
    const loaded = run(['systemctl', 'show', `dianjie-backup@${item.instance}.service`, '--property=ExecStart', '--value'])
    const expected = `/usr/bin/flock --wait 3600 /var/lib/dianjie-backups/.daily.lock ${unitPython(item.config)} /app/dianjie-v4/scripts/ops/backup.py backup --config /etc/dianjie/backup-${item.instance}.json`
    if (!loaded.includes(expected)) throw Error('Loaded backup unit does not use the verified interpreter; timers were not enabled')
  }
  run(['systemctl', 'enable', '--now', ...plans.map(p => `dianjie-backup@${p.instance}.timer`)])
  // Keep existing archives and let any already-running legacy job finish.
  run(['systemctl', 'disable', '--now', 'dianjie-backup@production.timer', 'dianjie-backup@uat.timer'])
  console.log(JSON.stringify({scheduledInstances: plans.map(p => ({instance: p.instance, calendar: p.calendar})), legacyDailyTimersDisabled: true, previousArchivesRetained: true, externalNotificationsEnabled: false, applicationRestarted: false, encryptionPreflight: encryption.enabled ? 'passed' : 'not_configured_legacy_compatible', encryptionRecipients: encryption.recipients.length, backupInterpreters: plans.map(item => ({instance: item.instance, python: unitPython(item.config)}))}))
}

module.exports = {schedulePlan, validateBackupPython, unitPython, pythonUnitDropin, preflightEncryption, installSchedules: main}
if (require.main === module) main(process.argv[2] || '/tmp/dianjie-backup-schedules-20261027')
