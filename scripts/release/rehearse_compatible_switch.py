#!/usr/bin/env python3
"""Local-only compatible runtime switch. Never migrates or restores a database.

Requires separately pinned plan and verified compatibility manifest. Dry-run by
default. This is a rehearsal controller, not an online deployment controller.
"""
import argparse
import fcntl
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import urllib.parse

import rollback_compatibility as gate
import switch_journal


OPERATION = 'four-gap-compatible-recovery'
CONTEXT = 'colima-dianjie-huawei'
DB = 'dianjie-four-gap-db-20261028'
PORT = 3263
IMAGE_ID = re.compile(r'sha256:[a-f0-9]{64}')
AUDIT_PATH = Path(__file__).with_name('audit-four-gap-uat-delivery.py')
# Container base-image variables must not replace the host tool environment.
HOST_VARIABLES = {'PATH', 'HOME', 'CODEX_HOME', 'SHELL', 'USER', 'LOGNAME',
                  'HOSTNAME', 'PWD', 'SHLVL', '_', 'DOCKER_HOST', 'DOCKER_CONTEXT',
                  'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'}


def refuse(reason):
    raise gate.Refused(reason)


def read_pinned(path, expected):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        refuse('PINNED_FILE_UNSAFE')
    if not re.fullmatch(r'[a-f0-9]{64}', expected or '') or gate.checksum(path) != expected:
        refuse('PINNED_FILE_MISMATCH')
    return json.loads(path.read_text())


def validate_plan(plan):
    if plan.get('format') != 1 or plan.get('target') != 'isolated':
        refuse('ISOLATED_REHEARSAL_ONLY')
    if plan.get('dockerContext') != CONTEXT or plan.get('databaseContainer') != DB:
        refuse('LOCAL_RUNTIME_BOUNDARY_MISMATCH')
    if plan.get('webPort') != PORT or plan.get('healthVersion') != '1.3.3':
        refuse('LOCAL_ENTRYPOINT_MISMATCH')
    if not re.fullmatch(r'dianjie-compat-[a-z0-9-]{1,40}', plan.get('network', '')):
        refuse('LOCAL_NETWORK_IDENTITY_INVALID')
    for role in ('api', 'web'):
        item = plan.get('previous', {}).get(role, {})
        if not re.fullmatch(r'dianjie-compat-[a-z0-9-]{1,40}', item.get('name', '')):
            refuse('PREVIOUS_CONTAINER_NAME_INVALID')
        if not IMAGE_ID.fullmatch(item.get('imageId', '')):
            refuse('PREVIOUS_IMAGE_ID_INVALID')
    if plan['previous']['api']['name'] == plan['previous']['web']['name']:
        refuse('PREVIOUS_CONTAINER_ROLES_COLLIDE')


def docker(*args, env=None):
    result = subprocess.run(['docker', '--context', CONTEXT, *args], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=90, text=True)
    if result.returncode:
        # Docker diagnostics can include injected environment values.
        refuse('LOCAL_DOCKER_OPERATION_FAILED')
    return result.stdout


def inspect_container(name):
    return json.loads(docker('container', 'inspect', name))[0]


def validate_resume_record(record, plan, plan_sha256, images):
    switch_journal.validate(record)
    if (record['phase'] in switch_journal.TERMINAL
        or record['planSha256'] != plan_sha256
        or record['controllerSha256'] != gate.checksum(Path(__file__))
        or record['network'] != plan['network'] or record['candidateImages'] != images
        or any(record['previous'][role]['name'] != '/' + plan['previous'][role]['name']
               or record['previous'][role]['imageId'] != plan['previous'][role]['imageId']
               for role in ('api', 'web'))):
        refuse('INTERRUPTED_SWITCH_PINNED_IDENTITY_MISMATCH')


