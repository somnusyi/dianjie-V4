#!/usr/bin/env python3
"""Bundle pinned local runtime artifacts for review; this is not a rollback package."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile


ROOT = Path(__file__).resolve().parents[2]
IMAGE = 'dianjie-four-gap-api:local-v133-b'
IMAGE_ID = 'sha256:89e39760a0b3eb9072e10594701cf2df80c06ba698bf23f2035835a5569bd17d'


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def tree(root):
    files = sorted(path for path in root.rglob('*') if path.is_file() or path.is_symlink())
    h = hashlib.sha256()
    for path in files:
        if path.is_symlink():
            raise ValueError('Symlink in runtime tree: ' + str(path))
        data = path.read_bytes()
        if any(marker in data for marker in (b'local-test-object-storage', b'four-gap.local.invalid', b'dianjie_four_gap_test')):
            raise ValueError('Local fixture in runtime tree: ' + str(path))
        h.update(path.relative_to(root).as_posix().encode() + b'\0' + hashlib.sha256(data).hexdigest().encode() + b'\n')
    return {'files': len(files), 'sha256': h.hexdigest()}


def archive(source, destination):
    with tarfile.open(destination, 'w:gz') as output:
        for path in sorted(source.rglob('*')):
            if path.is_symlink():
                raise ValueError('Symlink in archive source: ' + str(path))
            if path.is_file():
                output.add(path, arcname=path.relative_to(source).as_posix(), recursive=False)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--stage', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--docker-context', default='colima-dianjie-huawei')
    args = p.parse_args()
    stage, destination = args.stage.resolve(), args.output.resolve()
    if destination.exists() or ROOT not in destination.parents:
        raise SystemExit('Output must be a new dedicated project directory')
    build = json.loads((stage / 'build-candidate.json').read_text())
    if build.get('status') != 'local_build_unapproved' or build.get('version') != '1.3.3':
        raise SystemExit('Unexpected build candidate')
    api = stage / 'api-source/apps/api/dist'
    web = stage / 'web-source/apps/web/.next-candidate'
    client = stage / 'api-image-context-v2/prisma-client'
    expected = [('apiDist', api), ('webStandalone', web / 'standalone'), ('webStatic', web / 'static')]
    for name, source in expected:
        if tree(source) != build[name]:
            raise SystemExit('Build tree mismatch: ' + name)
    if sha(web / 'BUILD_ID') != build['webBuildIdSha256'] or not client.is_dir():
        raise SystemExit('BUILD_ID or generated client missing')
    context = json.loads((stage / 'api-image-context-v2/context-manifest.json').read_text())
    if context['apiDistTreeSha256'] != build['apiDist']['sha256']:
        raise SystemExit('API image context mismatch')
    client_files = {item['name']: item['sha256'] for item in context['prismaClientFiles']}
    found = {path.relative_to(client).as_posix(): sha(path) for path in client.rglob('*') if path.is_file()}
    if found != client_files or tree(client)['files'] < 10:
        raise SystemExit('Generated client context mismatch')
    image = subprocess.check_output(['docker', '--context', args.docker_context, 'image', 'inspect', IMAGE, '--format', '{{.Id}} {{.Architecture}}'], text=True).strip()
    if image != IMAGE_ID + ' amd64':
        raise SystemExit('Pinned local API image missing or wrong architecture')

    destination.mkdir(parents=True)
    (destination / 'api/dist').mkdir(parents=True)
    (destination / 'packages/db').mkdir(parents=True)
    (destination / 'packages/db/prisma').mkdir(parents=True)
    (destination / 'web').mkdir(parents=True)
    shutil.copytree(api, destination / 'api/dist', dirs_exist_ok=True)
    shutil.copyfile(stage / 'api-source/packages/db/index.js', destination / 'packages/db/index.js')
    shutil.copyfile(stage / 'api-source/packages/db/prisma/schema.prisma', destination / 'packages/db/prisma/schema.prisma')
    shutil.copyfile(web / 'BUILD_ID', destination / 'web/BUILD_ID')
    archive(client, destination / 'packages/db/client.tar.gz')
    with tarfile.open(destination / 'web/application.tar.gz', 'w:gz') as output:
        for folder, prefix in ((web / 'standalone', 'standalone'), (web / 'static', 'static')):
            for path in sorted(folder.rglob('*')):
                if path.is_symlink():
                    raise SystemExit('Symlink in Web output')
                if path.is_file():
                    output.add(path, arcname=prefix + '/' + path.relative_to(folder).as_posix(), recursive=False)
        output.add(web / 'BUILD_ID', arcname='BUILD_ID', recursive=False)
    save = subprocess.Popen(['docker', '--context', args.docker_context, 'save', IMAGE], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    with (destination / 'api/application.tar.gz').open('wb') as image_output, gzip.GzipFile(fileobj=image_output, mode='wb', mtime=0) as compressed:
        for part in iter(lambda: save.stdout.read(1024 * 1024), b''):
            compressed.write(part)
    stderr = save.stderr.read()
    if save.wait() != 0:
        raise SystemExit('Docker image export failed: ' + stderr.decode(errors='replace'))
    artifacts = {}
    for path in sorted(destination.rglob('*')):
        if path.is_file():
            artifacts[path.relative_to(destination).as_posix()] = sha(path)
    manifest = {'status': 'local_runtime_bundle_unapproved', 'version': '1.3.3', 'apiImageId': IMAGE_ID,
                'buildCandidateSha256': sha(stage / 'build-candidate.json'), 'artifacts': artifacts,
                'limits': ['Not a compatible rollback package or approved release',
                           'No rollback driver or business recovery rehearsal evidence',
                           'No production or UAT keys, data or configuration']}
    (destination / 'runtime-bundle.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': manifest['status'], 'files': len(artifacts), 'output': str(destination)}))


if __name__ == '__main__':
    main()
