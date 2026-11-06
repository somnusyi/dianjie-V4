import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import inspect_switch_journal as inspector
import switch_journal
from test_switch_journal import metadata


class InspectorTests(unittest.TestCase):
    def test_tampered_selector_never_reaches_docker(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'journal'; switch_journal.Journal(path, metadata())
            value = json.loads(path.read_text())
            value['candidateNames']['api'] = '.*'
            path.write_text(json.dumps(value))
            with patch.object(inspector.controller, 'docker') as docker:
                with self.assertRaises(switch_journal.JournalError):
                    inspector.inspect(path)
                docker.assert_not_called()

    def test_missing_live_handles_override_terminal_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'journal'
            switch_journal.Journal(path, metadata()).write('switched')
            calls = []
            def docker(*args):
                calls.append(args)
                if args[:2] == ('context', 'inspect'):
                    return json.dumps([{'Endpoints': {'docker': {'Host': 'unix://' + str(Path.home() / '.colima/dianjie-huawei/docker.sock')}}}])
                self.assertEqual(args[0], 'ps')
                return ''
            with patch.object(inspector.controller, 'docker', side_effect=docker):
                result = inspector.inspect(path)
            self.assertTrue(result['recordIsTerminal'])
            self.assertTrue(all(not x['exists'] for x in result['actualContainers'].values()))
            self.assertFalse(result['runtimeModified'])
            self.assertFalse(result['resumeAuthorized'])
            self.assertEqual(len(calls), 5)

    def test_remote_context_never_queries_or_changes_containers(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'journal'; switch_journal.Journal(path, metadata())
            with patch.object(inspector.controller, 'docker', return_value=json.dumps([
                    {'Endpoints': {'docker': {'Host': 'ssh://remote'}}}])) as docker:
                with self.assertRaisesRegex(inspector.controller.gate.Refused, 'LOCAL_DOCKER_SOCKET_REQUIRED'):
                    inspector.inspect(path)
                docker.assert_called_once()


if __name__ == '__main__':
    unittest.main()
