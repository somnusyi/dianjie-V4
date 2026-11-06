#!/usr/bin/env python3
"""Assemble a pinned local UAT delivery candidate; never publish or deploy."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile


ROOT = Path(__file__).resolve().parents[2]
API_ID = 'sha256:ce1e122f16ee0ba3ee368695a9311de7c15993e632d73faa76d2f0efa00ba390'
WEB_ID = 'sha256:ed7d3cf4964a86e09a811e6bde0351564ded058f889c867e2ef89ff96b219c16'
WEB_TAG = 'dianjie-four-gap-uat-web:local-v133-f'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def verified_copy(source, destination):
    if not source.is_file() or source.is_symlink():
        raise ValueError('Missing or unsafe source: ' + str(source))
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    if digest(source) != digest(destination):
        raise ValueError('Source changed during copy: ' + str(source))


def image_identity(archive):
    with tarfile.open(archive, 'r:gz') as tar:
        index = json.load(tar.extractfile('index.json'))
        manifests = index.get('manifests', [])
        if len(manifests) != 1:
            raise ValueError('Unexpected OCI image index')
        image_id = manifests[0].get('digest')
        blob = 'blobs/sha256/' + image_id.removeprefix('sha256:')
        stream = tar.extractfile(blob)
        if not stream or hashlib.sha256(stream.read()).hexdigest() != image_id.removeprefix('sha256:'):
            raise ValueError('OCI image manifest blob mismatch')
    return image_id


def save_image(tag, destination, docker_context):
    destination.parent.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(['docker', '--context', docker_context, 'save', tag], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    with destination.open('wb') as output, gzip.GzipFile(fileobj=output, mode='wb', mtime=0) as packed:
        for chunk in iter(lambda: process.stdout.read(1024 * 1024), b''):
            packed.write(chunk)
    stderr = process.stderr.read()
    if process.wait():
        raise ValueError('Docker image export failed: ' + stderr.decode(errors='replace'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--operations', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--docker-context', default='colima-dianjie-huawei')
    parser.add_argument('--api-image-id', default=API_ID)
    parser.add_argument('--web-image-id', default=WEB_ID)
    parser.add_argument('--web-image-tag', default=WEB_TAG)
    parser.add_argument('--api-context-name', default='api-image-context-v3')
    args = parser.parse_args()
    for image_id in (args.api_image_id, args.web_image_id):
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id):
            raise SystemExit('Image ID must be a pinned SHA256 digest')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._/-]*:[a-zA-Z0-9._-]+', args.web_image_tag):
        raise SystemExit('Invalid Web image tag')
    if not re.fullmatch(r'api-image-context[a-zA-Z0-9._-]*', args.api_context_name):
        raise SystemExit('Invalid API context name')
    stage, operations = args.stage.resolve(), args.operations.resolve()
    output = args.output.resolve()
    if output.exists() or ROOT not in output.parents:
        raise SystemExit('Output must be a new dedicated project directory')
    source_scope = stage / 'source-scope.json'
    build = json.loads((stage / 'build-candidate.json').read_text())
    web_build_file = stage / 'uat-web-docker-build-candidate.json'
    web_build = json.loads(web_build_file.read_text())
    ops_file = operations / 'operations-source.json'
    ops = json.loads(ops_file.read_text())
    if build.get('version') != '1.3.3' or build.get('sourceScopeSha256') != digest(source_scope):
        raise SystemExit('API source/build identity mismatch')
    if web_build.get('version') != '1.3.3' or web_build.get('target') != 'uat' or web_build.get('serverApiProxy') != 'http://api:4000':
        raise SystemExit('UAT Web identity mismatch')
    if ops.get('version') != '1.3.3' or ops.get('status') != 'operations_source_staged_unapproved':
        raise SystemExit('Operations source identity mismatch')
    context_root = stage / args.api_context_name
    context_file = context_root / 'context-manifest.json'
    context = json.loads(context_file.read_text())
    if context['buildManifestSha256'] != digest(stage / 'build-candidate.json') or context['apiDistTreeSha256'] != build['apiDist']['sha256']:
        raise SystemExit('API image context/build mismatch')
    client = context_root / 'prisma-client'
    client_files = {item['name']: item['sha256'] for item in context['prismaClientFiles']}
    actual_client = {p.relative_to(client).as_posix(): digest(p) for p in client.rglob('*') if p.is_file()}
    if actual_client != client_files or any(p.is_symlink() for p in client.rglob('*')):
        raise SystemExit('Generated client context mismatch')
    image = subprocess.check_output(['docker', '--context', args.docker_context, 'image', 'inspect', args.api_image_id, '--format', '{{.Id}} {{.Os}} {{.Architecture}}'], text=True).strip()
    if image != args.api_image_id + ' linux amd64':
        raise SystemExit('Pinned corrected API image missing')
    image = subprocess.check_output(['docker', '--context', args.docker_context, 'image', 'inspect', args.web_image_tag, '--format', '{{.Id}} {{.Architecture}}'], text=True).strip()
    if image != args.web_image_id + ' amd64':
        raise SystemExit('Pinned UAT Web image missing')
    output.mkdir(parents=True)
    pairs = (
        (context_root / 'db-index.js', output / 'packages/db/index.js'),
        (stage / 'api-source/packages/db/prisma/schema.prisma', output / 'packages/db/prisma/schema.prisma'),
        (context_file, output / 'review/api-image-context.json'),
        (stage / 'web-source/apps/web/.next-uat-docker/BUILD_ID', output / 'web/BUILD_ID'),
        (source_scope, output / 'review/source-scope.json'),
        (stage / 'build-candidate.json', output / 'review/api-build-candidate.json'),
        (web_build_file, output / 'review/uat-web-build-candidate.json'),
        (ops_file, output / 'operations/operations-source.json'),
    )
    if web_build.get('reuse'):
        proof = stage / 'web-reuse-proof.json'
        if digest(proof) != web_build['reuse']['sourceComparisonSha256']:
            raise SystemExit('Web reuse evidence mismatch')
        verified_copy(proof, output / 'review/web-reuse-proof.json')
    for source, target in pairs:
        verified_copy(source, target)
    for folder, prefix in (
        (stage / 'api-source/apps/api/dist', Path('api/dist')),
        (stage / 'api-source/packages/db/prisma/migrations', Path('packages/db/prisma/migrations')),
    ):
        for source in sorted(folder.rglob('*')):
            if source.is_symlink():
                raise SystemExit('Symlink in delivery source: ' + str(source))
            if source.is_file():
                verified_copy(source, output / prefix / source.relative_to(folder))
    for name, expected in ops['files'].items():
        source = operations / name
        if digest(source) != expected:
            raise SystemExit('Operations source drift: ' + name)
        verified_copy(source, output / 'operations' / name)
    with tarfile.open(output / 'packages/db/client.tar.gz', 'w:gz') as packed:
        for name in sorted(client_files):
            packed.add(client / name, arcname=name, recursive=False)
    save_image(args.api_image_id, output / 'api/application.tar.gz', args.docker_context)
    save_image(args.web_image_id, output / 'web/application.tar.gz', args.docker_context)
    if image_identity(output / 'api/application.tar.gz') != args.api_image_id or image_identity(output / 'web/application.tar.gz') != args.web_image_id:
        raise SystemExit('OCI image archive identity mismatch')
    artifacts = {path.relative_to(output).as_posix(): digest(path) for path in sorted(output.rglob('*')) if path.is_file()}
    manifest = {'status': 'local_uat_delivery_candidate_unapproved', 'version': '1.3.3', 'target': 'uat',
                'sourceScopeSha256': digest(source_scope), 'apiImageId': args.api_image_id, 'webImageId': args.web_image_id,
                'webBuildId': web_build['buildId'], 'operationsSourceSha256': digest(ops_file),
                'artifacts': artifacts,
                'limits': ['This is a forward 1.3.3 delivery candidate, not a compatible rollback package.',
                           'No real UAT HTTPS, encrypted production key escrow, recovery rehearsal, release approval, upload or deployment.']}
    (output / 'delivery-candidate.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': manifest['status'], 'artifacts': len(artifacts), 'manifestSha256': digest(output / 'delivery-candidate.json')}))


if __name__ == '__main__':
    main()
