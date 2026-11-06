const test = require('node:test')
const assert = require('node:assert/strict')
const {schedulePlan} = require('./install-backup-schedules.cjs')

test('keeps databases and schedules separate; monthly is a full recovery baseline', () => {
  const base = {database_url_env: 'DATABASE_URL', content_addressed: true, attachment_source: 'oss', local_attachment_directory: '/existing/uploads', failure_webhook_env: 'OLD_NOTIFY'}
  const all = ['production', 'uat'].flatMap(environment => schedulePlan(base, environment))
  assert.equal(new Set(all.map(p => p.config.directory)).size, 4)
  assert.equal(all.filter(p => p.config.backup_tier === 'critical').length, 2)
  assert.equal(all.filter(p => p.config.backup_tier === 'full').length, 2)
  for (const p of all) {
    assert.equal(p.config.local_attachment_directory, '/existing/uploads')
    assert.equal(p.config.failure_webhook_env, undefined)
    assert.ok(p.config.retention_days > p.config.maximum_age_hours / 24)
    assert.equal(p.config.content_addressed, true)
    assert.match(p.calendar, /Asia\/Shanghai$/)
  }
  for (const environment of ['production', 'uat']) {
    const [critical, monthly] = all.filter(p => p.instance.startsWith(environment + '-'))
    assert.equal(critical.calendar, '*-*-* 02:30:00 Asia/Shanghai')
    assert.equal(critical.config.maximum_age_hours, 36)
    assert.equal(critical.config.retention_days, 63)
    assert.equal(monthly.calendar, '*-*-01 02:30:00 Asia/Shanghai')
    assert.equal(monthly.config.maximum_age_hours, 840)
    assert.equal(monthly.config.retention_days, 190)
  }
  assert.equal(base.failure_webhook_env, 'OLD_NOTIFY')
  assert.throws(() => schedulePlan(base, 'other'))
})

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const {preflightEncryption, validateBackupPython, unitPython, pythonUnitDropin} = require('./install-backup-schedules.cjs')
const regular = {isFile: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o100644}
const safeStat = file => file.endsWith('/python3') ? {...regular, mode: 0o100755} : {...regular, isDirectory: () => true}
const helperOnlyIo = {lstatSync: safeStat, readFileSync: file => file.endsWith('requirements-backup.txt') ? '# reviewed dependency\ncryptography==46.0.5\n' : '# reviewed helper source\n'}
const encryptedPlan = (key = '/etc/dianjie/backup-recipient.pub') => [{config: {encryption: {public_key_file: key}, backup_python: '/opt/dianjie-backup-venv/bin/python3'}}]

test('legacy schedules require no crypto helper, dependency, public key or command', () => {
  const noIo = new Proxy({}, {get() {throw Error('No encryption filesystem access expected')}})
  assert.deepEqual(preflightEncryption([{config: {}}, {config: {encryption: null}}], '/staged', () => {throw Error('No command expected')}, noIo), {enabled: false, helper: null, recipients: []})
})

test('preserves explicit per-tier encryption without changing other policy or mixing environments', () => {
  const base = {encryption: {public_key_file: '/etc/dianjie/default.pub'}, content_addressed: true}
  const plans = schedulePlan(base, 'production', {weekly: {encryption: {public_key_file: '/etc/dianjie/weekly.pub'}, directory: '/wrong'}, monthly: {encryption: null}})
  assert.equal(plans[0].config.encryption.public_key_file, '/etc/dianjie/weekly.pub')
  assert.equal(plans[1].config.encryption, null)
  assert.equal(plans[0].config.directory, '/var/lib/dianjie-backups/production-weekly')
  assert.equal(base.encryption.public_key_file, '/etc/dianjie/default.pub')
  assert.equal(schedulePlan({}, 'uat')[0].config.encryption, undefined)
})