def validate_runtime(plan, database_url, keyring, interrupted=None):
    endpoint = json.loads(docker('context', 'inspect', CONTEXT))[0]['Endpoints']['docker']['Host']
    expected = 'unix://' + str(Path.home() / '.colima/dianjie-huawei/docker.sock')
    if endpoint != expected:
        refuse('LOCAL_DOCKER_SOCKET_REQUIRED')
    gate.database_env(database_url, 'isolated')
    url = urllib.parse.urlsplit(database_url)
    if (url.hostname, url.port, url.path) != ('127.0.0.1', 15449, '/dianjie_four_gap_test'):
        refuse('DEDICATED_SYNTHETIC_DATABASE_REQUIRED')
    db = inspect_container(DB)
    if db['Config'].get('Labels', {}).get('org.dianjie.operation') != 'four-gap-20261028' or not db['State']['Running']:
        refuse('SYNTHETIC_DATABASE_IDENTITY_INVALID')
    if db['HostConfig'].get('PortBindings') != {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '15449'}]}:
        refuse('SYNTHETIC_DATABASE_PORT_INVALID')
    network = json.loads(docker('network', 'inspect', plan['network']))[0]
    # Docker internal networks suppress host port publishing. Use a dedicated
    # bridge, with the Web port bound only to loopback and no API host port.
    if (network.get('Labels', {}).get('org.dianjie.operation') != OPERATION
        or network.get('Driver') != 'bridge' or network.get('Internal') is not False):
        refuse('DEDICATED_REHEARSAL_BRIDGE_REQUIRED')
    previous = {}
    candidate_api_env = None
    expected_members = {db['Id']}
    for role in ('api', 'web'):
        item = plan['previous'][role]
        meta = inspect_container(item['name'])
        labels = meta['Config'].get('Labels') or {}
        if (labels.get('org.dianjie.operation'), labels.get('org.dianjie.role')) != (OPERATION, role):
            refuse('PREVIOUS_CONTAINER_LABEL_MISMATCH')
        if (not interrupted and not meta['State']['Running']) or meta['Image'] != item['imageId']:
            refuse('PREVIOUS_RUNTIME_IDENTITY_MISMATCH')
        if interrupted and meta['Id'] != interrupted['previous'][role]['id']:
            refuse('PREVIOUS_CONTAINER_REPLACED_AFTER_INTERRUPTION')
        networks = set(meta['NetworkSettings']['Networks'])
        if (not interrupted and networks != {plan['network']}) or not networks <= {plan['network']}:
            refuse('PREVIOUS_RUNTIME_NETWORK_MISMATCH')
        bindings = meta['HostConfig'].get('PortBindings') or {}
        wanted = {} if role == 'api' else {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(PORT)}]}
        if bindings != wanted:
            refuse('PREVIOUS_RUNTIME_PORT_MISMATCH')
        previous[role] = meta
        if plan['network'] in networks:
            expected_members.add(meta['Id'])
    if interrupted:
        for role in ('api', 'web'):
            name = interrupted['candidateNames'][role]
            ids = docker('ps', '-aq', '--no-trunc', '--filter', 'name=^/' + name + '$').split()
            if not ids:
                continue
            if len(ids) != 1:
                refuse('INTERRUPTED_CANDIDATE_AMBIGUOUS')
            meta = inspect_container(ids[0]); labels = meta['Config'].get('Labels') or {}
            networks = set(meta['NetworkSettings']['Networks'])
            ports = {} if role == 'api' else {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(PORT)}]}
            if (meta['Name'] != '/' + name or meta['Image'] != interrupted['candidateImages'][role]
                or labels.get('org.dianjie.operation') != OPERATION
                or labels.get('org.dianjie.recovery-id') != interrupted['operationId']
                or labels.get('org.dianjie.role') != role or not networks <= {plan['network']}
                or (meta['HostConfig'].get('PortBindings') or {}) != ports):
                refuse('INTERRUPTED_CANDIDATE_IDENTITY_DRIFT')
            if plan['network'] in networks:
                expected_members.add(meta['Id'])
            if role == 'api':
                candidate_api_env = dict(item.split('=', 1) for item in meta['Config']['Env'] if '=' in item)
    if set(network.get('Containers', {})) != expected_members:
        refuse('UNEXPECTED_REHEARSAL_NETWORK_MEMBER')
    api_env = dict(item.split('=', 1) for item in previous['api']['Config']['Env'] if '=' in item)
    expected_db = urllib.parse.urlunsplit((url.scheme, url.netloc.replace('127.0.0.1:15449', 'db:5432'), url.path, url.query, url.fragment))
    required = {'DATABASE_URL': expected_db, 'PREVIEW_MODE': 'true',
                'PREVIEW_TENANT_SLUG': 'four-gap-local-20261028',
                'CMB_AUTOPAY_ENABLED': 'false', 'CMB_INTERNAL_TRANSFER_ENABLED': 'false',
                'SENTRY_DSN': '', 'NODE_ENV': 'production'}
    if any(api_env.get(k) != v for k, v in required.items()):
        refuse('SYNTHETIC_RUNTIME_CONFIGURATION_MISMATCH')
    if gate.keyring_fingerprint(api_env.get('CREDENTIAL_ENCRYPTION_KEYS', '')) != gate.keyring_fingerprint(keyring):
        refuse('RUNTIME_KEYRING_MISMATCH')
    if candidate_api_env is not None:
        if any(candidate_api_env.get(k) != v for k, v in required.items()):
            refuse('INTERRUPTED_CANDIDATE_CONFIGURATION_DRIFT')
        if gate.keyring_fingerprint(candidate_api_env.get('CREDENTIAL_ENCRYPTION_KEYS', '')) != gate.keyring_fingerprint(keyring):
            refuse('INTERRUPTED_CANDIDATE_KEYRING_DRIFT')
    return previous, api_env


