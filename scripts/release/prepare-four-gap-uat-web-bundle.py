#!/usr/bin/env python3
"""Package the audited, locally runnable UAT Web candidate without deploying."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile


ROOT = Path(__file__).resolve().parents[2]


def digest(path):
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
            if path.readlink().is_absolute() or root.resolve() not in path.resolve(strict=True).parents:
                raise ValueError('Unsafe build symlink: ' + str(path))
            data = b'link:' + path.readlink().as_posix().encode()
        else:
            data = path.read_bytes()
        if any(token in data for token in (b'local-test-object-storage', b'four-gap.local.invalid', b'dianjie_four_gap_test')):
            raise ValueError('Local fixture in Web runtime: ' + str(path))
        h.update(path.relative_to(root).as_posix().encode() + b'\0' + hashlib.sha256(data).hexdigest().encode() + b'\n')
    return {'files': len(files), 'sha256': h.hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    stage, output = args.stage.resolve(), args.output.resolve()
    if output.exists() or ROOT not in output.parents:
        raise SystemExit('Output must be a new dedicated project directory')
    build = stage / 'web-source/apps/web/.next-uat-isolated'
    audit_path = stage / 'uat-web-build-candidate.json'
    audit = json.loads(audit_path.read_text())
    if audit.get('status') != 'local_uat_web_build_unapproved' or audit.get('target') != 'uat' or audit.get('buildId') != (build / 'BUILD_ID').read_text().strip():
        raise SystemExit('Unexpected UAT Web audit')
    if digest(stage / 'source-scope.json') != audit['sourceScopeSha256'] or digest(build / 'BUILD_ID') != audit['buildIdSha256']:
        raise SystemExit('Source or BUILD_ID drift after UAT audit')
    if tree(build / 'standalone') != audit['standalone'] or tree(build / 'static') != audit['static']:
        raise SystemExit('UAT build tree drift after audit')
    source = stage / 'web-source/apps/web'
    roots = ((build / 'standalone', Path('standalone')),
             (build / 'static', Path('standalone/apps/web/.next-uat-isolated/static')),
             (source / 'public', Path('standalone/apps/web/public')))
    entries = []
    for folder, prefix in roots:
        if not folder.is_dir():
            raise SystemExit('Missing Web build folder: ' + str(folder))
        for path in sorted(folder.rglob('*')):
            if path.is_dir() and not path.is_symlink():
                continue
            if path.is_symlink():
                if path.readlink().is_absolute() or folder.resolve() not in path.resolve(strict=True).parents:
                    raise SystemExit('Unsafe Web build symlink: ' + str(path))
            elif not path.is_file():
                raise SystemExit('Unexpected Web build entry: ' + str(path))
            entries.append((path, prefix / path.relative_to(folder)))
    if len(entries) < 4000:
        raise SystemExit('Incomplete UAT Web runtime')
    output.mkdir(parents=True)
    archive = output / 'application.tar.gz'
    with tarfile.open(archive, 'w:gz', dereference=False) as tar:
        for source_path, target in entries:
            tar.add(source_path, arcname=target.as_posix(), recursive=False)
    manifest = {'status': 'local_uat_web_bundle_unapproved', 'version': '1.3.3',
                'target': 'uat', 'buildId': audit['buildId'], 'buildAuditSha256': digest(audit_path),
                'archiveSha256': digest(archive), 'archiveMembers': len(entries),
                'limits': ['Built on macOS; Linux native runtime remains unverified.',
                           'UAT HTTPS and same-origin secure cookie behavior remain unverified.',
                           'No deployment or compatibility recovery approval.']}
    (output / 'bundle.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': manifest['status'], 'members': len(entries), 'manifestSha256': digest(output / 'bundle.json')}))


if __name__ == '__main__':
    main()