test('preflights all unique explicit recipients as the actual service interpreter and identity', () => {
  const commands = []
  const result = preflightEncryption([...encryptedPlan(), ...encryptedPlan(), ...encryptedPlan('/etc/dianjie/uat.pub')], '/staged', argv => commands.push(argv), helperOnlyIo)
  assert.equal(result.enabled, true)
  assert.equal(result.helper, '/staged/backup_envelope.py')
  assert.deepEqual(result.recipients, ['/etc/dianjie/backup-recipient.pub', '/etc/dianjie/uat.pub'])
  assert.equal(commands.length, 1)
  assert.deepEqual(commands[0].slice(0, 8), ['runuser', '-u', 'dianjie-backup', '--', '/opt/dianjie-backup-venv/bin/python3', '-I', '-c', commands[0][7]])
  assert.match(commands[0][7], /seal_file\(plain,encrypted,public\)/)
  assert.match(commands[0][7], /recover_file\(encrypted,root\/'out',private\)/)
})

test('rejects missing helper, missing dependency or unreadable key before returning an installation plan', () => {
  const noFile = {...helperOnlyIo, lstatSync: () => {throw Object.assign(Error('missing'), {code: 'ENOENT'})}}
  assert.throws(() => preflightEncryption(encryptedPlan(), '/staged', () => {}, noFile))
  assert.throws(() => preflightEncryption(encryptedPlan(), '/staged', () => {throw Error('synthetic import/key failure')}, helperOnlyIo), /existing configuration was not changed/)
})

test('rejects private-key config, unsafe public paths, mutable key files and symlinks', () => {
  for (const encryption of [{private_key_file: '/private'}, {public_key_file: '/public', private_key_file: '/private'}, [], 'key', {public_key_file: '../key'}, {public_key_file: '/etc/../key'}]) {
    assert.throws(() => preflightEncryption([{config: {encryption}}], '/staged', () => {}, helperOnlyIo))
  }
  for (const stat of [{...regular, uid: 1000}, {...regular, mode: 0o100666}, {...regular, isSymbolicLink: () => true}, {...regular, isFile: () => false}]) {
    const io = {...helperOnlyIo, lstatSync: file => file.endsWith('backup_envelope.py') ? regular : stat}
    assert.throws(() => preflightEncryption(encryptedPlan(), '/staged', () => {}, io))
  }
})

test('the emitted crypto preflight actually executes the helper against a synthetic public key', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dianjie-install-preflight-'))
  try {
    const publicFile = path.join(folder, 'recipient.pub')
    cp.execFileSync('python3', ['-c', `from cryptography.hazmat.primitives import serialization\nfrom cryptography.hazmat.primitives.asymmetric import rsa\nfrom pathlib import Path\nimport sys\nk=rsa.generate_private_key(public_exponent=65537,key_size=3072)\nPath(sys.argv[1]).write_bytes(k.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo))`, publicFile])
    const venv = path.join(folder, 'venv')
    cp.execFileSync('python3', ['-m', 'venv', '--system-site-packages', venv])
    const executable = path.join(venv, 'bin', 'python3')
    // This synthetic temp fixture is under /tmp, so emulate protected ownership/parent modes.
    // Real type, executable and symlink target inspection still use actual filesystem metadata.
    const io = {...fs, lstatSync(file) {const s = fs.lstatSync(file);return {isFile: () => s.isFile(), isDirectory: () => s.isDirectory(), isSymbolicLink: () => s.isSymbolicLink(), uid: 0, mode: s.mode & ~0o022}}}
    let count = 0
    const plans = encryptedPlan(publicFile);plans[0].config.backup_python = executable
    preflightEncryption(plans, __dirname, argv => {count++;assert.equal(argv[4], executable);cp.execFileSync(argv[4], argv.slice(5), {stdio: 'pipe'})}, io)
    assert.ok(pythonUnitDropin(plans[0].config).includes(executable))
    assert.equal(count, 1)
  } finally {fs.rmSync(folder, {recursive: true, force: true})}
})