def switch_runtime(adapter, verify_gate):
    """Keep old containers recoverable; verify again after write paths drain."""
    verify_gate()
    frozen = False
    try:
        # Mark before the call: even a partial drain must restore prior service.
        frozen = True
        adapter.drain()
        verify_gate()
        adapter.start_candidate()
        adapter.health()
        if hasattr(adapter, 'record'):
            adapter.record('switched')
        return {'status': 'local_compatible_runtime_switched', 'databaseRestored': False}
    except BaseException:
        if frozen:
            handlers = {s: signal.signal(s, signal.SIG_IGN) for s in (signal.SIGINT, signal.SIGTERM)}
            cleanup_failed = False
            try:
                try:
                    adapter.remove_candidate()
                except Exception:
                    cleanup_failed = True
                # Always attempt recovery; Docker will refuse occupied endpoints.
                try:
                    adapter.restore_previous()
                except Exception:
                    refuse('LOCAL_SWITCH_FAILED_PREVIOUS_SERVICE_RESTORE_FAILED')
                if cleanup_failed:
                    refuse('PREVIOUS_SERVICE_RESTORED_CANDIDATE_CLEANUP_INCOMPLETE')
                if hasattr(adapter, 'record'):
                    adapter.record('previous_restored')
            finally:
                for signum, handler in handlers.items():
                    signal.signal(signum, handler)
        raise


