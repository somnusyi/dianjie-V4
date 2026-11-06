"""Regression checks for stale or mislabeled forward UAT images."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    'delivery_audit', Path(__file__).with_name('audit-four-gap-uat-delivery.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class DeliveryIdentityTests(unittest.TestCase):
    def rejects(self, api, web, expected):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'delivery-candidate.json').write_text(json.dumps({
                'status': 'local_uat_delivery_candidate_unapproved',
                'version': '1.3.3', 'target': 'uat', 'artifacts': {},
                'apiImageId': api, 'webImageId': web,
            }))
            with patch('sys.argv', ['audit', '--root', temporary]), \
                    patch.object(audit, 'image_identity', return_value='sha256:wrong'), \
                    self.assertRaisesRegex(ValueError, expected):
                audit.main()

    def test_old_api_rejected(self):
        self.rejects(
            'sha256:89e39760a0b3eb9072e10594701cf2df80c06ba698bf23f2035835a5569bd17d',
            audit.WEB_ID, 'current pinned images')

    def test_missing_api_rejected(self):
        self.rejects(None, audit.WEB_ID, 'current pinned images')

    def test_wrong_web_rejected(self):
        self.rejects(audit.API_ID, 'sha256:wrong', 'current pinned images')

    def test_relabeled_archive_rejected(self):
        self.rejects(audit.API_ID, audit.WEB_ID, 'OCI image identity mismatch')

    def test_explicit_manifest_pin_rejects_changed_package_before_image_checks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'delivery-candidate.json').write_text('{}')
            with patch('sys.argv', ['audit', '--root', temporary,
                                    '--expected-api-id', 'sha256:' + 'a' * 64,
                                    '--expected-web-id', 'sha256:' + 'b' * 64,
                                    '--expected-manifest-sha256', '0' * 64]), \
                    self.assertRaisesRegex(ValueError, 'Pinned delivery manifest mismatch'):
                audit.main()


if __name__ == '__main__':
    unittest.main()
