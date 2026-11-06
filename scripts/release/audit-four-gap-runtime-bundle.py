#!/usr/bin/env python3
"""Read-only audit of a local 1.3.3 runtime payload against its build stage."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile


def digest_stream(stream):
    h = hashlib.sha256()
    for part in iter(lambda: stream.read(1024 * 1024), b''):
        h.update(part)
    return h.hexdigest()


def sha(path):
    with path.open('rb') as stream:
        return digest_stream(stream)


def members(archive):
    found = {}
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar:
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or member.issym() or member.islnk():
                raise ValueError('Unsafe archive member: ' + member.name)
            if member.isdir():
                continue
            if not member.isfile() or member.name in found:
                raise ValueError('Invalid archive member: ' + member.name)
            found[member.name] = digest_stream(tar.extractfile(member))
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--bundle', type=Path, required=True)
    args = parser.parse_args()
    stage, bundle = args.stage.resolve(), args.bundle.resolve()
    manifest = json.loads((bundle / 'runtime-bundle.json').read_text())
    build = json.loads((stage / 'build-candidate.json').read_text())
    if manifest.get('status') != 'local_runtime_bundle_unapproved' or manifest.get('version') != '1.3.3' or manifest.get('buildCandidateSha256') != sha(stage / 'build-candidate.json'):
        raise ValueError('Candidate identity mismatch')
    actual = {path.relative_to(bundle).as_posix() for path in bundle.rglob('*') if path.is_file() or path.is_symlink()}
    if actual != set(manifest['artifacts']) | {'runtime-bundle.json'}:
        raise ValueError('Bundle file inventory mismatch')
    for name, expected in manifest['artifacts'].items():
        path = bundle / name
        if path.is_symlink() or not path.is_file() or sha(path) != expected:
            raise ValueError('Bundle artifact mismatch: ' + name)
    api = stage / 'api-source/apps/api/dist'
    expected_api = {path.relative_to(api).as_posix(): sha(path) for path in api.rglob('*') if path.is_file()}
    actual_api = {name.removeprefix('api/dist/'): value for name, value in manifest['artifacts'].items() if name.startswith('api/dist/')}
    if actual_api != expected_api:
        raise ValueError('API loose output mismatch')
    if sha(bundle / 'web/BUILD_ID') != build['webBuildIdSha256']:
        raise ValueError('Web BUILD_ID mismatch')
    client = stage / 'api-image-context-v2/prisma-client'
    expected_client = {path.relative_to(client).as_posix(): sha(path) for path in client.rglob('*') if path.is_file()}
    if members(bundle / 'packages/db/client.tar.gz') != expected_client:
        raise ValueError('Prisma client archive mismatch')
    web = stage / 'web-source/apps/web/.next-candidate'
    expected_web = {'BUILD_ID': sha(web / 'BUILD_ID')}
    for folder in ('standalone', 'static'):
        expected_web.update({folder + '/' + path.relative_to(web / folder).as_posix(): sha(path) for path in (web / folder).rglob('*') if path.is_file()})
    if members(bundle / 'web/application.tar.gz') != expected_web:
        raise ValueError('Web archive mismatch')
    # The server needs Next itself at runtime. A tree whose paths hash correctly
    # can still resolve dependencies from the developer's ancestor node_modules.
    if not any(name.endswith('/node_modules/next/package.json') for name in expected_web):
        raise ValueError('Web archive is not self-contained: Next runtime missing')
    image_archive = bundle / 'api/application.tar.gz'
    image_members = members(image_archive)
    with tarfile.open(image_archive, 'r:gz') as tar:
        index = json.load(tar.extractfile('index.json'))
    image_digest = manifest['apiImageId'].removeprefix('sha256:')
    if len(index.get('manifests', [])) != 1 or index['manifests'][0].get('digest') != manifest['apiImageId'] or 'blobs/sha256/' + image_digest not in image_members:
        raise ValueError('Docker image identity mismatch')
    for name, found_hash in image_members.items():
        if name.startswith('blobs/sha256/') and found_hash != name.removeprefix('blobs/sha256/'):
            raise ValueError('Docker image blob corruption: ' + name)
    print(json.dumps({'status': 'local_runtime_bundle_audited', 'artifacts': len(manifest['artifacts']),
                      'apiModules': len(expected_api), 'webMembers': len(expected_web),
                      'clientMembers': len(expected_client), 'imageBlobs': sum(name.startswith('blobs/sha256/') for name in image_members),
                      'runtimeBundleSha256': sha(bundle / 'runtime-bundle.json')}))


if __name__ == '__main__':
    main()