class DockerSwitch:
    def __init__(self, plan, previous, api_env, images):
        self.plan, self.previous, self.api_env, self.images = plan, previous, api_env, images
        suffix = os.urandom(6).hex()
        self.operation_id = suffix
        self.names = {role: 'dianjie-compat-recovery-' + role + '-' + suffix for role in ('api', 'web')}
        self.attempted = []
        self.journal = None
        self.resuming = False

    def record(self, phase):
        if self.journal:
            self.journal.write(phase)

    def enable_journal(self, path, plan_sha256):
        self.journal = switch_journal.Journal(path, {
            'operationId': self.operation_id, 'planSha256': plan_sha256,
            'controllerSha256': gate.checksum(Path(__file__)),
            'previous': {role: {'id': meta['Id'], 'imageId': meta['Image'],
                                'name': meta['Name']} for role, meta in self.previous.items()},
            'candidateNames': self.names, 'candidateImages': self.images,
            'network': self.plan['network'],
        })

    def drain(self):
        if self.resuming:
            # Remove only reconciled partial candidates, then repeat the normal
            # drain and gate. Never trust a checkpoint as proof of live state.
            self.remove_candidate()
        self.record('draining')
        for role in ('web', 'api'):
            docker('stop', '--time', '30', self.previous[role]['Id'])
        for role in ('api', 'web'):
            if inspect_container(self.previous[role]['Id'])['State']['Running']:
                refuse('PREVIOUS_RUNTIME_NOT_DRAINED')
            if self.plan['network'] in inspect_container(self.previous[role]['Id'])['NetworkSettings']['Networks']:
                docker('network', 'disconnect', self.plan['network'], self.previous[role]['Id'])

    def resume_journal(self, path, record):
        self.journal = switch_journal.Journal.resume(path, record)
        self.operation_id = record['operationId']
        self.names = dict(record['candidateNames'])
        self.attempted = ['api', 'web']
        self.resuming = True

    def start_candidate(self):
        for role in ('api', 'web'):
            args = ['create', '--pull', 'never', '--platform', 'linux/amd64',
                    '--name', self.names[role], '--network', self.plan['network'],
                    '--label', 'org.dianjie.operation=' + OPERATION,
                    '--label', 'org.dianjie.recovery-id=' + self.operation_id,
                    '--label', 'org.dianjie.role=' + role]
            env = os.environ.copy()
            if role == 'api':
                args += ['--network-alias', 'api']
                application_env = {k: v for k, v in self.api_env.items() if k not in HOST_VARIABLES}
                env.update(application_env)
                for name in sorted(application_env):
                    args += ['--env', name]
            else:
                args += ['--publish', f'127.0.0.1:{PORT}:3000']
            self.attempted.append(role)
            self.record('creating_' + role)
            cid = docker(*args, self.images[role], env=env).strip()
            docker('start', cid)

    def health(self):
        for _ in range(30):
            connection = http.client.HTTPConnection('127.0.0.1', PORT, timeout=3)
            try:
                connection.request('GET', '/api/health')
                response = connection.getresponse()
                data = json.loads(response.read())
                if response.status == 200 and (data.get('status'), data.get('db'), data.get('version')) == ('ok', 'ok', self.plan['healthVersion']):
                    for role in ('api', 'web'):
                        meta = inspect_container(self.names[role])
                        if meta['Image'] != self.images[role] or not meta['State']['Running']:
                            refuse('RECOVERY_RUNTIME_IDENTITY_MISMATCH')
                    return
            except (OSError, ValueError, http.client.HTTPException):
                pass
            finally:
                connection.close()
            time.sleep(1)
        refuse('RECOVERY_RUNTIME_HEALTH_FAILED')

    def remove_candidate(self):
        self.record('cleaning_candidate')
        failures = []
        for role in reversed(self.attempted):
            try:
                # Query by pre-recorded name even when create returned no result.
                ids = docker('ps', '-aq', '--filter', 'name=^/' + self.names[role] + '$').split()
                for cid in ids:
                    meta = inspect_container(cid)
                    labels = meta['Config'].get('Labels') or {}
                    if (meta['Name'] != '/' + self.names[role]
                        or meta['Image'] != self.images[role]
                        or labels.get('org.dianjie.operation') != OPERATION
                        or labels.get('org.dianjie.recovery-id') != self.operation_id
                        or labels.get('org.dianjie.role') != role):
                        refuse('CANDIDATE_CLEANUP_IDENTITY_MISMATCH')
                    docker('rm', '--force', cid)
            except Exception:
                failures.append(role)
        if failures:
            refuse('CANDIDATE_CLEANUP_INCOMPLETE_' + '_'.join(failures).upper())

    def restore_previous(self):
        self.record('restoring_previous')
        for role in ('api', 'web'):
            cid = self.previous[role]['Id']
            meta = inspect_container(cid)
            if self.plan['network'] not in meta['NetworkSettings']['Networks']:
                aliases = ['--alias', 'api'] if role == 'api' else []
                docker('network', 'connect', *aliases, self.plan['network'], cid)
            if not meta['State']['Running']:
                docker('start', cid)
        # Health must verify the restored pair, not the failed candidate.
        names, images = self.names, self.images
        try:
            self.names = {role: self.previous[role]['Id'] for role in ('api', 'web')}
            self.images = {role: self.previous[role]['Image'] for role in ('api', 'web')}
            self.health()
        finally:
            self.names, self.images = names, images


