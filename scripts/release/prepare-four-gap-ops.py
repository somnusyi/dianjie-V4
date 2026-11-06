#!/usr/bin/env python3
"""Stage reviewed G02 operations sources without configuration or credentials."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[2]
SOURCES = (
    'apps/api/scripts/migrate-credentials.ts',
    'apps/api/scripts/migrate-provider-call-logs.ts',
    'scripts/ops/backup.py',
    'scripts/ops/backup_envelope.py',
    'scripts/ops/backup_migrate_encryption.py',
    'scripts/ops/escrow_credential_keyring.py',
    'scripts/ops/install-backup-schedules.cjs',
    'scripts/ops/requirements-backup.txt',
    'scripts/ops/backup-table-policy.json',
    'deploy/ops/dianjie-backup@.service',
    'deploy/ops/dianjie-backup@.timer',
    'scripts/release/rollback_compatibility.py',
    'scripts/rollback.sh',
)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() or output == ROOT or ROOT not in output.parents:
        raise SystemExit('Output must be a new dedicated directory below the project root')

    sources = {}
    for name in SOURCES:
        source = ROOT / name
        if not source.is_file() or source.is_symlink() or source.resolve() != source:
            raise SystemExit('Missing or unsafe operations source: ' + name)
        sources[name] = sha256(source)
    output.mkdir(parents=True)
    for name in SOURCES:
        destination = output / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, destination)
        if sha256(destination) != sources[name]:
            raise SystemExit('Operations source changed during staging: ' + name)
    manifest = {
        'status': 'operations_source_staged_unapproved',
        'version': '1.3.3',
        'purpose': 'G02 source review and local rehearsal only',
        'files': sources,
        'limits': [
            'No private configuration, keyring, recovery key or database dump is included.',
            'TypeScript migration scripts require the reviewed API runtime dependencies.',
            'Backup installation and credential migration have not run on UAT or production.',
            'The compatibility gate is read-only; isolated rehearsal tooling is reviewed in a separate local qualification package, not shipped as an online rollback driver.',
            'No recovery manifest, synthetic key escrow or target deployment authorization is included.',
            'The legacy rollback entrypoint is disabled locally; remote legacy copies are not changed.',
        ],
    }
    (output / 'operations-source.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': manifest['status'], 'files': len(sources), 'output': str(output)}))


if __name__ == '__main__':
    main()