function simulatedInstaller(encryption, failPreflight = false, loadedMismatch = false) {
  const vm = require('node:vm')
  const writes = [], commands = [], output = []
  const io = {
    statSync: () => regular, lstatSync: safeStat, existsSync: () => false,
    readFileSync(file) {
      if (file.endsWith('backup-table-policy.json')) return JSON.stringify({version: 1, monthly_only_tables: ['logs']})
      if (file.endsWith('requirements-backup.txt')) return 'cryptography==46.0.5\n'
      if (file.endsWith('backup_envelope.py')) return '# helper source\n'
      if (file.endsWith('.env')) return `DATABASE_URL=postgresql://synthetic@127.0.0.1/${file.includes('production') ? 'dianjie_v4' : 'dianjie_v4_uat'}\n`
      if (file.endsWith('.json')) return JSON.stringify({database_url_env: 'DATABASE_URL', ...(encryption ? {encryption: {public_key_file: '/etc/dianjie/recipient.pub'}, backup_python: '/opt/dianjie-backup-venv/bin/python3'} : {})})
      throw Error('Unexpected read')
    },
    constants: {COPYFILE_EXCL: 1},
  }
  for (const name of ['mkdirSync', 'copyFileSync', 'writeFileSync', 'chmodSync', 'renameSync', 'symlinkSync']) io[name] = (...args) => writes.push([name, ...args])
  const proc = {getuid: () => 0}
  const child = {execFileSync(command, args) {commands.push([command, ...args]);if (command === 'runuser' && failPreflight) throw Error('synthetic missing crypto');if(command === 'systemctl' && args[0] === 'show'){const instance = args[1].replace('dianjie-backup@','').replace('.service','');return `/usr/bin/flock --wait 3600 /var/lib/dianjie-backups/.daily.lock ${encryption && !loadedMismatch ? '/opt/dianjie-backup-venv/bin/python3' : '/usr/bin/python3'} /app/dianjie-v4/scripts/ops/backup.py backup --config /etc/dianjie/backup-${instance}.json`};return ''}}
  const context = {URL, module: {exports: {}}, require(name) {return name === 'node:fs' ? io : name === 'node:child_process' ? child : require(name)}, process: proc, console: {log: value => output.push(JSON.parse(value))}}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'install-backup-schedules.cjs'), 'utf8'), context)
  let error
  try {context.module.exports.installSchedules('/staged')} catch (e) {error = e}
  return {writes, commands, output, error}
}

test('main installer crypto preflight failure cannot change configs, scripts or timers', () => {
  const result = simulatedInstaller(true, true)
  assert.match(result.error.message, /existing configuration was not changed/)
  assert.equal(result.writes.length, 0)
  assert.equal(result.commands.length, 1)
  assert.equal(result.commands[0][0], 'runuser')
})

test('main installer copies helper automatically only when encryption is explicitly configured', () => {
  for (const enabled of [false, true]) {
    const result = simulatedInstaller(enabled)
    assert.equal(result.error, undefined)
    assert.equal(result.commands.some(c => c[0] === 'runuser'), enabled)
    assert.equal(result.commands.some(c => c[0] === 'install' && c.includes('/staged/backup_envelope.py')), enabled)
    const configs = result.writes.filter(w => w[0] === 'writeFileSync' && /backup-(production|uat)-(weekly|monthly)\.json\.partial$/.test(w[1])).map(w => JSON.parse(w[2]))
    assert.equal(configs.length, 4)
    assert.equal(configs.filter(c => c.backup_tier === 'critical').length, 2)
    assert.equal(configs.filter(c => c.backup_tier === 'full').length, 2)
    assert.equal(configs.filter(c => c.encryption != null).length, enabled ? 4 : 0)
    assert.equal(result.output[0].applicationRestarted, false)
    assert.equal(result.output[0].encryptionPreflight, enabled ? 'passed' : 'not_configured_legacy_compatible')
    if (enabled) {
      const helperAt = result.commands.findIndex(c => c[0] === 'install' && c.includes('/staged/backup_envelope.py'))
      const scriptAt = result.commands.findIndex(c => c[0] === 'install' && c.includes('/staged/backup.py'))
      const timerAt = result.commands.findIndex(c => c[0] === 'systemctl' && c[1] === 'enable')
      assert.ok(helperAt >= 0 && scriptAt > helperAt && timerAt > scriptAt)
    }
  }
})

