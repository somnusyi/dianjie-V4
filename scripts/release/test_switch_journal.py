import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest

import switch_journal as journal


def metadata():
    return {'operationId': '012345abcdef', 'planSha256': 'a' * 64,
            'controllerSha256': 'b' * 64, 'network': 'dianjie-compat-test',
            'previous': {role: {'id': ('a' if role == 'api' else 'b') * 64, 'imageId': 'sha256:' + 'c' * 64,
                                'name': '/dianjie-compat-test-' + role} for role in ('api', 'web')},
            'candidateNames': {role: 'dianjie-compat-recovery-' + role + '-012345abcdef' for role in ('api', 'web')},
            'candidateImages': {'api': 'sha256:' + 'd' * 64, 'web': 'sha256:' + 'e' * 64}}


class JournalTests(unittest.TestCase):
    def test_real_sigkill_preserves_each_pending_phase_and_prevents_overwrite(self):
        # Each fresh child durably writes a checkpoint then dies without cleanup.
        for phase in sorted(journal.PHASES - journal.TERMINAL):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / 'journal.json'
                code = ('import json,os,signal,sys; import switch_journal as j; '
                        'x=j.Journal(sys.argv[1],json.loads(sys.argv[2])); '
                        'x.write(sys.argv[3]); os.kill(os.getpid(),signal.SIGKILL)')
                result = subprocess.run([sys.executable, '-c', code, str(path), json.dumps(metadata()), phase],
                    cwd=Path(journal.__file__).parent, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, -signal.SIGKILL)
                self.assertEqual(journal.read(path)['phase'], phase)
                before = path.read_bytes()
                with self.assertRaisesRegex(journal.JournalError, 'IDENTITY_RECONCILIATION'):
                    journal.Journal(path, metadata())
                self.assertEqual(path.read_bytes(), before)

    def test_completed_record_allows_next_operation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'journal.json'
            for terminal in journal.TERMINAL:
                record = journal.Journal(path, metadata()); record.write(terminal)
                journal.check_no_pending(path)
                self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    def test_rejects_symlink_permissions_and_unexpected_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'journal.json'; journal.Journal(path, metadata())
            link = Path(tmp) / 'link'; link.symlink_to(path)
            with self.assertRaises(journal.JournalError): journal.check_no_pending(link)
            path.chmod(0o644)
            with self.assertRaises(journal.JournalError): journal.read(path)
            extra = metadata(); extra['environment'] = {'SECRET': 'never persist'}
            with self.assertRaises(journal.JournalError): journal.Journal(Path(tmp) / 'bad', extra)
            extra = metadata(); extra['previous']['api']['Config'] = {'Env': ['SECRET=never persist']}
            with self.assertRaises(journal.JournalError): journal.Journal(Path(tmp) / 'bad', extra)
            self.assertFalse((Path(tmp) / 'bad').exists())

    def test_nested_tampering_is_rejected_before_inspection(self):
        mutations = [
            lambda x: x['previous']['api'].update(id='a'),
            lambda x: x['previous']['api'].update(environment={'secret':'do-not-store'}),
            lambda x: x['candidateNames'].update(api='.*'),
            lambda x: x['candidateImages'].update(api='latest'),
            lambda x: x.update(network='bridge'),
            lambda x: x.update(operationId='wrong'),
            lambda x: x['previous'].update(web=x['previous']['api'].copy()),
            lambda x: x.update(format=True),
            lambda x: x.update(candidateImages=[]),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate), tempfile.TemporaryDirectory() as tmp:
                path=Path(tmp)/'journal'; record=journal.Journal(path,metadata())
                bad=json.loads(path.read_text());mutate(bad);path.write_text(json.dumps(bad))
                before=path.read_bytes()
                with self.assertRaises(journal.JournalError):journal.read(path)
                with self.assertRaises(journal.JournalError):journal.check_no_pending(path)
                self.assertEqual(path.read_bytes(),before)

    def test_truncated_journal_never_treated_as_safe_to_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'journal.json'; journal.Journal(path, metadata())
            path.write_text('{')
            with self.assertRaises(ValueError): journal.check_no_pending(path)


if __name__ == '__main__':
    unittest.main()
