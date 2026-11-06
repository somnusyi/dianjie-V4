#!/usr/bin/env python3
"""Generate build-time constants from the one authoritative release name."""
import argparse
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[2]
p = argparse.ArgumentParser()
p.add_argument('--check', action='store_true')
args = p.parse_args()
version = json.loads((root / 'RELEASE_VERSION.json').read_text())['version']
if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version):
    raise SystemExit('Expected a stable SemVer release version')
text = "// Generated from RELEASE_VERSION.json for this release; do not edit independently.\nexport const RELEASE_VERSION = '" + version + "' as const\n"
for rel in ('apps/api/src/lib/release-version.ts', 'apps/web/src/lib/release-version.ts'):
    path = root / rel
    if args.check:
        if not path.exists() or path.read_text() != text:
            raise SystemExit('Version constant mismatch: ' + rel)
    else:
        path.write_text(text)
print(('Verified' if args.check else 'Generated') + ' version ' + version)
