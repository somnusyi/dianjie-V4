import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

class ReleaseVersionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'scripts/release').mkdir(parents=True)
        shutil.copy2(Path(__file__).with_name('sync-version.py'), self.root / 'scripts/release/sync-version.py')
        for app in ['api', 'web']:
            (self.root / f'apps/{app}/src/lib').mkdir(parents=True)
        self.metadata('1.3.2')
    def metadata(self, version):
        (self.root / 'RELEASE_VERSION.json').write_text(json.dumps({'version': version}))
    def run_script(self, *args):
        return subprocess.run(['python3', str(self.root / 'scripts/release/sync-version.py'), *args], capture_output=True)
    def test_generated_build_constants_are_checked_against_new_release(self):
        self.assertEqual(self.run_script().returncode, 0)
        self.assertEqual(self.run_script('--check').returncode, 0)
        self.metadata('1.3.3')
        self.assertNotEqual(self.run_script('--check').returncode, 0)
        self.assertEqual(self.run_script().returncode, 0)
        self.assertEqual(self.run_script('--check').returncode, 0)
    def test_invalid_release_does_not_overwrite_existing_constants(self):
        self.assertEqual(self.run_script().returncode, 0)
        p = self.root / 'apps/api/src/lib/release-version.ts'
        before = p.read_bytes()
        self.metadata("1.3.2'; process.exit(1); '")
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assertEqual(p.read_bytes(), before)
    def test_partial_or_manually_changed_build_input_is_refused(self):
        self.run_script()
        (self.root / 'apps/web/src/lib/release-version.ts').write_text("export const RELEASE_VERSION = '1.3.1'\n")
        self.assertNotEqual(self.run_script('--check').returncode, 0)

if __name__ == '__main__':
    unittest.main()
