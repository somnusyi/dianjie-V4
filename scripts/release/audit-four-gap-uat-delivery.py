#!/usr/bin/env python3
"""Read-only integrity audit of a local 1.3.3 UAT delivery candidate."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tarfile


API_ID = 'sha256:ce1e122f16ee0ba3ee368695a9311de7c15993e632d73faa76d2f0efa00ba390'
WEB_ID = 'sha256:ed7d3cf4964a86e09a811e6bde0351564ded058f889c867e2ef89ff96b219c16'


def digest_stream(stream):
    h = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        h.update(chunk)
    return h.hexdigest()


def digest(path):
    with path.open('rb') as stream:
        return digest_stream(stream)


def image_identity(archive):
    with tarfile.open(archive, 'r:gz') as tar:
        names = set()
        for item in tar:
            path = PurePosixPath(item.name)
            if path.is_absolute() or '..' in path.parts or item.issym() or item.islnk():
                raise ValueError('Unsafe OCI member: ' + item.name)
            if item.isdir():
                continue
            if not item.isfile() or item.name in names:
                raise ValueError('Invalid OCI member: ' + item.name)
            names.add(item.name)
            if item.name.startswith('blobs/sha256/'):
                if digest_stream(tar.extractfile(item)) != item.name.removeprefix('blobs/sha256/'):
                    raise ValueError('Corrupt OCI blob: ' + item.name)
        index = json.load(tar.extractfile('index.json'))
        if len(index.get('manifests', [])) != 1:
            raise ValueError('Unexpected OCI index')
        image_id = index['manifests'][0]['digest']
        manifest = json.load(tar.extractfile('blobs/sha256/' + image_id.removeprefix('sha256:')))
        config_digest = manifest['config']['digest']
        config = json.load(tar.extractfile('blobs/sha256/' + config_digest.removeprefix('sha256:')))
        if config.get('architecture') != 'amd64' or config.get('os') != 'linux':
            raise ValueError('Unexpected image platform')
    return image_id


def tree(root):
    h = hashlib.sha256()
    files = sorted(path for path in root.rglob('*') if path.is_file() or path.is_symlink())
    for path in files:
        if path.is_symlink():
            raise ValueError('Symlink in delivery tree: ' + str(path))
        data = path.read_bytes()
        h.update(path.relative_to(root).as_posix().encode() + b'\0' + hashlib.sha256(data).hexdigest().encode() + b'\n')
    return {'files': len(files), 'sha256': h.hexdigest()}


def audit_reused_web_layout(root, manifest, manifest_path):
    review = root / 'review'
    build_path = review / 'build-candidate.json'
    web_path = review / 'reused-web-build-candidate.json'
    scope_path = review / 'source-scope.json'
    old_scope_path = review / 'reused-web-source-scope.json'
    context_path = review / 'api-image-context.json'
    web_context_path = review / 'web-image-context.json'
    build = json.loads(build_path.read_text())
    web = json.loads(web_path.read_text())
    scope = json.loads(scope_path.read_text())
    old_scope = json.loads(old_scope_path.read_text())
    context = json.loads(context_path.read_text())
    web_context = json.loads(web_context_path.read_text())
    reuse = build.get('webReuse') or {}
    if (digest(scope_path) != manifest['sourceScopeSha256']
        or build.get('sourceScopeSha256') != manifest['sourceScopeSha256']
        or digest(old_scope_path) != reuse.get('previousSourceScopeSha256')
        or digest(web_path) != reuse.get('previousBuildManifestSha256')
        or digest(web_context_path) != reuse.get('webContextSha256')
        or web.get('sourceScopeSha256') != digest(old_scope_path)):
        raise ValueError('Reused Web source or build identity mismatch')
    current_web = {item['path']: item['sha256'] for item in scope['overlays'] if item['path'].startswith('web-source/')}
    old_web = {item['path']: item['sha256'] for item in old_scope['overlays'] if item['path'].startswith('web-source/')}
    if not current_web or current_web != old_web:
        raise ValueError('Reused Web source differs from current scope')
    if (tree(root / 'api/dist') != build['apiDist']
        or tree(root / 'packages/db/prisma/migrations') != build['migrationTree']
        or digest(root / 'packages/db/prisma/schema.prisma') != build['schemaSha256']):
        raise ValueError('API build or migration tree mismatch')
    if (context['buildManifestSha256'] != digest(build_path)
        or context['apiDistTreeSha256'] != build['apiDist']['sha256']
        or context['schemaSha256'] != build['schemaSha256']
        or digest(root / 'packages/db/index.js') != context['dbIndexSha256']):
        raise ValueError('API image context mismatch')
    actual_client = {}
    with tarfile.open(root / 'packages/db/client.tar.gz', 'r:gz') as packed:
        for item in packed:
            path = PurePosixPath(item.name)
            if path.is_absolute() or '..' in path.parts or not item.isfile() or item.name in actual_client:
                raise ValueError('Unsafe or duplicate Prisma client member')
            actual_client[item.name] = digest_stream(packed.extractfile(item))
    if actual_client != {item['name']: item['sha256'] for item in context['prismaClientFiles']}:
        raise ValueError('Generated Prisma client mismatch')
    if (digest(root / 'web/BUILD_ID') != build['webBuildIdSha256']
        or build['webBuildId'] != web['webBuildId']
        or build['webBuildId'] != manifest['webBuildId']
        or web_context['buildManifestSha256'] != digest(web_path)
        or web_context['buildId'] != manifest['webBuildId']
        or web_context['serverApiProxy'] != 'http://api:4000'
        or web_context['serverSha256'] != web['webServerSha256']
        or web_context['static'] != web['webStatic']
        or web_context['runtimeOverlay'] != web['webRuntimeOverlay']):
        raise ValueError('Reused Web image context mismatch')
    operations = json.loads((root / 'operations/operations-source.json').read_text())
    if digest(root / 'operations/operations-source.json') != manifest['operationsSourceSha256']:
        raise ValueError('Operations manifest mismatch')
    actual_ops = {path.relative_to(root / 'operations').as_posix()
                  for path in (root / 'operations').rglob('*') if path.is_file()
                  and path.name != 'operations-source.json'}
    if actual_ops != set(operations['files']):
        raise ValueError('Operations source scope mismatch')
    for name, expected in operations['files'].items():
        if digest(root / 'operations' / name) != expected:
            raise ValueError('Operations source hash mismatch: ' + name)
    print(json.dumps({'status': 'local_uat_delivery_integrity_passed_unapproved',
                      'artifacts': len(manifest['artifacts']), 'apiModules': build['apiDist']['files'],
                      'migrationFiles': build['migrationTree']['files'], 'opsFiles': len(operations['files']),
                      'manifestSha256': digest(manifest_path)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--expected-api-id', default=API_ID)
    parser.add_argument('--expected-web-id', default=WEB_ID)
    parser.add_argument('--expected-manifest-sha256')
    args = parser.parse_args()
    image_id_pattern = re.compile(r'sha256:[a-f0-9]{64}\Z')
    if not image_id_pattern.fullmatch(args.expected_api_id) or not image_id_pattern.fullmatch(args.expected_web_id):
        raise ValueError('Expected image IDs must be pinned SHA256 digests')
    if args.expected_manifest_sha256 and not re.fullmatch(r'[a-f0-9]{64}', args.expected_manifest_sha256):
        raise ValueError('Expected manifest SHA256 is invalid')
    root = args.root.resolve()
    manifest_path = root / 'delivery-candidate.json'
    if args.expected_manifest_sha256 and digest(manifest_path) != args.expected_manifest_sha256:
        raise ValueError('Pinned delivery manifest mismatch')
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('status') != 'local_uat_delivery_candidate_unapproved' or manifest.get('version') != '1.3.3' or manifest.get('target') != 'uat':
        raise ValueError('Unexpected delivery status')
    files = {path.relative_to(root).as_posix() for path in root.rglob('*') if path.is_file() or path.is_symlink()}
    if files != set(manifest['artifacts']) | {'delivery-candidate.json'}:
        raise ValueError('Delivery file inventory mismatch')
    for name, expected in manifest['artifacts'].items():
        path = root / name
        if path.is_symlink() or not path.is_file() or digest(path) != expected:
            raise ValueError('Delivery artifact mismatch: ' + name)
        runtime_source = name.startswith(('api/dist/', 'packages/db/', 'operations/')) and name != 'operations/operations-source.json'
        if runtime_source and not name.endswith('.tar.gz') and any(marker in path.read_bytes() for marker in (b'local-test-object-storage', b'four-gap.local.invalid', b'dianjie_four_gap_test')):
            raise ValueError('Local fixture in delivery source: ' + name)
    if manifest.get('apiImageId') != args.expected_api_id or manifest.get('webImageId') != args.expected_web_id:
        raise ValueError('Delivery manifest does not reference current pinned images')
    if image_identity(root / 'api/application.tar.gz') != args.expected_api_id or image_identity(root / 'web/application.tar.gz') != args.expected_web_id:
        raise ValueError('OCI image identity mismatch')
    if (root / 'review/reused-web-build-candidate.json').is_file():
        audit_reused_web_layout(root, manifest, manifest_path)
        return
    build = json.loads((root / 'review/api-build-candidate.json').read_text())
    web = json.loads((root / 'review/uat-web-build-candidate.json').read_text())
    scope = root / 'review/source-scope.json'
    if digest(scope) != manifest['sourceScopeSha256'] or build['sourceScopeSha256'] != manifest['sourceScopeSha256']:
        raise ValueError('Source scope mismatch')
    if web['sourceScopeSha256'] != manifest['sourceScopeSha256']:
        raise ValueError('Web source scope mismatch')
    if web.get('reuse'):
        proof = root / 'review/web-reuse-proof.json'
        if digest(proof) != web['reuse']['sourceComparisonSha256'] or json.loads(proof.read_text()).get('currentScopeSha256') != manifest['sourceScopeSha256']:
            raise ValueError('Web reuse evidence mismatch')
    if tree(root / 'api/dist') != build['apiDist'] or tree(root / 'packages/db/prisma/migrations') != build['migrationTree']:
        raise ValueError('API or migration tree mismatch')
    if digest(root / 'packages/db/prisma/schema.prisma') != build['schemaSha256']:
        raise ValueError('Schema mismatch')
    context = json.loads((root / 'review/api-image-context.json').read_text())
    if context['buildManifestSha256'] != digest(root / 'review/api-build-candidate.json') or context['apiDistTreeSha256'] != build['apiDist']['sha256'] or context['schemaSha256'] != build['schemaSha256']:
        raise ValueError('API image context/build mismatch')
    if digest(root / 'packages/db/index.js') != context['dbIndexSha256']:
        raise ValueError('DB adapter mismatch')
    expected_client = {item['name']: item['sha256'] for item in context['prismaClientFiles']}
    actual_client = {}
    with tarfile.open(root / 'packages/db/client.tar.gz', 'r:gz') as packed:
        for item in packed:
            path = PurePosixPath(item.name)
            if path.is_absolute() or '..' in path.parts or not item.isfile() or item.name in actual_client:
                raise ValueError('Unsafe or duplicate Prisma client member')
            actual_client[item.name] = digest_stream(packed.extractfile(item))
    if actual_client != expected_client:
        raise ValueError('Generated Prisma client mismatch')
    if digest(root / 'web/BUILD_ID') != web['buildIdSha256'] or web['buildId'] != manifest['webBuildId'] or web['serverApiProxy'] != 'http://api:4000':
        raise ValueError('UAT Web build mismatch')
    operations = json.loads((root / 'operations/operations-source.json').read_text())
    if digest(root / 'operations/operations-source.json') != manifest['operationsSourceSha256']:
        raise ValueError('Operations manifest mismatch')
    actual_ops = {name.removeprefix('operations/') for name in files if name.startswith('operations/') and name != 'operations/operations-source.json'}
    if actual_ops != set(operations['files']):
        raise ValueError('Operations source scope mismatch')
    for name, expected in operations['files'].items():
        if digest(root / 'operations' / name) != expected:
            raise ValueError('Operations source hash mismatch: ' + name)
    print(json.dumps({'status': 'local_uat_delivery_integrity_passed_unapproved',
                      'artifacts': len(manifest['artifacts']), 'apiModules': build['apiDist']['files'],
                      'migrationFiles': build['migrationTree']['files'], 'opsFiles': len(operations['files']),
                      'manifestSha256': digest(manifest_path)}))


if __name__ == '__main__':
    main()