test('restores group-read permission before publishing configs even with a private release umask', () => {
  const result = simulatedInstaller(true)
  assert.equal(result.error, undefined)
  const published = result.writes.filter(w => w[0] === 'renameSync' && /backup-(production|uat)-(weekly|monthly)\.json$/.test(w[2]))
  assert.equal(published.length, 4)
  for (const rename of published) {
    const mode = result.writes.findIndex(w => w[0] === 'chmodSync' && w[1] === rename[1] && w[2] === 0o640)
    assert.ok(mode >= 0 && mode < result.writes.indexOf(rename))
  }
})

test('reads the exact dependency version from the staged requirements pin and rejects loose or multiple dependencies', () => {
  const io = {...helperOnlyIo, readFileSync: file => file.endsWith('requirements-backup.txt') ? '# next reviewed pin\ncryptography==46.0.4\n' : '# helper\n'}
  let code = ''
  const result = preflightEncryption(encryptedPlan(), '/staged', argv => {code = argv[7]}, io)
  assert.equal(result.cryptographyVersion, '46.0.4')
  assert.match(code, /version\('cryptography'\) != '46\.0\.4'/)
  for (const manifest of ['', 'cryptography>=46.0.5', 'cryptography==46.0.5\nother==1.0.0', 'cryptography==46.0.5; python_version>"3"']) {
    const unsafe = {...helperOnlyIo, readFileSync: file => file.endsWith('requirements-backup.txt') ? manifest : '# helper\n'}
    let ran = false
    assert.throws(() => preflightEncryption(encryptedPlan(), '/staged', () => {ran = true}, unsafe), /exactly one cryptography version pin/)
    assert.equal(ran, false)
  }
})

test('a real emitted preflight refuses cryptography3.4.8 even when importing cryptography itself succeeds', () => {
  let executed = false
  assert.throws(() => preflightEncryption(encryptedPlan(), '/staged', argv => {
    executed = true
    cp.execFileSync('python3', ['-I', '-c', `import importlib.metadata as m\nm.version=lambda package: '3.4.8'\n` + argv[7], ...argv.slice(8)], {stdio: 'pipe'})
  }, helperOnlyIo), /exact requirements-backup.txt cryptography version/)
  assert.equal(executed, true)
})

test('accepts only controlled venv executable symlinks and verifies resolved plus lexical parents', () => {
  const executable = '/opt/dianjie-backup-venv/bin/python3', target = '/usr/bin/python3.10', reads = []
  const dir = {uid: 0, mode: 0o40755, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false}
  const binary = {...dir, mode: 0o100755, isDirectory: () => false, isFile: () => true}
  const link = {...dir, mode: 0o120777, isDirectory: () => false, isSymbolicLink: () => true}
  const io = {lstatSync(file) {reads.push(file);return file === executable ? link : file === target ? binary : dir}, realpathSync: () => target}
  assert.equal(validateBackupPython(executable, io), executable)
  for (const p of ['/opt/dianjie-backup-venv/bin', '/opt/dianjie-backup-venv', '/opt', '/usr/bin', '/usr', '/']) assert.ok(reads.includes(p))
  for (const [unsafeFile, change] of [[executable, {uid: 1000}], [target, {mode: 0o100777}], ['/opt', {mode: 0o40777}], ['/usr/bin', {uid: 1000}]]) {
    const unsafe = {...io, lstatSync(file) {return {...io.lstatSync(file), ...(file === unsafeFile ? change : {})}}}
    assert.throws(() => validateBackupPython(executable, unsafe))
  }
})

