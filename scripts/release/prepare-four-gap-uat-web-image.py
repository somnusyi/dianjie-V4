#!/usr/bin/env python3
"""Create a Linux UAT Web image overlay context from reviewed build output."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


ROOT = Path(__file__).resolve().parents[2]
BASE_IMAGE = 'sha256:2f758c5284c1edfe5d4c8eb5e8d7ccfe2ccf30d6e1ca75daa41595c4a5c7ce01'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree(root):
    files = sorted(path for path in root.rglob('*') if path.is_file() or path.is_symlink())
    h = hashlib.sha256()
    for path in files:
        if path.is_symlink():
            if path.readlink().is_absolute() or root.resolve() not in path.resolve(strict=True).parents:
                raise ValueError('Unsafe Web build symlink: ' + str(path))
            data = b'link:' + path.readlink().as_posix().encode()
        else:
            data = path.read_bytes()
        if any(token in data for token in (b'local-test-object-storage', b'four-gap.local.invalid', b'dianjie_four_gap_test')):
            raise ValueError('Local fixture in Web build: ' + str(path))
        h.update(path.relative_to(root).as_posix().encode() + b'\0' + hashlib.sha256(data).hexdigest().encode() + b'\n')
    return {'files': len(files), 'sha256': h.hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--context-name', default='uat-web-image-context-v1')
    parser.add_argument('--dist-name', default='.next-uat-docker')
    parser.add_argument('--audit-name', default='uat-web-docker-build-candidate.json')
    parser.add_argument('--docker-context', default='colima-dianjie-huawei')
    args = parser.parse_args()
    stage = args.stage.resolve()
    if not args.context_name.startswith('uat-web-image-context-') or '/' in args.context_name or '..' in args.context_name:
        raise SystemExit('Unsafe context name')
    if not args.dist_name.startswith('.next-uat-') or '/' in args.dist_name or '..' in args.dist_name or '/' in args.audit_name or '..' in args.audit_name:
        raise SystemExit('Unsafe build name')
    context = stage / args.context_name
    if context.exists():
        raise SystemExit('Image context already exists')
    build = stage / 'web-source/apps/web' / args.dist_name
    audit_path = stage / args.audit_name
    audit = json.loads(audit_path.read_text())
    if audit.get('status') != 'local_uat_web_build_unapproved' or audit.get('buildId') != (build / 'BUILD_ID').read_text().strip():
        raise SystemExit('Unexpected UAT build audit')
    if digest(stage / 'source-scope.json') != audit['sourceScopeSha256'] or digest(build / 'BUILD_ID') != audit['buildIdSha256']:
        raise SystemExit('UAT source or BUILD_ID changed after audit')
    if tree(build / 'standalone') != audit['standalone'] or tree(build / 'static') != audit['static']:
        raise SystemExit('UAT Web build changed after audit')
    if audit.get('serverApiProxy') != 'http://api:4000':
        raise SystemExit('Docker UAT Web must proxy to api:4000')
    old = ROOT / 'tmp/release-1.3.2-20261028/web-source'
    new = stage / 'web-source'
    for name in ('pnpm-lock.yaml', 'apps/web/package.json'):
        if digest(old / name) != digest(new / name):
            raise SystemExit('Web runtime dependency baseline changed: ' + name)
    result = subprocess.check_output(['docker', '--context', args.docker_context, 'image', 'inspect', BASE_IMAGE, '--format', '{{.Id}} {{.Architecture}}'], text=True).strip()
    if result != BASE_IMAGE + ' amd64':
        raise SystemExit('Pinned Linux/amd64 base image missing')
    app = build / 'standalone/apps/web'
    if not (app / 'server.js').is_file():
        raise SystemExit('Missing standalone Web server')
    output = app / args.dist_name
    if not output.is_dir() or not (output / 'server/app/api/[...path]/route.js').is_file():
        raise SystemExit('UAT Next runtime missing')
    for folder in (output, build / 'static', new / 'apps/web/public'):
        for path in folder.rglob('*'):
            if path.is_symlink():
                raise SystemExit('Native or external symlink in Linux overlay: ' + str(path))
            if path.is_file() and path.suffix == '.node':
                raise SystemExit('Mac native module in Linux overlay: ' + str(path))
    context.mkdir()
    shutil.copyfile(app / 'server.js', context / 'server.js')
    shutil.copytree(output, context / 'next-output')
    shutil.copytree(build / 'static', context / 'next-output/static')
    shutil.copyfile(build / 'BUILD_ID', context / 'next-output/BUILD_ID')
    shutil.copytree(new / 'apps/web/public', context / 'public')
    manifest = {'status': 'local_uat_web_linux_image_context_unapproved', 'version': '1.3.3',
                'baseImageId': BASE_IMAGE, 'buildId': audit['buildId'],
                'distName': args.dist_name, 'serverApiProxy': audit['serverApiProxy'],
                'buildAuditSha256': digest(audit_path),
                'dependencyLockSha256': digest(new / 'pnpm-lock.yaml'),
                'webPackageSha256': digest(new / 'apps/web/package.json'),
                'serverSha256': digest(context / 'server.js'),
                'limits': ['Linux image must be built and smoke tested before any delivery claim.',
                           'UAT public HTTPS and same-origin secure cookies remain pending.']}
    (context / 'context-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': manifest['status'], 'context': str(context), 'buildId': audit['buildId']}))


if __name__ == '__main__':
    main()
