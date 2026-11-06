#!/usr/bin/env python3
"""Private database + attachment backups; restoration always targets a new local test DB."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import socket
import subprocess
import tarfile
import tempfile
import urllib.parse
import urllib.request
import uuid
import traceback
from contextlib import contextmanager

# Optional dependency remains lazy so an old unencrypted backup job never silently stops.
def envelope():
    import backup_envelope
    return backup_envelope

def public_recipient(config):
    item=config.get("encryption")
    if item is None:return None
    if not isinstance(item,dict) or set(item)!={"public_key_file"}:
        raise ValueError("Backup encryption requires only a public-key file; never a server-side recovery key")
    recipient=Path(item["public_key_file"])
    envelope().load_public(recipient)
    return recipient

@contextmanager
def readable_archive(archive,recovery_key=None):
    archive=Path(archive)
    if archive.name.endswith(".enc"):
        if not recovery_key:raise ValueError("Encrypted archive needs an offline recovery private key for content verification")
        with tempfile.TemporaryDirectory(prefix="dianjie-decrypt-") as temp:
            plain=Path(temp)/"archive.tar.gz"
            envelope().recover_file(archive,plain,recovery_key)
            yield plain
    else:yield archive

def attachment_blob(archive,checksum):
    return Path(archive).resolve().parent.parent/"blobs"/checksum

@contextmanager
def readable_blob(archive,checksum,recovery_key=None):
    blob=attachment_blob(archive,checksum)
    # Encrypted copies are preferred. Plain legacy copies remain recoverable until explicitly retired.
    encrypted=Path(str(blob)+".enc")
    if encrypted.exists() and (recovery_key or not blob.exists()):
        if not recovery_key:raise ValueError("Encrypted attachment needs an offline recovery private key")
        with tempfile.TemporaryDirectory(prefix="dianjie-blob-decrypt-") as temp:
            plain=Path(temp)/"attachment"
            envelope().recover_file(encrypted,plain,recovery_key)
            if digest(plain)!=checksum:raise ValueError("Attachment plaintext checksum mismatch")
            yield plain
    else:
        if blob.is_symlink() or not blob.is_file() or digest(blob)!=checksum:raise ValueError("Attachment blob integrity failed")
        yield blob


def run(argv, env=None):
    result = subprocess.run(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        # Never return argv, server responses, URLs or DB error text containing credentials.
        raise RuntimeError(f'{Path(argv[0]).name} failed ({result.returncode})')
    return result.stdout


def connection(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ('postgres', 'postgresql') or not parsed.hostname or not parsed.path[1:]:
        raise ValueError('Invalid PostgreSQL connection')
    env = dict(os.environ)
    env.update(PGHOST=parsed.hostname, PGPORT=str(parsed.port or 5432),
               PGDATABASE=parsed.path[1:], PGUSER=urllib.parse.unquote(parsed.username or ''),
               PGPASSWORD=urllib.parse.unquote(parsed.password or ''))
    query = urllib.parse.parse_qs(parsed.query)
    if 'sslmode' in query:
        env['PGSSLMODE'] = query['sslmode'][0]
    return parsed, env


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def inventory(directory):
    directory = directory.resolve()
    if not directory.is_dir():
        raise ValueError('Attachment source directory is missing')
    result = {}
    def denied(error):
        raise error
    for parent, dirs, files in os.walk(directory, onerror=denied, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(parent) / name
            if path.is_symlink():
                raise ValueError('Attachment symlinks are not supported')
            if path.is_file():
                result[path.relative_to(directory).as_posix()] = digest(path)
    result = dict(sorted(result.items()))
    return result


def notify(config, success):
    name = config.get('failure_webhook_env')
    if success or not name:
        return False
    url = os.environ.get(name, '')
    if not url:
        return False
    p = urllib.parse.urlsplit(url)
    local = p.hostname in ('127.0.0.1', 'localhost', '::1')
    if p.scheme != 'https' and not (config.get('isolated_test') and local and p.scheme == 'http'):
        raise ValueError('Failure notification requires HTTPS')
    body = json.dumps({'event': 'dianjie_backup_failed', 'host': socket.gethostname(),
                       'at': dt.datetime.now(dt.timezone.utc).isoformat(),
                       'action': 'Check the private backup service log and last verified backup.'}).encode()
    request = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status >= 300:
            raise RuntimeError('Failure notification was not accepted')
    return True


def offsite(config, archive):
    target = config.get('offsite')
    if not target:
        if config.get('offsite_deferred'):
            return {'status': 'local_only_offsite_deferred'}
        if config.get('isolated_test'):
            return {'status': 'local_only_not_offsite'}
        raise ValueError('An independent backup destination is required')
    host = target['host']
    directory = target['directory']
    if not re.fullmatch(r'[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+', host):
        raise ValueError('Use an SSH user@host backup destination')
    if host.split('@')[1] in ('localhost', '127.0.0.1', socket.gethostname()):
        raise ValueError('Backup destination must be on another machine')
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', directory) or '..' in Path(directory).parts:
        raise ValueError('Invalid remote backup directory')
    ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes']
    run(ssh + [host, f'umask 077; mkdir -p {shlex.quote(directory)}; chmod 700 {shlex.quote(directory)}'])
    destination = directory.rstrip('/') + '/' + archive.name
    run(['rsync', '--chmod=F600,D700', '-e', 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
         '--', str(archive), host + ':' + destination])
    actual = run(ssh + [host, 'sha256sum -- ' + shlex.quote(destination)]).decode().split()[0]
    if actual != digest(archive):
        raise ValueError('Remote backup checksum mismatch')
    return {'status': 'copied_and_verified', 'sha256': actual}


def expire_archives(destination, days, encrypted_only=False):
    if not days:
        return 0
    if not isinstance(days, int) or days < 7:
        raise ValueError('Backup retention must be at least seven days')
    cutoff = dt.datetime.now(dt.timezone.utc).timestamp() - days * 86400
    owned = sorted((p for p in destination.glob('dianjie-*.tar.gz*')
                    if re.fullmatch(r'dianjie-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.gz(?:\.enc)?', p.name)
                    and (not encrypted_only or p.name.endswith('.enc'))
                    and p.is_file() and not p.is_symlink()), key=lambda p: p.stat().st_mtime, reverse=True)
    expired = 0
    # Keep at least two newest archives. Shared blobs are never pruned here.
    for path in owned[2:]:
        if path.stat().st_mtime < cutoff:
            path.unlink()
            if path.name.endswith('.enc'):
                proof=Path(str(path)+'.proof.json')
                if proof.is_file() and not proof.is_symlink():proof.unlink()
            expired += 1
    return expired


def table_plan(config, env):
    """Keep schema intact and close the critical data set over referenced tables."""
    tier = config.get('backup_tier', 'full')
    if tier not in ('full', 'critical'):
        raise ValueError('Unknown backup tier')
    if tier == 'full':
        return {'scope': 'all_tables', 'excludedDataTables': [], 'promotedDependencyTables': []}
    policy = json.loads(Path(config['table_policy']).read_text())
    candidates = set(policy['monthly_only_tables'])
    if policy.get('version') != 1 or not candidates or not all(
            isinstance(name, str) and re.fullmatch(r'[a-z][a-z0-9_]*', name) for name in candidates):
        raise ValueError('Invalid backup table policy')
    catalog = json.loads(run(['psql', '-X', '-A', '-t', '-c', """
        SELECT json_build_object(
          'tables', (SELECT coalesce(json_agg(tablename), '[]'::json)
                     FROM pg_tables WHERE schemaname = 'public'),
          'references', (SELECT coalesce(json_agg(json_build_array(child.relname, parent.relname)), '[]'::json)
            FROM pg_constraint fk
            JOIN pg_class child ON child.oid = fk.conrelid
            JOIN pg_namespace cn ON cn.oid = child.relnamespace
            JOIN pg_class parent ON parent.oid = fk.confrelid
            JOIN pg_namespace pn ON pn.oid = parent.relnamespace
            WHERE fk.contype = 'f' AND cn.nspname = 'public' AND pn.nspname = 'public'))
        """], env).decode())
    tables = set(catalog['tables'])
    if not tables or not candidates.issubset(tables):
        raise ValueError('Backup table policy does not match the current schema')
    excluded = set(candidates)
    while True:
        required = {parent for child, parent in catalog['references']
                    if child not in excluded and parent in excluded}
        if not required:
            break
        excluded -= required
    return {'scope': 'critical_tables_with_reference_dependencies',
            'includedDataTables': sorted(tables - excluded),
            'excludedDataTables': sorted(excluded),
            'promotedDependencyTables': sorted(candidates - excluded),
            'tablePolicyVersion': 1}


def check_freshness(config, result, now=None):
    maximum = config.get('maximum_age_hours', 26)
    if not isinstance(maximum, (int, float)) or isinstance(maximum, bool) or not 1 <= maximum <= 24 * 40:
        raise ValueError('Invalid backup freshness interval')
    age = (now or dt.datetime.now(dt.timezone.utc)) - dt.datetime.fromisoformat(result['at'])
    if age.total_seconds() < -300 or age.total_seconds() > maximum * 3600:
        raise ValueError('Last verified backup is overdue or has an invalid timestamp')


def backup(config):
    _, env = connection(os.environ[config.get('database_url_env', 'DATABASE_URL')])
    destination = Path(config['directory']).resolve()
    use_oss = config.get('attachment_source') == 'oss'
    content_addressed = bool(config.get('content_addressed'))
    if content_addressed and config.get('offsite'):
        raise ValueError('Content-addressed backups require the complete blob set at the offsite destination')
    recipient=public_recipient(config)
    attachments = Path(config.get('attachment_directory', '.')).resolve()
    if not use_oss and not attachments.is_dir():
        raise ValueError('An attachment snapshot directory is required')
    if not use_oss and (destination == attachments or attachments in destination.parents):
        raise ValueError('Backup output cannot be inside attachments')
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination.chmod(0o700)
    if shutil.disk_usage(destination).free < int(config.get('minimum_free_bytes', 1024 ** 3)):
        raise ValueError('Insufficient free disk space for a safe backup')
    # Only one scheduled/manual snapshot can operate on this repository at a time.
    import fcntl
    with (destination / '.backup.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('A backup is already running')
        with tempfile.TemporaryDirectory(prefix='.snapshot-', dir=destination) as temp:
            stage = Path(temp)
            if use_oss:
                oss_tool = str(Path(__file__).with_name('snapshot-oss.mjs'))
                node = config.get('node_binary', 'node')
                run([node, oss_tool, 'capture', str(stage / 'attachments'), config.get('oss_prefix', '')] + ([str(destination.parent / 'blobs')] if content_addressed and not recipient else []))
                local_source = config.get('local_attachment_directory')
                local_before = None
                if local_source:
                    local_before = inventory(Path(local_source))
                    shutil.copytree(local_source, stage / 'attachments' / 'local-receipts')
                before = inventory(stage / 'attachments')
            else:
                before = inventory(attachments)
                shutil.copytree(attachments, stage / 'attachments')
            plan = table_plan(config, env)
            exclusions = ['--exclude-table-data=public.' + name for name in plan['excludedDataTables']]
            run(['pg_dump', '--lock-wait-timeout=60s', '--format=custom', '--no-owner', '--no-acl',
                 *exclusions, '--file', str(stage / 'database.dump')], env)
            run(['pg_restore', '--list', str(stage / 'database.dump')])
            if config.get('backup_tier') == 'critical' and table_plan(config, env) != plan:
                raise ValueError('Table dependencies changed during backup; retry the snapshot')
            if use_oss:
                run([node, oss_tool, 'check', str(stage / 'attachments')])
                if local_before is not None and inventory(Path(local_source)) != local_before:
                    raise ValueError('Local attachments changed during backup')
            elif inventory(attachments) != before:
                raise ValueError('Attachments changed during backup; retry the snapshot')
            if inventory(stage / 'attachments') != before:
                raise ValueError('Attachments changed during backup; retry the snapshot')
            if content_addressed:
                cache = destination.parent / 'blobs'
                cache.mkdir(exist_ok=True, mode=0o700)
                for relative, checksum in before.items():
                    blob = cache / checksum
                    if recipient:
                        encrypted=Path(str(blob)+'.enc')
                        if encrypted.exists():
                            proof=envelope().verify_cipher(encrypted,checksum)
                            if proof['recipientKeyId']!=envelope()._key_id(envelope().load_public(recipient)):raise ValueError('Existing encrypted attachment uses another recovery key; explicit key rotation required')
                        else:envelope().seal_file(stage/'attachments'/relative,encrypted,recipient)
                    elif blob.exists():
                        if blob.is_symlink() or digest(blob) != checksum:
                            raise ValueError('Stored attachment blob integrity failed')
                    else:
                        os.link(stage / 'attachments' / relative, blob)
                        blob.chmod(0o600)
                if use_oss:
                    index = json.loads((stage / 'attachments' / 'oss-inventory.json').read_text())
                    for obj in index['objects']:
                        obj['sha256'] = before[obj['file']]
                    (cache / 'oss-index.json').write_text(json.dumps(index))
                    (cache / 'oss-index.json').chmod(0o600)
            manifest = {'format': 2 if content_addressed else 1, 'at': dt.datetime.now(dt.timezone.utc).isoformat(),
                        'database': env['PGDATABASE'], **plan,
                        'databaseSha256': digest(stage / 'database.dump'), 'attachments': before}
            (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2))
            name = 'dianjie-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8] + '.tar.gz'
            # Plaintext staging is private and removed automatically, never published alongside new encrypted backups.
            archive = (stage if recipient else destination) / name
            with tarfile.open(archive.with_suffix('.partial'), 'w:gz') as tar:
                for name in (['database.dump', 'manifest.json'] if content_addressed else ['database.dump', 'manifest.json', 'attachments']):
                    tar.add(stage / name, arcname=name)
            archive.with_suffix('.partial').chmod(0o600)
            archive.with_suffix('.partial').replace(archive)
            verify_archive(archive, blob_base=destination) if not recipient else verify_staged(stage,manifest)
            if recipient:
                sealed=destination/(archive.name+'.enc')
                envelope().seal_file(archive,sealed,recipient)
                archive=sealed
            remote = offsite(config, archive)
            expired = expire_archives(destination, config.get('retention_days'), encrypted_only=bool(recipient))
            result = {'expiredArchiveCount': expired, 'at': manifest['at'], 'backupTier': config.get('backup_tier', 'full'),
                      'scope': plan['scope'], 'excludedDataTables': plan['excludedDataTables'],
                      'attachmentMode': 'content_addressed' if content_addressed else 'embedded',
                      'archive': archive.name, 'sha256': digest(archive), 'encryption': 'public_key_envelope_v1' if recipient else 'legacy_unencrypted', 'attachmentCount': len(before), **remote}
            (destination / 'last-result.json').write_text(json.dumps(result, indent=2))
            (destination / 'last-result.json').chmod(0o600)
            return result


def extract_checked(archive, target):
    with tarfile.open(archive, 'r:gz') as tar:
        names = set()
        for member in tar.getmembers():
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                raise ValueError('Unsafe backup member')
            canonical = path.as_posix()
            if canonical in names or not path.parts or path.parts[0] not in ('database.dump', 'manifest.json', 'attachments'):
                raise ValueError('Duplicate backup member')
            names.add(canonical)
        # Extract only regular files/directories, without restoring links, owners or modes.
        # Works with the Python 3 versions already used by the application servers.
        for member in tar.getmembers():
            output = target / Path(member.name)
            if member.isdir():
                output.mkdir(parents=True, exist_ok=True, mode=0o700)
            else:
                output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with tar.extractfile(member) as source, output.open('xb') as destination:
                    shutil.copyfileobj(source, destination)
                output.chmod(0o600)


def verify_staged(stage,manifest):
    if manifest['format'] not in (1,2) or digest(stage/'database.dump')!=manifest['databaseSha256']:
        raise ValueError('Database archive integrity failed')
    if inventory(stage/'attachments')!=manifest['attachments']:
        raise ValueError('Attachment archive integrity failed')
    run(['pg_restore','--list',str(stage/'database.dump')])


def verify_archive(archive,recovery_key=None,blob_base=None):
    archive=Path(archive)
    with readable_archive(archive,recovery_key) as plain, tempfile.TemporaryDirectory(prefix='dianjie-verify-') as temp:
        target=Path(temp)
        extract_checked(plain,target)
        manifest=json.loads((target/'manifest.json').read_text())
        if manifest['format'] not in (1,2) or digest(target/'database.dump')!=manifest['databaseSha256']:
            raise ValueError('Database archive integrity failed')
        if manifest['format']==2:
            for relative,checksum in manifest['attachments'].items():
                path=Path(relative)
                if path.is_absolute() or '..' in path.parts or not path.parts or not re.fullmatch(r'[a-f0-9]{64}',checksum):
                    raise ValueError('Unsafe attachment manifest')
                origin=(Path(blob_base)/archive.name) if blob_base else archive
                with readable_blob(origin,checksum,recovery_key):pass
        elif inventory(target/'attachments')!=manifest['attachments']:
            raise ValueError('Attachment archive integrity failed')
        run(['pg_restore','--list',str(target/'database.dump')])
        return manifest


def restore(archive, target_url_env, attachment_target, recovery_key=None):
    parsed, env = connection(os.environ[target_url_env])
    if parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or parsed.port != 15439:
        raise ValueError('Recovery rehearsal is restricted to the isolated local PostgreSQL instance')
    if not re.fullmatch(r'dianjie_[a-z0-9_]+_restore_test', env['PGDATABASE']):
        raise ValueError('Recovery must use a new dianjie_*_restore_test database')
    output = Path(attachment_target).resolve()
    if output.exists():
        raise ValueError('Attachment restore target must not exist')
    manifest = verify_archive(archive,recovery_key)
    with readable_archive(archive,recovery_key) as plain, tempfile.TemporaryDirectory(prefix='dianjie-restore-') as temp:
        stage = Path(temp)
        extract_checked(plain, stage)
        # createdb fails when the target already exists; never clean/drop a populated database.
        run(['createdb', '--', env['PGDATABASE']], env)
        run(['pg_restore', '--exit-on-error', '--no-owner', '--no-acl', '--dbname', env['PGDATABASE'], str(stage / 'database.dump')], env)
        if manifest['format'] == 2:
            output.mkdir(mode=0o700)
            for relative, checksum in manifest['attachments'].items():
                path = output / relative
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with readable_blob(archive,checksum,recovery_key) as blob:shutil.copyfile(blob,path)
                path.chmod(0o600)
        else:
            shutil.copytree(stage / 'attachments', output)
        output.chmod(0o700)
        if inventory(output) != manifest['attachments']:
            raise ValueError('Restored attachments do not match the manifest')
    return {'status': 'restored_to_new_isolated_database', 'attachmentCount': len(manifest['attachments'])}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['backup', 'verify', 'restore', 'status'])
    parser.add_argument('--config')
    parser.add_argument('--archive')
    parser.add_argument('--target-url-env', default='RESTORE_DATABASE_URL')
    parser.add_argument('--attachment-target')
    parser.add_argument('--recovery-private-key-file')
    args = parser.parse_args()
    config = {}
    try:
        config = json.loads(Path(args.config).read_text()) if args.config else {}
        if args.action == 'backup':
            result = backup(config)
        elif args.action == 'status':
            attempt_path = Path(config['directory']) / 'last-attempt.json'
            if attempt_path.exists() and json.loads(attempt_path.read_text()).get('status') == 'failed':
                raise ValueError('Latest backup attempt failed')
            result = json.loads((Path(config['directory']) / 'last-result.json').read_text())
            check_freshness(config, result)
            result = {**result, 'fresh': True}
        elif args.action == 'verify':
            result = {'status': 'verified', 'attachmentCount': len(verify_archive(Path(args.archive),args.recovery_private_key_file)['attachments'])}
        else:
            result = restore(Path(args.archive), args.target_url_env, args.attachment_target,args.recovery_private_key_file)
        if args.action == 'backup':
            (Path(config['directory']) / 'last-attempt.json').write_text(json.dumps({'status': 'succeeded', 'at': dt.datetime.now(dt.timezone.utc).isoformat()}))
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({'status': 'failed', 'reason': type(error).__name__, 'location': [f'{f.name}:{f.lineno}' for f in traceback.extract_tb(error.__traceback__)][-4:]}), file=__import__('sys').stderr)
        if args.action == 'backup':
            try:
                folder = Path(config['directory'])
                if folder.is_dir():
                    (folder / 'last-attempt.json').write_text(json.dumps({'status': 'failed', 'reason': type(error).__name__, 'at': dt.datetime.now(dt.timezone.utc).isoformat()}))
            except Exception:
                pass
            try:
                notified = notify(config, False)
                print(json.dumps({'failureNotificationSent': notified}), file=__import__('sys').stderr)
            except Exception:
                print('{"failureNotificationSent": false, "notificationFailed": true}', file=__import__('sys').stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
