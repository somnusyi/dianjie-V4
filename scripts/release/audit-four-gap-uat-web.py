#!/usr/bin/env python3
"""Audit a local UAT-targeted Web build; do not approve or deploy it."""
import argparse
import hashlib
import json
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree(root):
    files = sorted(path for path in root.rglob('*') if path.is_file() or path.is_symlink())
    if not files:
        raise ValueError('Empty build tree: ' + str(root))
    h = hashlib.sha256()
    for path in files:
        if path.is_symlink():
            if path.readlink().is_absolute():
                raise ValueError('Absolute symlink in build tree: ' + str(path))
            target = path.resolve(strict=True)
            if root.resolve() not in target.parents:
                raise ValueError('External symlink in build tree: ' + str(path))
            data = b'link:' + path.readlink().as_posix().encode()
        else:
            data = path.read_bytes()
        if any(token in data for token in (b'local-test-object-storage', b'four-gap.local.invalid', b'dianjie_four_gap_test')):
            raise ValueError('Local fixture or adapter in build tree: ' + str(path))
        h.update(path.relative_to(root).as_posix().encode() + b'\0' + hashlib.sha256(data).hexdigest().encode() + b'\n')
    return {'files': len(files), 'sha256': h.hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--dist-name', default='.next-uat-isolated')
    parser.add_argument('--api-base', default='http://127.0.0.1:4005')
    parser.add_argument('--manifest-name', default='uat-web-build-candidate.json')
    args = parser.parse_args()
    stage = args.stage.resolve()
    if not args.dist_name.startswith('.next-uat-') or '/' in args.dist_name or '..' in args.dist_name or '/' in args.manifest_name or '..' in args.manifest_name:
        raise ValueError('Unsafe output name')
    build = stage / 'web-source/apps/web' / args.dist_name
    scope = stage / 'source-scope.json'
    if json.loads(scope.read_text()).get('version') != '1.3.3':
        raise ValueError('Unexpected source stage')
    build_id = (build / 'BUILD_ID').read_text().strip()
    if len(build_id) < 10 or len(build_id) > 80:
        raise ValueError('Invalid Web BUILD_ID')
    standalone = tree(build / 'standalone')
    static = tree(build / 'static')
    if not (build / 'standalone/apps/web/server.js').is_file():
        raise ValueError('Missing standalone server')
    login_chunks = list((build / 'static/chunks/app/v2/login').glob('page-*.js'))
    if len(login_chunks) != 1:
        raise ValueError('V2 login chunk missing or ambiguous')
    login = login_chunks[0].read_bytes()
    if b'supply-chain-uat' not in login or b'http://116.62.32.162:8085/v2/login' not in login:
        raise ValueError('UAT login tenant or entrypoint missing')
    proxy = build / 'standalone/apps/web' / args.dist_name / 'server/app/api/[...path]/route.js'
    if args.api_base.encode() not in proxy.read_bytes():
        raise ValueError('UAT API proxy target missing')
    manifest = {
        'status': 'local_uat_web_build_unapproved',
        'version': '1.3.3',
        'target': 'uat',
        'buildId': build_id,
        'buildIdSha256': digest(build / 'BUILD_ID'),
        'sourceScopeSha256': digest(scope),
        'standalone': standalone,
        'static': static,
        'clientTenant': 'supply-chain-uat',
        'clientTestLoginUrl': 'http://116.62.32.162:8085/v2/login',
        'serverApiProxy': args.api_base,
        'limits': [
            'Built on macOS using offline isolated dependencies; Linux target runtime has not been verified.',
            'The configured UAT public entrypoint is HTTP; G02 secure cookies require verified HTTPS.',
            'This is not an approved deployable Web artifact or compatible rollback package.',
        ],
    }
    path = stage / args.manifest_name
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': manifest['status'], 'buildId': build_id, 'standaloneFiles': standalone['files'], 'staticFiles': static['files'], 'manifestSha256': digest(path)}))


if __name__ == '__main__':
    main()
