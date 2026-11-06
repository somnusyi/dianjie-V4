#!/usr/bin/env python3
"""Prepare a local Linux API image context from a pinned, unapproved build."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[2]
BASE_IMAGE = 'sha256:33430aa2bc9effcba7839b316a11e50124e3fcb072c0f996361bd40761dcfa5f'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--stage', type=Path, required=True)
    p.add_argument('--context-name', default='api-image-context')
    a = p.parse_args()
    stage = a.stage.resolve()
    build = json.loads((stage / 'build-candidate.json').read_text())
    if build['status'] != 'local_build_unapproved' or build['version'] != '1.3.3':
        raise SystemExit('Unexpected build candidate')
    schema = stage / 'api-source/packages/db/prisma/schema.prisma'
    client_source = stage / 'generated-prisma-client'
    receipt = json.loads((stage / 'prisma-client-build/receipt.json').read_text())
    if digest(schema) != build['schemaSha256'] or receipt['sourceSchemaSha256'] != build['schemaSha256'] or digest(client_source / 'index.js') != receipt['generatedClientIndexSha256']:
        raise SystemExit('Generated Prisma client does not match candidate schema')
    if digest(client_source / 'schema.prisma') != receipt['generatedSchemaSha256'] or receipt['schemaDiff'] != 'empty':
        raise SystemExit('Generated Prisma schema changed')
    if not (client_source / 'libquery_engine-debian-openssl-3.0.x.so.node').is_file():
        raise SystemExit('Linux Prisma engine missing')
    if not a.context_name.startswith('api-image-context') or '/' in a.context_name or '..' in a.context_name:
        raise SystemExit('Unsafe image context name')
    context = stage / a.context_name
    if context.exists():
        raise SystemExit('Image context already exists; inspect instead of replacing')
    context.mkdir()
    dist = context / 'api-dist'
    shutil.copytree(stage / 'api-source/apps/api/dist', dist)
    db_index = context / 'db-index.js'
    shutil.copyfile(stage / 'api-source/packages/db/index.js', db_index)
    client = context / 'prisma-client'
    client.mkdir()
    copied = []
    for source in sorted(client_source.rglob('*')):
        if not source.is_file() or source.is_symlink() or 'darwin' in source.name:
            continue
        if source.suffix not in {'.js', '.ts', '.json', '.node', '.prisma'}:
            continue
        relative = source.relative_to(client_source)
        dest = client / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
        copied.append({'name': relative.as_posix(), 'sha256': digest(dest)})
    if len(copied) < 10:
        raise SystemExit('Prisma client context incomplete')
    if not (client / 'runtime/library.js').is_file():
        raise SystemExit('Prisma runtime library missing')
    manifest = {'status': 'local_api_image_context_unapproved', 'version': '1.3.3',
                'baseImage': BASE_IMAGE, 'buildManifestSha256': digest(stage / 'build-candidate.json'),
                'schemaSha256': build['schemaSha256'], 'apiDistTreeSha256': build['apiDist']['sha256'],
                'dbIndexSha256': digest(db_index), 'prismaClientFiles': copied}
    (context / 'context-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'status': manifest['status'], 'prismaClientFiles': len(copied), 'context': str(context)}))


if __name__ == '__main__':
    main()
