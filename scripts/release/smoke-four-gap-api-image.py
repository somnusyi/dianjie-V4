#!/usr/bin/env python3
"""Boot the local 1.3.3 API image on the dedicated synthetic DB network."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import urllib.parse


ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / 'tmp/four-gap-20261028'
IMAGE = 'dianjie-four-gap-api:local-v133-b'
CONTAINER = 'dianjie-four-gap-db-20261028'
DOCKER = ['docker', '--context', 'colima-dianjie-huawei']


def call(*args, env=None):
    return subprocess.run(DOCKER + list(args), env=env, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def main():
    db = json.loads((WORK / 'private-db.json').read_text())
    url = urllib.parse.urlsplit(db['url'])
    if db['container'] != CONTAINER or (url.hostname, url.port, url.path) != ('127.0.0.1', 15449, '/dianjie_four_gap_test'):
        raise SystemExit('Dedicated database boundary invalid')
    check = call('inspect', CONTAINER)
    if check.returncode:
        raise SystemExit('Dedicated database container unavailable')
    meta = json.loads(check.stdout)[0]
    if meta['State']['Running'] is not True or meta['Config']['Labels'].get('org.dianjie.operation') != 'four-gap-20261028':
        raise SystemExit('Dedicated database container identity invalid')
    runtime = json.loads((WORK / 'runtime-private.json').read_text())
    env = os.environ.copy()
    env.update({
        'DATABASE_URL': urllib.parse.urlunsplit((url.scheme, url.netloc.replace(':15449', ':5432'), url.path, url.query, url.fragment)),
        'JWT_SECRET': runtime['jwt'],
        'JWT_REFRESH_SECRET': runtime['refresh'],
        'CREDENTIAL_ENCRYPTION_KEYS': json.dumps({'current': 'local', 'keys': {'local': runtime['key']}}),
    })
    name = 'dianjie-four-gap-api-smoke-' + secrets.token_hex(4)
    run = call('run', '--rm', '-d', '--platform', 'linux/amd64', '--name', name,
               '--network', 'container:' + CONTAINER,
               '-e', 'DATABASE_URL', '-e', 'JWT_SECRET', '-e', 'JWT_REFRESH_SECRET', '-e', 'CREDENTIAL_ENCRYPTION_KEYS',
               '-e', 'API_HOST=127.0.0.1', '-e', 'API_PORT=4550', '-e', 'NODE_ENV=production',
               '-e', 'PREVIEW_MODE=true', '-e', 'PREVIEW_TENANT_SLUG=four-gap-local-20261028',
               '-e', 'BROWSER_SESSION_ENV=local_four_gap', '-e', 'BROWSER_SESSION_ORIGINS=http://127.0.0.1:3259',
               '-e', 'BROWSER_SESSION_ALLOW_LOCAL_HTTP=true', '-e', 'CMB_AUTOPAY_ENABLED=false',
               '-e', 'CMB_INTERNAL_TRANSFER_ENABLED=false', '-e', 'SENTRY_DSN=', IMAGE, env=env)
    if run.returncode:
        raise SystemExit('Isolated API container did not start')
    try:
        probe = "fetch('http://127.0.0.1:4550/health').then(r=>r.json()).then(x=>console.log(JSON.stringify({status:x.status,db:x.db,version:x.version}))).catch(()=>process.exit(1))"
        for _ in range(20):
            result = call('exec', name, 'node', '-e', probe)
            if result.returncode == 0:
                health = json.loads(result.stdout.strip())
                if health != {'status': 'ok', 'db': 'ok', 'version': '1.3.3'}:
                    raise SystemExit('Isolated API health/version mismatch')
                print(json.dumps({'status': 'isolated_api_boot_passed', 'health': health, 'image': IMAGE}))
                return
            time.sleep(1)
        raise SystemExit('Isolated API health did not become ready')
    finally:
        call('stop', name)


if __name__ == '__main__':
    main()