test('requires an explicit protected interpreter for encryption and keeps legacy on system Python', () => {
  for (const file of [undefined, 'python3', '/opt/../bin/python3', '/opt/venv/bin/python3 --flag']) assert.throws(() => validateBackupPython(file, helperOnlyIo))
  const noExec = {...helperOnlyIo, lstatSync: file => file.endsWith('/python3') ? regular : safeStat(file)}
  assert.throws(() => validateBackupPython('/opt/venv/bin/python3', noExec))
  const plan = encryptedPlan();delete plan[0].config.backup_python
  assert.throws(() => preflightEncryption(plan, '/staged', () => {}, helperOnlyIo))
  assert.equal(unitPython({backup_python: '/ignored/without/encryption'}), '/usr/bin/python3')
  assert.match(pythonUnitDropin({}), /\.daily\.lock \/usr\/bin\/python3 /)
})

test('separate configured interpreters are individually preflighted and explicitly written per unit', () => {
  const a = encryptedPlan('/etc/dianjie/production.pub'), b = encryptedPlan('/etc/dianjie/uat.pub')
  b[0].config.backup_python = '/opt/dianjie-uat-venv/bin/python3'
  const commands = [], result = preflightEncryption([...a, ...b], '/staged', argv => commands.push(argv), helperOnlyIo)
  assert.equal(commands.length, 2)
  assert.deepEqual(result.interpreters, ['/opt/dianjie-backup-venv/bin/python3', '/opt/dianjie-uat-venv/bin/python3'])
  assert.equal(commands[0][4], a[0].config.backup_python);assert.equal(commands[1][4], b[0].config.backup_python)
  assert.ok(pythonUnitDropin(a[0].config).includes(a[0].config.backup_python))
  assert.ok(pythonUnitDropin(b[0].config).includes(b[0].config.backup_python))
})

test('loaded systemd interpreter mismatch blocks enabling or retiring timers', () => {
  const result = simulatedInstaller(true, false, true)
  assert.match(result.error.message, /Loaded backup unit does not use the verified interpreter/)
  assert.equal(result.commands.some(c => c[0] === 'systemctl' && ['enable','disable'].includes(c[1])), false)
})