def validate_recovery_candidate(manifest, plan):
    if manifest.get('packageKind') not in ('compatible-rollback', 'compatible-recovery'):
        refuse('FORWARD_PACKAGE_IS_NOT_COMPATIBLE_RECOVERY')
    images = manifest.get('runtimeImages', {})
    if not isinstance(images, dict) or set(images) != {'api', 'web'} or any(not isinstance(v, str) or not IMAGE_ID.fullmatch(v) for v in images.values()):
        refuse('PINNED_RECOVERY_IMAGES_REQUIRED')
    identity = gate.recovery_identity(manifest)
    previous_images = {role:plan['previous'][role]['imageId'] for role in ('api','web')}
    if identity is None:
        # Historical software rollback semantics remain fail-closed.
        if images == previous_images:
            refuse('FORWARD_IMAGE_PAIR_RELABEL_REFUSED')
    elif identity['sourceImages'] != previous_images:
        refuse('RECOVERY_SOURCE_RUNTIME_MISMATCH')
    return images, identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--approved-plan-sha256', required=True)
    parser.add_argument('--candidate-root', type=Path, required=True)
    parser.add_argument('--compat-manifest', type=Path, required=True)
    parser.add_argument('--approved-manifest-sha256', required=True)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--resume', action='store_true', help='Reconcile and resume the exact interrupted local operation')
    args = parser.parse_args()
    try:
        plan = read_pinned(args.plan, args.approved_plan_sha256)
        validate_plan(plan)
        manifest = read_pinned(args.compat_manifest, args.approved_manifest_sha256)
        images, recovery_identity = validate_recovery_candidate(manifest, plan)
        # The executable controller and gate must be part of the approved package.
        for source in (Path(__file__), Path(gate.__file__), Path(switch_journal.__file__), AUDIT_PATH):
            relative = 'scripts/release/' + source.name
            if manifest.get('artifacts', {}).get(relative) != gate.checksum(source):
                refuse('RECOVERY_CONTROLLER_NOT_PINNED')
        if manifest.get('rollbackDriver') != 'scripts/release/' + Path(__file__).name:
            refuse('RECOVERY_DRIVER_IDENTITY_MISMATCH')
        spec = importlib.util.spec_from_file_location('oci_audit', AUDIT_PATH)
        audit = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(audit)
        for role in ('api', 'web'):
            archive = gate.safe_file(args.candidate_root, role + '/application.tar.gz')
            if audit.image_identity(archive) != images[role]:
                refuse('RECOVERY_ARCHIVE_IMAGE_MISMATCH')
        database_url = os.environ.get('DATABASE_URL', '')
        keyring = os.environ.get('CREDENTIAL_ENCRYPTION_KEYS', '')
        database_env = gate.database_env(database_url, 'isolated')

        def verify():
            state = gate.inspect_state(database_env)
            return gate.verify_package(args.candidate_root, args.compat_manifest, state,
                mode='publish', runtime_key_ids=gate.keyring_ids(keyring),
                runtime_keyring_sha256=gate.keyring_fingerprint(keyring),
                approved_manifest_sha256=args.approved_manifest_sha256)

        # A fixed per-user lock prevents parallel switches across different plans.
        lock_path = Path.home() / '.codex/dianjie-compatible-rehearsal.lock'
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            journal_path = lock_path.with_suffix('.journal.json')
            interrupted = None
            if args.resume:
                interrupted = switch_journal.read(journal_path)
                validate_resume_record(interrupted, plan, args.approved_plan_sha256, images)
            else:
                switch_journal.check_no_pending(journal_path)
            previous, api_env = validate_runtime(plan, database_url, keyring, interrupted)
            for image in images.values():
                info = json.loads(docker('image', 'inspect', image))[0]
                if info['Id'] != image or (info['Os'], info['Architecture']) != ('linux', 'amd64'):
                    refuse('RECOVERY_IMAGE_IDENTITY_MISMATCH')
            verify()
            if not args.execute:
                result = {'status': 'local_resume_preflight_passed' if args.resume else 'local_switch_preflight_passed', 'runtimeModified': False}
            else:
                def handle_termination(_signum, _frame):
                    raise KeyboardInterrupt()
                old_term = signal.signal(signal.SIGTERM, handle_termination)
                try:
                    adapter = DockerSwitch(plan, previous, api_env, images)
                    if interrupted:
                        adapter.resume_journal(journal_path, interrupted)
                    else:
                        adapter.enable_journal(journal_path, args.approved_plan_sha256)
                    result = switch_runtime(adapter, verify)
                finally:
                    signal.signal(signal.SIGTERM, old_term)
            if recovery_identity is not None:
                result = {**result, 'recoveryIdentity':recovery_identity}
            print(json.dumps(result))
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({'status': 'refused', 'reason': str(error) if isinstance(error, (gate.Refused, switch_journal.JournalError)) else 'LOCAL_SWITCH_FAILED'}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
