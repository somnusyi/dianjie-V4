#!/usr/bin/env python3
"""Stage the four-gap candidate from the recorded 1.3.2 source snapshot.

This creates source review material only. It does not build, publish, or deploy.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'tmp/release-1.3.2-20261028'
SOURCE_RECORD = BASE / 'source.json'
GOAL_BASELINE = ROOT / 'tmp/four-gap-20261028/baseline-hashes.json'
SCOPE_RECORD = ROOT / 'tmp/four-gap-20261028/source-scope-current.json'
SUPPLEMENTAL_SCOPE = ROOT / 'docs/releases/1.3.3-SOURCE-SCOPE.json'

# Files which changed after the goal snapshot but predate its first scope index.
LATE_CHANGES = {
    # P01 mouse acceptance: single warehouse shipment picker and stock messages.
    'apps/web/src/app/v2/supplier/orders/[id]/page.tsx',
    'apps/web/src/lib/partial-shipment-ui.ts',
    'apps/api/src/lib/release-version.ts',
    'apps/web/src/lib/release-version.ts',
    'apps/web/src/lib/order-entry-stock-policy.ts',
    'apps/api/src/services/inventoryReportSupplement.ts',
}
# G02 files already edited before the four-gap baseline was taken.
PRE_GOAL_G02 = {
    'apps/api/src/routes/stores.ts',
    'apps/api/src/services/meituan/tokenStore.ts',
    'apps/api/src/lib/credential-vault.ts',
    'apps/api/src/lib/credential-migration.ts',
}
NEW_RUNTIME = {
    'apps/api/src/lib/authenticate-principal.ts',
    'apps/api/src/lib/browser-session.ts',
    'apps/api/src/lib/credential-migration.ts',
    'apps/api/src/lib/credential-vault.ts',
    'apps/api/src/lib/provider-log-migration.ts',
    'apps/api/src/lib/provider-log-safety.ts',
    'apps/api/src/lib/revoke-session.ts',
    'apps/api/src/lib/safe-request-log.ts',
    'apps/api/src/routes/inventoryNetCostBasis.ts',
    'apps/api/src/services/browserSessionOrder.ts',
    'apps/api/src/services/inventoryNetCost.ts',
    'apps/api/src/services/inventoryNetCostBasis.ts',
    'apps/api/src/services/inventoryNetCostRead.ts',
    'apps/api/src/services/inventoryNetReportProjection.ts',
    'apps/api/src/services/orderSubmissionReservation.ts',
    'apps/api/src/services/replenishmentStockReservation.ts',
    'apps/api/src/services/storeTransferPosting.ts',
    'apps/web/src/components/session-bootstrap.tsx',
    'apps/web/src/components/v2/inventory-cost-basis-sheet.tsx',
    'apps/web/src/lib/purchase-order-draft.ts',
    'apps/web/src/lib/safe-telemetry.ts',
}
SUPPORT = {
    'apps/web/sentry.client.config.ts',
    'apps/web/sentry.edge.config.ts',
    'apps/web/sentry.server.config.ts',
    'packages/db/src/index.ts',
    'packages/db/index.js',
    'packages/db/prisma/schema.prisma',
    'RELEASE_VERSION.json',
}
MIGRATIONS = {
    'packages/db/prisma/migrations/20261029000000_store_transfer_posting/migration.sql',
    'packages/db/prisma/migrations/20261029001000_supplier_reservation_stock_basis/migration.sql',
    'packages/db/prisma/migrations/20261029003000_browser_session_intent_sequence/migration.sql',
    'packages/db/prisma/migrations/20261029010000_net_cost_basis/migration.sql',
    'packages/db/prisma/migrations/20261104000000_replenishment_submission_holds/migration.sql',
}
EXCLUDE = {
    'apps/api/src/routes/invoices.ts',
    'apps/api/src/routes/upload.ts',
    'apps/api/src/lib/local-test-object-storage.ts',
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def reviewed_scope(path, root):
    scope = json.loads(path.read_text())
    if scope.get('schemaVersion') != 1 or scope.get('reviewedFor') != 'local-candidate-only':
        raise ValueError('Unexpected supplemental source review')
    pins = scope.get('pins')
    if not isinstance(pins, dict) or not pins:
        raise ValueError('Reviewed source hashes required')
    for name, expected in pins.items():
        if (not name.startswith(('apps/api/src/', 'apps/web/src/', 'packages/db/prisma/'))
                or '..' in Path(name).parts or name in EXCLUDE):
            raise ValueError('Unsafe or excluded reviewed source: ' + name)
        file = root / name
        if not file.is_file() or file.is_symlink() or digest(file) != expected:
            raise ValueError('Reviewed source hash mismatch: ' + name)
    for field in ('additionalChangedPaths', 'additionalNewRuntime', 'additionalMigrations', 'testOnlyExcluded'):
        names = scope.get(field)
        if not isinstance(names, list) or len(set(names)) != len(names) or not set(names).issubset(pins):
            raise ValueError('Unpinned supplemental source list: ' + field)
    if any('.test.' not in name and '.contract.' not in name for name in scope['testOnlyExcluded']):
        raise ValueError('Only explicit test files may be excluded as tests')
    return scope


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    output = args.output.resolve()
    if output.exists() or output == ROOT or ROOT in output.parents and output.name in ('apps', 'packages'):
        raise SystemExit('Output must be a new, dedicated directory')

    release = json.loads(SOURCE_RECORD.read_text())
    if release['version'] != '1.3.2':
        raise SystemExit('Unexpected released source version')
    for name, sha in release['files'].items():
        file = BASE / name
        if not file.is_file() or file.is_symlink() or digest(file) != sha:
            raise SystemExit('Released source snapshot mismatch: ' + name)

    baseline = json.loads(GOAL_BASELINE.read_text())
    scope = json.loads(SCOPE_RECORD.read_text())
    supplemental = reviewed_scope(SUPPLEMENTAL_SCOPE, ROOT)
    recorded_changes = set(scope['changedSinceGoalBaseline']) | LATE_CHANGES | set(supplemental['additionalChangedPaths'])
    changed = {
        name for name, sha in baseline.items()
        if name.startswith(('apps/api/src/', 'apps/web/src/', 'packages/db/prisma/'))
        and (not (ROOT / name).is_file() or digest(ROOT / name) != sha)
    }
    # Local-only adapters are always replaced by the recorded release files.
    # Report their drift separately; never pin them as approved runtime inputs.
    if changed - EXCLUDE != recorded_changes - EXCLUDE:
        raise SystemExit('Goal source changes need review: ' + repr(sorted((changed ^ recorded_changes) - EXCLUDE)))

    released_runtime = {
        name.removeprefix('api-source/') for name in release['files']
        if name.startswith('api-source/apps/api/src/')
    } | {
        name.removeprefix('web-source/') for name in release['files']
        if name.startswith('web-source/apps/web/src/')
    }
    current_runtime = {
        file.relative_to(ROOT).as_posix()
        for folder in ('apps/api/src', 'apps/web/src')
        for file in (ROOT / folder).rglob('*')
        if file.is_file() and '.test.' not in file.name and '.contract.' not in file.name
    }
    new_runtime = current_runtime - released_runtime
    reviewed_new_runtime = NEW_RUNTIME | set(supplemental['additionalNewRuntime'])
    if new_runtime != reviewed_new_runtime | {'apps/api/src/lib/local-test-object-storage.ts'}:
        raise SystemExit('New runtime files need review: ' + repr(sorted(new_runtime ^ (reviewed_new_runtime | {'apps/api/src/lib/local-test-object-storage.ts'}))))

    historical_migrations = {
        name for name in baseline
        if name.startswith('packages/db/prisma/migrations/')
    }
    if len(historical_migrations) < 100 or not any(name.endswith('/migration_lock.toml') for name in historical_migrations):
        raise SystemExit('Historical migration inventory incomplete')
    for name in historical_migrations:
        file = ROOT / name
        if not file.is_file() or file.is_symlink() or digest(file) != baseline[name]:
            raise SystemExit('Historical migration drift: ' + name)
    migrations = MIGRATIONS | set(supplemental['additionalMigrations'])
    overlays = (recorded_changes | PRE_GOAL_G02 | reviewed_new_runtime | SUPPORT | migrations | historical_migrations) - EXCLUDE - set(supplemental['testOnlyExcluded'])
    overlays = {name for name in overlays if '.test.' not in name and '.contract.' not in name}
    for name in overlays:
        file = ROOT / name
        if not file.is_file() or file.is_symlink():
            raise SystemExit('Missing or unsafe overlay: ' + name)
    output.mkdir(parents=True)
    def skip_generated(directory, names):
        ignored = {'node_modules', '.next', 'dist', '.turbo', 'coverage', '__pycache__', 'tests'}
        return {name for name in names if name in ignored or (Path(directory) / name).is_symlink()}

    for kind in ('api', 'web'):
        shutil.copytree(BASE / f'{kind}-source', output / f'{kind}-source', ignore=skip_generated)
    applied = []
    for name in sorted(overlays):
        destinations = ['api-source'] if name.startswith(('apps/api/', 'packages/db/')) else ['web-source']
        if name == 'RELEASE_VERSION.json':
            destinations = ['api-source', 'web-source']
        for kind in destinations:
            dest = output / kind / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, dest)
            applied.append({'path': f'{kind}/{name}', 'sha256': digest(dest)})
    # The API build also reads its generated version constants from this source stage.
    assert not (output / 'api-source/apps/api/src/lib/local-test-object-storage.ts').exists()
    assert not (output / 'api-source/apps/api/src/routes/invoices.ts').read_bytes() == (ROOT / 'apps/api/src/routes/invoices.ts').read_bytes()
    assert not (output / 'api-source/apps/api/src/routes/upload.ts').read_bytes() == (ROOT / 'apps/api/src/routes/upload.ts').read_bytes()
    manifest = {'status': 'source_staged_not_built', 'version': '1.3.3', 'releasedSourceFingerprint': release['sourceFingerprint'],
                'excludedLocalAdapters': sorted(EXCLUDE),
                'excludedLocalAdapterDrift': sorted(changed & EXCLUDE),
                'historicalMigrations': len(historical_migrations),
                'newMigrations': len(migrations), 'migrationFiles': {name: digest(ROOT / name) for name in sorted(migrations)},
                'supplementalReviewSha256': digest(SUPPLEMENTAL_SCOPE), 'overlays': applied}
    (output / 'source-scope.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': manifest['status'], 'overlays': len(applied), 'output': str(output)}))


if __name__ == '__main__':
    main()
