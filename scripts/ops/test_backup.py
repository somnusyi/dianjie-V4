import importlib.util
import io
import os
import time
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backup', Path(__file__).with_name('backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupSafety(unittest.TestCase):
    def test_rejects_traversal_before_extraction(self):
        with tempfile.TemporaryDirectory() as folder:
            archive = Path(folder) / 'bad.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                entry = tarfile.TarInfo('../outside')
                entry.size = 1
                tar.addfile(entry, io.BytesIO(b'x'))
            with self.assertRaises(ValueError):
                backup.extract_checked(archive, Path(folder) / 'out')
            self.assertFalse((Path(folder).parent / 'outside').exists())

    def test_rejects_links(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'files'
            source.mkdir()
            (source / 'link').symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):
                backup.inventory(source)

    def test_missing_offsite_is_never_reported_as_verified(self):
        with self.assertRaises(ValueError):
            backup.offsite({}, Path('archive'))
        self.assertEqual(backup.offsite({'isolated_test': True}, Path('archive'))['status'], 'local_only_not_offsite')

    def test_weekly_backup_closes_reference_dependencies_and_keeps_unknown_tables(self):
        with tempfile.TemporaryDirectory() as folder:
            policy = Path(folder) / 'policy.json'
            policy.write_text(json.dumps({'version': 1, 'monthly_only_tables': ['logs', 'chat', 'feedback']}))
            catalog = {'tables': ['orders', 'new_important_table', 'logs', 'chat', 'feedback'],
                       'references': [['orders', 'logs'], ['logs', 'chat']]}
            with patch.object(backup, 'run', return_value=json.dumps(catalog).encode()):
                plan = backup.table_plan({'backup_tier': 'critical', 'table_policy': str(policy)}, {})
            self.assertEqual(plan['excludedDataTables'], ['feedback'])
            self.assertEqual(plan['promotedDependencyTables'], ['chat', 'logs'])
            self.assertIn('new_important_table', plan['includedDataTables'])

    def test_weekly_policy_typo_or_unsafe_pattern_fails_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            policy = Path(folder) / 'policy.json'
            for names in [['misspelled_table'], ['logs*'], []]:
                policy.write_text(json.dumps({'version': 1, 'monthly_only_tables': names}))
                with patch.object(backup, 'run', return_value=json.dumps({'tables': ['orders', 'logs'], 'references': []}).encode()):
                    with self.assertRaises(ValueError):
                        backup.table_plan({'backup_tier': 'critical', 'table_policy': str(policy)}, {})

    def test_monthly_snapshot_includes_every_table_and_legacy_configs_stay_full(self):
        with patch.object(backup, 'run') as command:
            for config in [{}, {'backup_tier': 'full'}]:
                self.assertEqual(backup.table_plan(config, {})['excludedDataTables'], [])
            command.assert_not_called()

    def test_freshness_respects_weekly_monthly_intervals_and_future_clock_errors(self):
        now = backup.dt.datetime(2026, 10, 27, tzinfo=backup.dt.timezone.utc)
        def result(days):
            return {'at': (now - backup.dt.timedelta(days=days)).isoformat()}
        backup.check_freshness({'maximum_age_hours': 9 * 24}, result(8), now)
        backup.check_freshness({'maximum_age_hours': 35 * 24}, result(31), now)
        for config, days in [({'maximum_age_hours': 9 * 24}, 10),
                             ({'maximum_age_hours': 35 * 24}, 36), ({}, -1),
                             ({'maximum_age_hours': True}, 0), ({'maximum_age_hours': 0}, 0)]:
            with self.assertRaises(ValueError):
                backup.check_freshness(config, result(days), now)

    def test_same_host_is_not_offsite(self):
        with self.assertRaises(ValueError):
            backup.offsite({'offsite': {'host': 'backup@localhost', 'directory': '/backups'}}, Path('archive'))

    def test_restore_cannot_target_live_or_original_database(self):
        for url in ['postgresql://u@remote:15439/dianjie_x_restore_test',
                    'postgresql://u@127.0.0.1:5432/dianjie_x_restore_test',
                    'postgresql://u@127.0.0.1:15439/dianjie_mouse_test']:
            with patch.dict(backup.os.environ, {'RESTORE_DATABASE_URL': url}), patch.object(backup, 'run') as run:
                with self.assertRaises(ValueError):
                    backup.restore(Path('ignored'), 'RESTORE_DATABASE_URL', '/not-created')
                run.assert_not_called()

    def test_failed_dump_has_no_success_archive(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'attachments'
            source.mkdir()
            (source / 'image').write_bytes(b'picture')
            destination = Path(folder) / 'backups'
            config = {'attachment_directory': str(source), 'directory': str(destination), 'isolated_test': True}
            with patch.dict(backup.os.environ, {'DATABASE_URL': 'postgresql://u@127.0.0.1:15439/dianjie_mouse_test'}), patch.object(backup, 'run', side_effect=RuntimeError('pg_dump failed')):
                with self.assertRaises(RuntimeError):
                    backup.backup(config)
            self.assertEqual(list(destination.glob('*.tar.gz')), [])
            self.assertFalse((destination / 'last-result.json').exists())

    def test_content_addressed_roundtrip_and_missing_blob_detection(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'source'; source.mkdir()
            (source / 'image').write_bytes(b'picture')
            config = {'attachment_directory': str(source), 'directory': str(root / 'prod'),
                      'content_addressed': True, 'offsite_deferred': True, 'minimum_free_bytes': 0}
            def command(argv, env=None):
                if argv[0] == 'pg_dump':
                    Path(argv[-1]).write_bytes(b'snapshot')
                return b''
            with patch.dict(backup.os.environ, {'DATABASE_URL': 'postgresql://u@127.0.0.1:15439/dianjie_mouse_test'}), patch.object(backup, 'run', side_effect=command):
                first = backup.backup(config)
                second = backup.backup(config)
                self.assertNotEqual(first['archive'], second['archive'])
                self.assertEqual(len(list((root / 'blobs').iterdir())), 1)
                archive = root / 'prod' / second['archive']
                self.assertEqual(backup.verify_archive(archive)['format'], 2)
                with patch.dict(backup.os.environ, {'RESTORE_DATABASE_URL': 'postgresql://u@127.0.0.1:15439/dianjie_cas_restore_test'}):
                    backup.restore(archive, 'RESTORE_DATABASE_URL', str(root / 'restored'))
                self.assertEqual((root / 'restored' / 'image').read_bytes(), b'picture')
                next((root / 'blobs').iterdir()).write_bytes(b'corrupt')
                with self.assertRaises(ValueError):
                    backup.verify_archive(archive)

    def test_unconfigured_notification_does_not_claim_delivery(self):
        self.assertFalse(backup.notify({'failure_webhook_env': 'NOT_CONFIGURED_BACKUP_WEBHOOK'}, False))

    def test_low_disk_prevents_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'source'; source.mkdir()
            config = {'attachment_directory': str(source), 'directory': str(Path(folder) / 'prod'), 'minimum_free_bytes': 10**20}
            with patch.dict(backup.os.environ, {'DATABASE_URL': 'postgresql://u@127.0.0.1:15439/dianjie_mouse_test'}), patch.object(backup, 'run') as command:
                with self.assertRaises(ValueError): backup.backup(config)
                command.assert_not_called()

    def test_expiration_only_removes_owned_old_archives_and_keeps_two(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for i in range(4):
                path = root / f'dianjie-2020010{i+1}T000000Z-1234abcd.tar.gz'
                path.write_bytes(b'old'); os.utime(path, (time.time()-40*86400+i,)*2)
            unrelated = root / 'manual-keep.tar.gz'; unrelated.write_bytes(b'keep')
            self.assertEqual(backup.expire_archives(root, 30), 2)
            self.assertEqual(len(list(root.glob('dianjie-*.tar.gz'))), 2)
            self.assertTrue(unrelated.exists())

    def test_failure_notification_is_exercised_only_on_local_receiver(self):
        received = []
        class Receiver(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append(self.rfile.read(int(self.headers['Content-Length'])))
                self.send_response(200); self.end_headers()
            def log_message(self, *args): pass
        server = HTTPServer(('127.0.0.1', 0), Receiver)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with patch.dict(backup.os.environ, {'LOCAL_BACKUP_WEBHOOK': f'http://127.0.0.1:{server.server_port}/event'}):
                self.assertTrue(backup.notify({'isolated_test': True, 'failure_webhook_env': 'LOCAL_BACKUP_WEBHOOK'}, False))
            self.assertEqual(json.loads(received[0])['event'], 'dianjie_backup_failed')
            self.assertNotIn(b'DATABASE_URL', received[0])
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_modified_archive_cannot_restore(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'attachments').mkdir()
            (root / 'database.dump').write_bytes(b'changed database')
            (root / 'manifest.json').write_text(json.dumps({'format': 1, 'databaseSha256': 'wrong', 'attachments': {}}))
            archive = root / 'bad.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                for name in ['database.dump', 'manifest.json', 'attachments']:
                    tar.add(root / name, arcname=name)
            with self.assertRaises(ValueError):
                backup.verify_archive(archive)


if __name__ == '__main__':
    unittest.main()