test('reinstall preserves daily critical overrides and legacy archive paths with per-tier encryption/runtime', () => {
  // Execute the actual installer twice against an isolated in-memory systemd/filesystem.
  // The second invocation reads the files/symlinks written by the first, as a real upgrade would.
  const vm = require('node:vm'), files = new Map(), links = new Map(), writes = [], commands = []
  const environments = ['production','uat']
  for (const environment of environments) {
    files.set(`/etc/dianjie/backup-${environment}.json`, JSON.stringify({database_url_env:'DATABASE_URL',content_addressed:true,attachment_source:'oss',failure_webhook_env:'OLD_NOTIFY'}))
    files.set(`/etc/dianjie/backup-${environment}.env`, `DATABASE_URL=postgresql://synthetic@127.0.0.1/${environment==='production'?'dianjie_v4':'dianjie_v4_uat'}\n`)
    // Model the already-online daily policy under the retained weekly name.
    files.set(`/etc/dianjie/backup-${environment}-weekly.json`, JSON.stringify({directory:`/var/lib/dianjie-backups/${environment}-weekly`,maximum_age_hours:36,encryption:{public_key_file:`/etc/dianjie/${environment}.pub`},backup_python:`/opt/dianjie-${environment}-venv/bin/python3`}))
    files.set(`/etc/dianjie/backup-${environment}-monthly.json`, JSON.stringify({encryption:null,backup_python:'/old/monthly/interpreter'}))
  }
  const io = {
    constants:{COPYFILE_EXCL:1},
    statSync:()=>regular,
    lstatSync(file){if(links.has(file))return {...regular,isSymbolicLink:()=>true};return file.endsWith('.pub')||file.endsWith('.py')?regular:safeStat(file)},
    existsSync:file=>files.has(file)||links.has(file),
    readlinkSync:file=>links.get(file),
    readFileSync(file){if(files.has(file))return files.get(file);if(file.endsWith('backup-table-policy.json'))return JSON.stringify({version:1,monthly_only_tables:['logs']});if(file.endsWith('requirements-backup.txt'))return 'cryptography==46.0.5\n';if(file.endsWith('backup_envelope.py'))return '# synthetic reviewed helper\n';throw Error('Unexpected synthetic read: '+file)},
    mkdirSync(){},
    copyFileSync(from,to){files.set(to,files.get(from)||'preserved original')},
    writeFileSync(file,value){files.set(file,value);writes.push([file,value])},
    chmodSync(){},
    renameSync(from,to){files.set(to,files.get(from));files.delete(from)},
    symlinkSync(from,to){links.set(to,from)},
  }
  const child={execFileSync(command,args){commands.push([command,...args]);if(command==='systemctl'&&args[0]==='show'){const instance=args[1].replace('dianjie-backup@','').replace('.service',''),config=JSON.parse(files.get(`/etc/dianjie/backup-${instance}.json`));return pythonUnitDropin(config).split('ExecStart=\nExecStart=')[1].trim().replaceAll('%i',instance)}return ''}}
  const context={URL,module:{exports:{}},require(name){return name==='node:fs'?io:name==='node:child_process'?child:require(name)},process:{getuid:()=>0},console:{log(){}}}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'install-backup-schedules.cjs'),'utf8'),context)
  for (let attempt=0;attempt<2;attempt++) {
    context.module.exports.installSchedules('/staged')
    for(const environment of environments) {
      const prefix=`/etc/systemd/system/dianjie-backup@${environment}`
      const critical=JSON.parse(files.get(`/etc/dianjie/backup-${environment}-weekly.json`)),monthly=JSON.parse(files.get(`/etc/dianjie/backup-${environment}-monthly.json`))
      assert.equal(files.get(prefix+'-weekly.timer.d/schedule.conf'),'[Timer]\nOnCalendar=\nOnCalendar=*-*-* 02:30:00 Asia/Shanghai\n')
      assert.equal(files.get(prefix+'-monthly.timer.d/schedule.conf'),'[Timer]\nOnCalendar=\nOnCalendar=*-*-01 02:30:00 Asia/Shanghai\n')
      assert.equal(critical.directory,`/var/lib/dianjie-backups/${environment}-weekly`)
      assert.equal(critical.maximum_age_hours,36);assert.equal(critical.retention_days,63)
      assert.equal(critical.encryption.public_key_file,`/etc/dianjie/${environment}.pub`)
      assert.equal(critical.backup_python,`/opt/dianjie-${environment}-venv/bin/python3`)
      assert.equal(monthly.directory,`/var/lib/dianjie-backups/${environment}-monthly`)
      assert.equal(monthly.maximum_age_hours,840);assert.equal(monthly.retention_days,190)
      assert.equal(monthly.encryption,null);assert.equal(monthly.backup_python,'/old/monthly/interpreter')
      assert.equal(critical.failure_webhook_env,undefined);assert.equal(monthly.failure_webhook_env,undefined)
      assert.equal(links.get(`/etc/dianjie/backup-${environment}-weekly.env`),`/etc/dianjie/backup-${environment}.env`)
    }
  }
  const schedules=writes.filter(([file])=>file.endsWith('.timer.d/schedule.conf'))
  assert.equal(schedules.length,8)
  assert.equal(schedules.some(([,value])=>value.includes('Mon *-*-*')),false)
  assert.equal(new Set(schedules.map(([file])=>file)).size,4,'reinstall must not create new daily-named instances')
  assert.equal(commands.some(c=>c[0]==='systemctl'&&c.includes('restart')),false,'no application restart')
})
