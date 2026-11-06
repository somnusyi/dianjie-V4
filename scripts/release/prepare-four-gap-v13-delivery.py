#!/usr/bin/env python3
"""Package and audit a pinned local UAT image pair without deploying it."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile


ROOT = Path(__file__).resolve().parents[2]
MARKERS = (b'local-test-object-storage', b'four-gap.local.invalid', b'dianjie_four_gap_test')


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def tree(root):
    if not root.is_dir():
        raise ValueError('Missing tree: ' + str(root))
    files = sorted(p for p in root.rglob('*') if p.is_file() or p.is_symlink())
    h = hashlib.sha256()
    for path in files:
        if path.is_symlink():
            raise ValueError('Symlink in source tree: ' + str(path))
        data = path.read_bytes()
        if any(marker in data for marker in MARKERS):
            raise ValueError('Local fixture in source tree: ' + str(path))
        h.update(path.relative_to(root).as_posix().encode() + b'\0'
                 + hashlib.sha256(data).hexdigest().encode() + b'\n')
    return {'files': len(files), 'sha256': h.hexdigest()}


def copy_checked(source, target):
    if not source.is_file() or source.is_symlink():
        raise ValueError('Unsafe or missing source: ' + str(source))
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    if digest(source) != digest(target):
        raise ValueError('Copy changed: ' + str(source))


def copy_tree(source, target):
    for path in sorted(source.rglob('*')):
        if path.is_symlink():
            raise ValueError('Symlink in source: ' + str(path))
        if path.is_file():
            copy_checked(path, target / path.relative_to(source))


def stream_digest(stream):
    h = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        h.update(chunk)
    return h.hexdigest()


def image_identity(archive):
    with tarfile.open(archive, 'r:gz') as packed:
        members = {}
        for member in packed:
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or member.issym() or member.islnk():
                raise ValueError('Unsafe OCI member')
            if member.isdir():
                continue
            if not member.isfile() or member.name in members:
                raise ValueError('Invalid OCI member')
            members[member.name] = member
            if member.name.startswith('blobs/sha256/'):
                if stream_digest(packed.extractfile(member)) != member.name.removeprefix('blobs/sha256/'):
                    raise ValueError('OCI blob hash mismatch')
        index = json.load(packed.extractfile(members['index.json']))
        if len(index.get('manifests', [])) != 1:
            raise ValueError('Unexpected OCI index')
        image_id = index['manifests'][0]['digest']
        manifest = json.load(packed.extractfile(members['blobs/sha256/' + image_id.removeprefix('sha256:')]))
        config_id = manifest['config']['digest']
        config = json.load(packed.extractfile(members['blobs/sha256/' + config_id.removeprefix('sha256:')]))
        if (config.get('os'), config.get('architecture')) != ('linux', 'amd64'):
            raise ValueError('Unexpected image platform')
    return image_id


def save_image(image_id, destination, context):
    process = subprocess.Popen(['docker', '--context', context, 'save', image_id],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    with destination.open('wb') as output, gzip.GzipFile(fileobj=output, mode='wb', mtime=0) as packed:
        for chunk in iter(lambda: process.stdout.read(1024 * 1024), b''):
            packed.write(chunk)
    error = process.stderr.read()
    if process.wait():
        raise ValueError('Docker image export failed: ' + error.decode(errors='replace'))
    if image_identity(destination) != image_id:
        raise ValueError('Exported image identity changed')


def load(path):
    return json.loads(path.read_text())


def audit(output):
    manifest_path = output / 'delivery-candidate.json'
    manifest = load(manifest_path)
    if (manifest.get('status'), manifest.get('version'), manifest.get('target')) != (
            'local_uat_delivery_candidate_unapproved', '1.3.3', 'uat'):
        raise ValueError('Unexpected delivery identity')
    artifacts = manifest['artifacts']
    actual = {p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file() or p.is_symlink()}
    if actual != set(artifacts) | {'delivery-candidate.json'}:
        raise ValueError('Delivery inventory mismatch')
    for name, expected in artifacts.items():
        path = output / name
        if path.is_symlink() or not path.is_file() or digest(path) != expected:
            raise ValueError('Delivery artifact mismatch: ' + name)
    for role in ('api', 'web'):
        if image_identity(output / role / 'application.tar.gz') != manifest[role + 'ImageId']:
            raise ValueError('Delivery image identity mismatch: ' + role)
    build = load(output / 'review/build-candidate.json')
    scope = output / 'review/source-scope.json'
    if build['sourceScopeSha256'] != digest(scope) or digest(scope) != manifest['sourceScopeSha256']:
        raise ValueError('Source identity mismatch')
    if tree(output / 'api/dist') != build['apiDist']:
        raise ValueError('API build mismatch')
    if tree(output / 'packages/db/prisma/migrations') != build['migrationTree']:
        raise ValueError('Migration tree mismatch')
    if digest(output / 'packages/db/prisma/schema.prisma') != build['schemaSha256']:
        raise ValueError('Schema mismatch')
    api_context = load(output / 'review/api-image-context.json')
    web_context = load(output / 'review/web-image-context.json')
    if (api_context['buildManifestSha256'] != digest(output / 'review/build-candidate.json')
            or api_context['apiDistTreeSha256'] != build['apiDist']['sha256']
            or digest(output / 'packages/db/index.js') != api_context['dbIndexSha256']):
        raise ValueError('API context mismatch')
    web_reuse = build.get('webReuse')
    expected_web_build = web_reuse['previousBuildManifestSha256'] if web_reuse else digest(output / 'review/build-candidate.json')
    if (web_context['buildManifestSha256'] != expected_web_build
            or web_context['buildId'] != manifest['webBuildId']
            or web_context['serverApiProxy'] != 'http://api:4000'
            or digest(output / 'web/BUILD_ID') != build['webBuildIdSha256']):
        raise ValueError('Web context mismatch')
    if web_reuse and digest(output / 'review/web-image-context.json') != web_reuse['webContextSha256']:
        raise ValueError('Reused Web context fingerprint mismatch')
    if web_reuse:
        previous_scope_path = output / 'review/reused-web-source-scope.json'
        previous_build_path = output / 'review/reused-web-build-candidate.json'
        previous_scope = load(previous_scope_path)
        current_scope = load(scope)
        previous_build = load(previous_build_path)
        current_web = {item['path']: item['sha256'] for item in current_scope['overlays'] if item['path'].startswith('web-source/')}
        previous_web = {item['path']: item['sha256'] for item in previous_scope['overlays'] if item['path'].startswith('web-source/')}
        if (digest(previous_scope_path) != web_reuse['previousSourceScopeSha256']
                or digest(previous_build_path) != expected_web_build
                or previous_build['sourceScopeSha256'] != digest(previous_scope_path)
                or previous_scope['releasedSourceFingerprint'] != current_scope['releasedSourceFingerprint']
                or previous_web != current_web
                or any(previous_build[key] != build[key] for key in ('webBuildId', 'webBuildIdSha256', 'webServerSha256', 'webRuntimeOverlay', 'webStatic'))):
            raise ValueError('Reused Web source proof mismatch')
    client_hashes = {}
    with tarfile.open(output / 'packages/db/client.tar.gz', 'r:gz') as packed:
        for member in packed:
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or not member.isfile() or member.name in client_hashes:
                raise ValueError('Unsafe Prisma client member')
            client_hashes[member.name] = stream_digest(packed.extractfile(member))
    if client_hashes != {item['name']: item['sha256'] for item in api_context['prismaClientFiles']}:
        raise ValueError('Prisma client mismatch')
    operations = load(output / 'operations/operations-source.json')
    if (digest(output / 'operations/operations-source.json') != manifest['operationsSourceSha256']
            or {n.removeprefix('operations/') for n in artifacts if n.startswith('operations/')
                and n != 'operations/operations-source.json'} != set(operations['files'])):
        raise ValueError('Operations inventory mismatch')
    for name, expected in operations['files'].items():
        if digest(output / 'operations' / name) != expected:
            raise ValueError('Operations hash mismatch: ' + name)
    return {'status': 'local_uat_delivery_integrity_passed_unapproved',
            'artifacts': len(artifacts), 'manifestSha256': digest(manifest_path),
            'apiImageId': manifest['apiImageId'], 'webImageId': manifest['webImageId']}


def prepare(stage, web_stage, operations, output, evidence_path, docker_context):
    if output.exists() or ROOT not in output.parents:
        raise ValueError('Output must be a new project directory')
    scope = stage / 'source-scope.json'
    build_path = stage / 'build-candidate.json'
    build = load(build_path)
    evidence = load(evidence_path)
    api_context = stage / 'api-image-context'
    web_context = web_stage / 'uat-web-image-context-v13'
    api = load(api_context / 'context-manifest.json')
    web = load(web_context / 'context-manifest.json')
    ops_path = operations / 'operations-source.json'
    ops = load(ops_path)
    web_reuse = build.get('webReuse')
    if web_stage != stage:
        previous_scope_path = web_stage / 'source-scope.json'
        previous_build_path = web_stage / 'build-candidate.json'
        current_scope = load(scope)
        previous_scope = load(previous_scope_path)
        current_web = {item['path']: item['sha256'] for item in current_scope['overlays'] if item['path'].startswith('web-source/')}
        previous_web = {item['path']: item['sha256'] for item in previous_scope['overlays'] if item['path'].startswith('web-source/')}
        if (not web_reuse or web_reuse['previousSourceScopeSha256'] != digest(previous_scope_path)
                or web_reuse['previousBuildManifestSha256'] != digest(previous_build_path)
                or web_reuse['webContextSha256'] != digest(web_context / 'context-manifest.json')
                or current_scope['releasedSourceFingerprint'] != previous_scope['releasedSourceFingerprint']
                or current_web != previous_web):
            raise ValueError('Reused Web source or build identity mismatch')
    elif web_reuse:
        raise ValueError('Reused Web build requires its original source stage')
    expected_web_build = web_reuse['previousBuildManifestSha256'] if web_reuse else digest(build_path)
    if (build.get('version') != '1.3.3' or build.get('sourceScopeSha256') != digest(scope)
            or evidence.get('status') != 'local_linux_pair_smoke_verified_unapproved'
            or evidence.get('buildManifestSha256') != digest(build_path)
            or api['buildManifestSha256'] != digest(build_path)
            or web['buildManifestSha256'] != expected_web_build
            or web['buildId'] != build['webBuildId']
            or ops.get('status') != 'operations_source_staged_unapproved'):
        raise ValueError('Pinned v13 source, build or operations mismatch')
    if tree(api_context / 'api-dist') != build['apiDist']:
        raise ValueError('API build changed')
    if tree(stage / 'api-source/packages/db/prisma/migrations') != build['migrationTree']:
        raise ValueError('Migration tree changed')
    if digest(stage / 'api-source/packages/db/prisma/schema.prisma') != build['schemaSha256']:
        raise ValueError('Schema changed')
    if digest(web_context / 'server.js') != web['serverSha256'] or web['static'] != build['webStatic']:
        raise ValueError('Web context changed')
    ids = {role: evidence[role + 'Image']['id'] for role in ('api', 'web')}
    for role, image_id in ids.items():
        observed = subprocess.check_output(['docker', '--context', docker_context, 'image', 'inspect',
                                            image_id, '--format', '{{.Id}} {{.Os}}/{{.Architecture}}'], text=True).strip()
        if observed != image_id + ' linux/amd64':
            raise ValueError('Pinned Linux image missing: ' + role)
    output.mkdir(parents=True)
    for source, target in (
            (scope, output / 'review/source-scope.json'),
            (build_path, output / 'review/build-candidate.json'),
            (api_context / 'context-manifest.json', output / 'review/api-image-context.json'),
            (web_context / 'context-manifest.json', output / 'review/web-image-context.json'),
            (ops_path, output / 'operations/operations-source.json'),
            (api_context / 'db-index.js', output / 'packages/db/index.js'),
            (stage / 'api-source/packages/db/prisma/schema.prisma', output / 'packages/db/prisma/schema.prisma'),
            (web_stage / 'web-source/apps/web/.next-uat-docker/BUILD_ID', output / 'web/BUILD_ID')):
        copy_checked(source, target)
    if web_reuse:
        copy_checked(web_stage / 'source-scope.json', output / 'review/reused-web-source-scope.json')
        copy_checked(web_stage / 'build-candidate.json', output / 'review/reused-web-build-candidate.json')
    copy_tree(api_context / 'api-dist', output / 'api/dist')
    copy_tree(stage / 'api-source/packages/db/prisma/migrations', output / 'packages/db/prisma/migrations')
    for name, expected in ops['files'].items():
        source = operations / name
        if digest(source) != expected:
            raise ValueError('Operations source changed: ' + name)
        copy_checked(source, output / 'operations' / name)
    client = api_context / 'prisma-client'
    expected_client = {item['name']: item['sha256'] for item in api['prismaClientFiles']}
    if {p.relative_to(client).as_posix(): digest(p) for p in client.rglob('*') if p.is_file()} != expected_client:
        raise ValueError('Generated Prisma client changed')
    with tarfile.open(output / 'packages/db/client.tar.gz', 'w:gz') as packed:
        for name in sorted(expected_client):
            packed.add(client / name, arcname=name, recursive=False)
    for role, image_id in ids.items():
        save_image(image_id, output / role / 'application.tar.gz', docker_context)
    artifacts = {p.relative_to(output).as_posix(): digest(p) for p in sorted(output.rglob('*')) if p.is_file()}
    manifest = {'status': 'local_uat_delivery_candidate_unapproved', 'version': '1.3.3',
                'target': 'uat', 'sourceScopeSha256': digest(scope), 'apiImageId': ids['api'],
                'webImageId': ids['web'], 'webBuildId': build['webBuildId'],
                'operationsSourceSha256': digest(ops_path), 'artifacts': artifacts,
                'limits': ['Forward image pair only; not a compatible recovery package.',
                           'Public HTTPS UAT, offline production key custody and deployment are pending.']}
    (output / 'delivery-candidate.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return audit(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--audit-only', action='store_true')
    parser.add_argument('--stage', type=Path)
    parser.add_argument('--web-stage', type=Path)
    parser.add_argument('--operations', type=Path)
    parser.add_argument('--evidence', type=Path)
    parser.add_argument('--docker-context', default='colima-dianjie-huawei')
    args = parser.parse_args()
    if args.audit_only:
        result = audit(args.output.resolve())
    else:
        if not all((args.stage, args.operations, args.evidence)):
            parser.error('--stage, --operations and --evidence are required when packaging')
        result = prepare(args.stage.resolve(), (args.web_stage or args.stage).resolve(), args.operations.resolve(), args.output.resolve(),
                         args.evidence.resolve(), args.docker_context)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
