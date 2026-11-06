#!/usr/bin/env python3
"""Pin local 1.3.3 candidate build outputs; this does not approve a release."""
import argparse
import hashlib
import json
from pathlib import Path

EXPECTED_NEW_MIGRATIONS = frozenset(
    'packages/db/prisma/migrations/' + name + '/migration.sql' for name in (
        '20261029000000_store_transfer_posting',
        '20261029001000_supplier_reservation_stock_basis',
        '20261029003000_browser_session_intent_sequence',
        '20261029010000_net_cost_basis',
        '20261103000000_warehouse_review_posting',
        '20261104000000_replenishment_submission_holds',
    )
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def verify_migration_scope(stage, scope):
    pins = scope.get('migrationFiles')
    if (scope.get('historicalMigrations', 0) < 100
            or scope.get('newMigrations') != len(EXPECTED_NEW_MIGRATIONS)
            or not isinstance(pins, dict) or set(pins) != EXPECTED_NEW_MIGRATIONS):
        raise ValueError('Incomplete or unexpected migration history in source stage')
    for name, expected in pins.items():
        file = stage / 'api-source' / name
        if not file.is_file() or file.is_symlink() or sha(file.read_bytes()) != expected:
            raise ValueError('Migration source hash mismatch: ' + name)


def tree(root):
    if not root.is_dir() or root.is_symlink():
        raise ValueError(f'Missing build output: {root}')
    h = hashlib.sha256()
    files = sorted(p for p in root.rglob('*') if p.is_file() or p.is_symlink())
    for p in files:
        if p.is_symlink():
            raise ValueError(f'Symlink in build output: {p}')
        data = p.read_bytes()
        if any(marker in data for marker in (b'local-test-object-storage', b'four-gap.local.invalid', b'dianjie_four_gap_test')):
            raise ValueError(f'Local fixture or adapter in build output: {p}')
        h.update(p.relative_to(root).as_posix().encode() + b'\0' + sha(data).encode() + b'\n')
    return {'files': len(files), 'sha256': h.hexdigest()}


def docker_web_overlay(stage, web):
    # Ship new program output over the already pinned Linux dependency image.
    # Native build node_modules links are never dereferenced or packaged.
    baseline = Path(__file__).resolve().parents[2] / 'tmp/release-1.3.2-20261028/web-source'
    source = stage / 'web-source'
    for name in ('pnpm-lock.yaml', 'apps/web/package.json'):
        if (source / name).read_bytes() != (baseline / name).read_bytes():
            raise ValueError('Linux Web dependency baseline changed: ' + name)
    app = web / 'standalone/apps/web'
    runtime = app / '.next-uat-docker'
    for path in (web / 'standalone', app, runtime, app / 'server.js'):
        if path.is_symlink():
            raise ValueError('Symlink in shipped Web program: ' + str(path))
    if not (runtime / 'server/app/api/[...path]/route.js').is_file():
        raise ValueError('Web proxy runtime missing')
    return {
        'webServerSha256': sha((app / 'server.js').read_bytes()),
        'webRuntimeOverlay': tree(runtime),
        'webStatic': tree(web / 'static'),
        'webBuildIdSha256': sha((web / 'BUILD_ID').read_bytes()),
        'webDependencyMode': 'pinned-linux-image-program-overlay',
        'webDependencyLockSha256': sha((source / 'pnpm-lock.yaml').read_bytes()),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--reuse-web-stage', type=Path)
    parser.add_argument('--web-dist-name', choices=('.next-candidate', '.next-uat-docker'), default='.next-candidate')
    args = parser.parse_args()
    stage = args.stage.resolve()
    source_scope = stage / 'source-scope.json'
    scope = json.loads(source_scope.read_text())
    if scope['status'] != 'source_staged_not_built' or scope['version'] != '1.3.3':
        raise ValueError('Unexpected source stage')
    verify_migration_scope(stage, scope)
    api = stage / 'api-source/apps/api/dist'
    web = stage / 'web-source/apps/web' / args.web_dist_name
    reused_web = None
    if args.reuse_web_stage:
        previous = args.reuse_web_stage.resolve()
        previous_scope_path = previous / 'source-scope.json'
        previous_scope = json.loads(previous_scope_path.read_text())
        previous_build_path = previous / 'build-candidate.json'
        previous_build = json.loads(previous_build_path.read_text())
        current_web = {item['path']: item['sha256'] for item in scope['overlays'] if item['path'].startswith('web-source/')}
        previous_web = {item['path']: item['sha256'] for item in previous_scope['overlays'] if item['path'].startswith('web-source/')}
        if (scope['releasedSourceFingerprint'] != previous_scope['releasedSourceFingerprint']
                or current_web != previous_web
                or previous_build['sourceScopeSha256'] != sha(previous_scope_path.read_bytes())):
            raise ValueError('Reused Web source does not match current source')
        context_path = previous / 'uat-web-image-context-v13/context-manifest.json'
        context = json.loads(context_path.read_text())
        if (context['buildManifestSha256'] != sha(previous_build_path.read_bytes())
                or context['buildId'] != previous_build['webBuildId']
                or context['static'] != previous_build['webStatic']
                or context['runtimeOverlay'] != previous_build['webRuntimeOverlay']
                or context['serverSha256'] != previous_build['webServerSha256']):
            raise ValueError('Reused Web build provenance mismatch')
        web = previous / 'web-source/apps/web/.next-uat-docker'
        reused_web = {
            'previousSourceScopeSha256': sha(previous_scope_path.read_bytes()),
            'previousBuildManifestSha256': sha(previous_build_path.read_bytes()),
            'webContextSha256': sha(context_path.read_bytes()),
        }
    build_id = (web / 'BUILD_ID').read_text().strip()
    if not build_id or len(build_id) > 80:
        raise ValueError('Invalid Web BUILD_ID')
    required = [
        'lib/credential-vault.js', 'lib/browser-session.js',
        'services/browserSessionOrder.js', 'services/orderSubmissionReservation.js',
        'services/storeTransferPosting.js', 'services/inventoryNetCostRead.js',
        'services/replenishmentStockReservation.js', 'services/warehouseReviewPosting.js',
    ]
    if any(not (api / name).is_file() for name in required):
        raise ValueError('API compatibility module missing')
    if "'1.3.3'" not in (api / 'lib/release-version.js').read_text():
        raise ValueError('API version mismatch')
    if not reused_web and args.web_dist_name == '.next-uat-docker':
        web_outputs = docker_web_overlay(stage, web)
    else:
        web_outputs = (
        {
            'webServerSha256': previous_build['webServerSha256'],
            'webRuntimeOverlay': previous_build['webRuntimeOverlay'],
            'webStatic': previous_build['webStatic'],
            'webBuildIdSha256': previous_build['webBuildIdSha256'],
            'webReuse': reused_web,
        } if reused_web else {
            'webStandalone': tree(web / 'standalone'),
            'webStatic': tree(web / 'static'),
            'webBuildIdSha256': sha((web / 'BUILD_ID').read_bytes()),
        }
        )
    manifest = {
        'status': 'local_build_unapproved',
        'version': '1.3.3',
        'sourceScopeSha256': sha(source_scope.read_bytes()),
        'apiDist': tree(api),
        **web_outputs,
        'webBuildId': build_id,
        'webDistName': args.web_dist_name,
        'schemaSha256': sha((stage / 'api-source/packages/db/prisma/schema.prisma').read_bytes()),
        'migrationTree': tree(stage / 'api-source/packages/db/prisma/migrations'),
        'limits': ['No runtime dependency bundle or compatible rollback driver assembled',
                   'No isolated recovery rehearsal or offline production key custody',
                   'No UAT HTTPS verification or environment deployment'],
    }
    (stage / 'build-candidate.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': manifest['status'], 'webBuildId': build_id,
                      'apiFiles': manifest['apiDist']['files'],
                      'webRuntimeFiles': manifest.get('webRuntimeOverlay', manifest.get('webStandalone'))['files']}))


if __name__ == '__main__':
    main()
