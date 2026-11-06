"""Controller sequencing tests, not evidence of business recovery."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import rehearse_compatible_switch as switch


def plan():
    return {'format': 1, 'target': 'isolated', 'dockerContext': switch.CONTEXT,
            'databaseContainer': switch.DB, 'webPort': switch.PORT,
            'healthVersion': '1.3.3', 'network': 'dianjie-compat-test',
            'previous': {role: {'name': 'dianjie-compat-test-' + role,
                                'imageId': 'sha256:' + digit * 64}
                         for role, digit in (('api', 'a'), ('web', 'b'))}}


class FakeRuntime:
    def __init__(self, events, failure=None):
        self.events, self.failure = events, failure

    def action(self, name):
        self.events.append(name)
        if self.failure == name:
            raise switch.gate.Refused('SYNTHETIC_FAILURE')

    def drain(self): self.action('drain')
    def start_candidate(self): self.action('start')
    def health(self): self.action('health')
    def remove_candidate(self): self.action('remove')
    def restore_previous(self): self.action('restore')


class CompatibleSwitchTests(unittest.TestCase):
    def test_safe_plan_and_online_target_refusal(self):
        switch.validate_plan(plan())
        for field, value in [('target', 'production'), ('target', 'uat'),
                             ('dockerContext', 'remote'), ('databaseContainer', 'production-db'),
                             ('webPort', 80), ('network', 'bridge')]:
            changed = plan(); changed[field] = value
            with self.assertRaises(switch.gate.Refused):
                switch.validate_plan(changed)

    def test_distinct_roles_and_fixed_image_ids_required(self):
        changed = plan(); changed['previous']['web'] = changed['previous']['api'].copy()
        with self.assertRaises(switch.gate.Refused): switch.validate_plan(changed)
        changed = plan(); changed['previous']['api']['imageId'] = 'latest'
        with self.assertRaises(switch.gate.Refused): switch.validate_plan(changed)

    def test_gate_before_drain_and_after_drain_before_start(self):
        events = []; adapter = FakeRuntime(events)
        result = switch.switch_runtime(adapter, lambda: events.append('gate'))
        self.assertEqual(events, ['gate', 'drain', 'gate', 'start', 'health'])
        self.assertFalse(result['databaseRestored'])

    def test_first_gate_refusal_never_stops_runtime(self):
        events = []
        def rejected(): raise switch.gate.Refused('GATE_REFUSED')
        with self.assertRaisesRegex(switch.gate.Refused, 'GATE_REFUSED'):
            switch.switch_runtime(FakeRuntime(events), rejected)
        self.assertEqual(events, [])

    def test_post_drain_gate_refusal_restores_old_runtime_without_starting_new(self):
        events = []; count = 0
        def gate():
            nonlocal count
            events.append('gate'); count += 1
            if count == 2: raise switch.gate.Refused('NEW_FACT_REFUSED')
        with self.assertRaisesRegex(switch.gate.Refused, 'NEW_FACT_REFUSED'):
            switch.switch_runtime(FakeRuntime(events), gate)
        self.assertEqual(events, ['gate', 'drain', 'gate', 'remove', 'restore'])

    def test_partial_stop_start_and_health_failures_restore_previous(self):
        for failure in ('drain', 'start', 'health'):
            with self.subTest(failure=failure):
                events = []
                with self.assertRaisesRegex(switch.gate.Refused, 'SYNTHETIC_FAILURE'):
                    switch.switch_runtime(FakeRuntime(events, failure), lambda: None)
                self.assertEqual(events[-2:], ['remove', 'restore'])

    def test_failed_restore_is_reported_as_failed_restore(self):
        events = []; runtime = FakeRuntime(events, 'restore')
        runtime.health = lambda: (_ for _ in ()).throw(RuntimeError('health failed'))
        with self.assertRaisesRegex(switch.gate.Refused, 'PREVIOUS_SERVICE_RESTORE_FAILED'):
            switch.switch_runtime(runtime, lambda: None)

    def test_cleanup_failure_still_attempts_previous_restore(self):
        events = []; runtime = FakeRuntime(events, 'remove')
        runtime.health = lambda: (_ for _ in ()).throw(RuntimeError('health failed'))
        with self.assertRaisesRegex(switch.gate.Refused, 'RESTORED_CANDIDATE_CLEANUP_INCOMPLETE'):
            switch.switch_runtime(runtime, lambda: None)
        self.assertEqual(events[-2:], ['remove', 'restore'])

    def test_interrupt_after_drain_recovers_before_propagating(self):
        events = []; runtime = FakeRuntime(events)
        runtime.health = lambda: (_ for _ in ()).throw(KeyboardInterrupt())
        with self.assertRaises(KeyboardInterrupt):
            switch.switch_runtime(runtime, lambda: None)
        self.assertEqual(events[-2:], ['remove', 'restore'])

    def test_create_lost_response_is_tracked_and_all_cleanup_attempted(self):
        runtime = switch.DockerSwitch(plan(), {}, {}, {'api': 'sha256:' + 'c' * 64, 'web': 'sha256:' + 'd' * 64})
        with patch.object(switch, 'docker', side_effect=RuntimeError('lost response')):
            with self.assertRaises(RuntimeError): runtime.start_candidate()
        self.assertEqual(runtime.attempted, ['api'])
        runtime.attempted.append('web')
        commands = []
        def docker(*args, **kwargs):
            commands.append(args)
            if args[0] == 'ps': return 'web-id' if 'web' in args[-1] else 'api-id'
            if args[:2] == ('container', 'inspect'):
                role = args[2].split('-')[0]
                return json.dumps([{'Name': '/' + runtime.names[role], 'Image': runtime.images[role], 'Config': {'Labels': {
                    'org.dianjie.operation': switch.OPERATION,
                    'org.dianjie.recovery-id': runtime.operation_id,
                    'org.dianjie.role': role}}}])
            if args[0] == 'rm' and args[-1] == 'web-id': raise RuntimeError('failed remove')
            return ''
        with patch.object(switch, 'docker', side_effect=docker):
            with self.assertRaisesRegex(switch.gate.Refused, 'CLEANUP_INCOMPLETE_WEB'):
                runtime.remove_candidate()
        self.assertIn(('rm', '--force', 'api-id'), commands)

    def test_cleanup_refuses_same_name_labels_with_different_image(self):
        runtime = switch.DockerSwitch(plan(), {}, {}, {'api': 'sha256:' + 'c' * 64, 'web': 'sha256:' + 'd' * 64})
        runtime.attempted = ['api']
        def docker(*args):
            if args[0] == 'ps': return 'candidate-id'
            if args[:2] == ('container', 'inspect'):
                return json.dumps([{'Name': '/' + runtime.names['api'], 'Image': 'sha256:' + 'f' * 64,
                    'Config': {'Labels': {'org.dianjie.operation': switch.OPERATION,
                        'org.dianjie.recovery-id': runtime.operation_id, 'org.dianjie.role': 'api'}}}])
            self.fail('Unexpected mutation: ' + repr(args))
        with patch.object(switch, 'docker', side_effect=docker):
            with self.assertRaisesRegex(switch.gate.Refused, 'CLEANUP_INCOMPLETE_API'):
                runtime.remove_candidate()

    def test_pinned_file_drift_and_symlink_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'plan.json'; path.write_text(json.dumps(plan()))
            sha = switch.gate.checksum(path)
            self.assertEqual(switch.read_pinned(path, sha), plan())
            path.write_text('{}')
            with self.assertRaises(switch.gate.Refused): switch.read_pinned(path, sha)
            link = Path(tmp) / 'link'; link.symlink_to(path)
            with self.assertRaises(switch.gate.Refused): switch.read_pinned(link, switch.gate.checksum(path))

    def test_actual_cli_refuses_forward_package_before_docker_or_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p = root / 'plan.json'; p.write_text(json.dumps(plan()))
            manifest = root / 'forward.json'; manifest.write_text(json.dumps({'version': '1.3.3', 'packageKind': 'forward'}))
            result = subprocess.run([sys.executable, switch.__file__, '--execute',
                '--plan', str(p), '--approved-plan-sha256', switch.gate.checksum(p),
                '--candidate-root', tmp, '--compat-manifest', str(manifest),
                '--approved-manifest-sha256', switch.gate.checksum(manifest)],
                env={'PATH': '/nonexistent'}, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)['reason'], 'FORWARD_PACKAGE_IS_NOT_COMPATIBLE_RECOVERY')

    def test_forward_images_cannot_be_relabeled_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); p = root / 'plan.json'; p.write_text(json.dumps(plan()))
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps({'packageKind': 'compatible-rollback',
                'runtimeImages': {role: item['imageId'] for role, item in plan()['previous'].items()}}))
            argv = ['switch', '--plan', str(p), '--approved-plan-sha256', switch.gate.checksum(p),
                    '--candidate-root', tmp, '--compat-manifest', str(manifest),
                    '--approved-manifest-sha256', switch.gate.checksum(manifest)]
            with patch('sys.argv', argv), patch.object(switch, 'docker') as docker:
                self.assertEqual(switch.main(), 1)
                docker.assert_not_called()


if __name__ == '__main__':
    unittest.main()
