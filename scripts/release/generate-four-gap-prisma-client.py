#!/usr/bin/env python3
"""Generate a Prisma client for the staged schema without touching workspace node_modules."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[2]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    a = parser.parse_args()
    stage = a.stage.resolve()
    build = json.loads((stage / 'build-candidate.json').read_text())
    source = stage / 'api-source/packages/db/prisma/schema.prisma'
    if build['status'] != 'local_build_unapproved' or sha(source) != build['schemaSha256']:
        raise SystemExit('Candidate schema or build manifest mismatch')
    gen = stage / 'prisma-client-build'
    if gen.exists() and not (gen / 'schema.prisma').is_file():
        raise SystemExit('Generator directory has unexpected contents')
    gen.mkdir(exist_ok=True)
    raw = source.read_text()
    marker = 'generator client {\n'
    if raw.count(marker) != 1 or '  output = ' in raw.split('}', 1)[0]:
        raise SystemExit('Unexpected Prisma generator definition')
    replacement = marker + '  output = "../generated-prisma-client"\n'
    schema = gen / 'schema.prisma'
    generated_input = raw.replace(marker, replacement, 1)
    if schema.exists() and schema.read_text() != generated_input:
        raise SystemExit('Generator schema drift')
    schema.write_text(generated_input)
    cli = ROOT / 'node_modules/prisma/build/index.js'
    env = {k: v for k, v in os.environ.items() if k not in {
        'DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'CREDENTIAL_ENCRYPTION_KEYS',
        'SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN'}}
    done = subprocess.run(['node', str(cli), 'generate', '--schema', str(schema)], cwd=gen, env=env,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if done.returncode:
        raise SystemExit('Prisma generation failed: ' + done.stderr[-1200:])
    client = stage / 'generated-prisma-client'
    if not (client / 'index.js').is_file() or not (client / 'libquery_engine-debian-openssl-3.0.x.so.node').is_file():
        raise SystemExit('Linux Prisma client output incomplete')
    diff = subprocess.run(['node', str(cli), 'migrate', 'diff', '--from-schema-datamodel', str(source),
                           '--to-schema-datamodel', str(client / 'schema.prisma'), '--script'],
                          cwd=gen, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if diff.returncode or diff.stdout.strip() != '-- This is an empty migration.':
        raise SystemExit('Generated client schema is not semantically equivalent')
    receipt = {'status': 'generated_for_unapproved_candidate', 'sourceSchemaSha256': sha(source),
               'generatedSchemaSha256': sha(client / 'schema.prisma'), 'schemaDiff': 'empty',
               'generatedClientIndexSha256': sha(client / 'index.js'),
               'linuxEngineSha256': sha(client / 'libquery_engine-debian-openssl-3.0.x.so.node')}
    (gen / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
