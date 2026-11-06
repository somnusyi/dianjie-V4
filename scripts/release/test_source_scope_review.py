import copy
import hashlib
import importlib.util
import json
import shutil
from pathlib import Path
import tempfile
import unittest


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


stage_source = module('stage_source', 'prepare-four-gap-source.py')
build_audit = module('build_audit', 'audit-four-gap-build.py')


class SourceReview(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.name = 'apps/api/src/services/replenishmentStockReservation.ts'
        file = self.root / self.name
        file.parent.mkdir(parents=True)
        file.write_text('export const synthetic = true\n')
        self.scope = dict(schemaVersion=1, reviewedFor='local-candidate-only',
                          pins={self.name: hashlib.sha256(file.read_bytes()).hexdigest()},
                          additionalChangedPaths=[], additionalNewRuntime=[self.name],
                          additionalMigrations=[], testOnlyExcluded=[])

    def review(self, scope):
        path = self.root / 'review.json'
        path.write_text(json.dumps(scope))
        return stage_source.reviewed_scope(path, self.root)

    def test_only_exact_reviewed_bytes_are_accepted(self):
        self.assertEqual(self.review(self.scope), self.scope)
        (self.root / self.name).write_text('different unreviewed bytes')
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            self.review(self.scope)

    def test_an_unpinned_new_runtime_file_is_refused(self):
        self.scope['additionalNewRuntime'].append('apps/api/src/unreviewed.ts')
        with self.assertRaisesRegex(ValueError, 'Unpinned'):
            self.review(self.scope)

    def test_a_runtime_file_cannot_be_hidden_in_test_exclusions(self):
        self.scope['testOnlyExcluded'] = [self.name]
        with self.assertRaisesRegex(ValueError, 'Only explicit test'):
            self.review(self.scope)

    def test_local_adapter_is_refused_even_with_a_matching_pin(self):
        name = 'apps/api/src/lib/local-test-object-storage.ts'
        self.scope['pins'] = {name: '0' * 64}
        self.scope['additionalNewRuntime'] = [name]
        with self.assertRaisesRegex(ValueError, 'excluded'):
            self.review(self.scope)

    def test_build_requires_the_six_exact_migrations_and_their_real_bytes(self):
        pins = {}
        for name in build_audit.EXPECTED_NEW_MIGRATIONS:
            path = self.root / 'api-source' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('-- synthetic schema fixture\n')
            pins[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        scope = dict(historicalMigrations=130, newMigrations=6, migrationFiles=pins)
        build_audit.verify_migration_scope(self.root, scope)
        missing = copy.deepcopy(scope)
        missing['migrationFiles'].pop(next(iter(pins)))
        with self.assertRaisesRegex(ValueError, 'unexpected migration'):
            build_audit.verify_migration_scope(self.root, missing)
        changed = self.root / 'api-source' / next(iter(pins))
        changed.write_text('-- unreviewed DDL')
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            build_audit.verify_migration_scope(self.root, scope)

    def test_linux_program_overlay_does_not_ship_native_dependency_links(self):
        baseline = Path(build_audit.__file__).resolve().parents[2] / 'tmp/release-1.3.2-20261028/web-source'
        for name in ('pnpm-lock.yaml', 'apps/web/package.json'):
            destination = self.root / 'web-source' / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(baseline / name, destination)
        web = self.root / 'web-source/apps/web/.next-uat-docker'
        app = web / 'standalone/apps/web'
        runtime = app / '.next-uat-docker'
        proxy = runtime / 'server/app/api/[...path]/route.js'
        proxy.parent.mkdir(parents=True)
        proxy.write_text('module.exports = {}')
        (app / 'server.js').write_text('// server fixture')
        (web / 'static').mkdir()
        (web / 'BUILD_ID').write_text('synthetic-build')
        outside = self.root / 'native-dependencies'
        outside.mkdir()
        (outside / 'native.node').write_text('not part of the Linux program overlay')
        (app / 'node_modules').symlink_to(outside, target_is_directory=True)
        result = build_audit.docker_web_overlay(self.root, web)
        self.assertEqual(result['webRuntimeOverlay']['files'], 1)
        (runtime / 'unsafe.js').symlink_to(outside / 'native.node')
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            build_audit.docker_web_overlay(self.root, web)


if __name__ == '__main__':
    unittest.main()
