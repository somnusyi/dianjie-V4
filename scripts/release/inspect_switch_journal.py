#!/usr/bin/env python3
"""Read-only reconciliation of an interrupted local switch; never restarts it."""
import argparse
import json
from pathlib import Path

import rehearse_compatible_switch as controller
import switch_journal


def inspect(path):
    journal = switch_journal.read(path)
    endpoint = json.loads(controller.docker('context', 'inspect', controller.CONTEXT))[0]['Endpoints']['docker']['Host']
    if endpoint != 'unix://' + str(Path.home() / '.colima/dianjie-huawei/docker.sock'):
        controller.refuse('LOCAL_DOCKER_SOCKET_REQUIRED')
    actual = {}
    for role in ('api', 'web'):
        expected = journal['previous'][role]
        ids = controller.docker('ps', '-aq', '--no-trunc', '--filter', 'id=' + expected['id']).split()
        if not ids:
            actual['previous_' + role] = {'exists': False}
        else:
            if ids != [expected['id']]:
                controller.refuse('PREVIOUS_CONTAINER_IDENTITY_AMBIGUOUS')
            meta = controller.inspect_container(expected['id'])
            labels = meta['Config'].get('Labels') or {}
            if (meta['Image'] != expected['imageId'] or meta['Name'] != expected['name']
                or labels.get('org.dianjie.operation') != controller.OPERATION
                or labels.get('org.dianjie.role') != role):
                controller.refuse('PREVIOUS_CONTAINER_IDENTITY_DRIFT')
            actual['previous_' + role] = {'exists': True, 'running': meta['State']['Running'],
                'onRecordedNetwork': journal['network'] in meta['NetworkSettings']['Networks']}
        name = journal['candidateNames'][role]
        ids = controller.docker('ps', '-aq', '--filter', 'name=^/' + name + '$').split()
        if not ids:
            actual['candidate_' + role] = {'exists': False}
        else:
            if len(ids) != 1:
                controller.refuse('CANDIDATE_CONTAINER_IDENTITY_AMBIGUOUS')
            meta = controller.inspect_container(ids[0]); labels = meta['Config'].get('Labels') or {}
            if (meta['Name'] != '/' + name or meta['Image'] != journal['candidateImages'][role]
                or labels.get('org.dianjie.operation') != controller.OPERATION
                or labels.get('org.dianjie.recovery-id') != journal['operationId']
                or labels.get('org.dianjie.role') != role):
                controller.refuse('CANDIDATE_CONTAINER_IDENTITY_DRIFT')
            actual['candidate_' + role] = {'exists': True, 'running': meta['State']['Running'],
                'onRecordedNetwork': journal['network'] in meta['NetworkSettings']['Networks']}
    return {'status': 'read_only_switch_reconciliation', 'recordedPhase': journal['phase'],
            'recordIsTerminal': journal['phase'] in switch_journal.TERMINAL,
            'actualContainers': actual, 'runtimeModified': False,
            'resumeAuthorized': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--journal', type=Path, default=Path.home() / '.codex/dianjie-compatible-rehearsal.journal.json')
    args = parser.parse_args()
    try:
        print(json.dumps(inspect(args.journal)))
    except Exception as error:
        print(json.dumps({'status': 'refused', 'reason': str(error) if isinstance(error, (controller.gate.Refused, switch_journal.JournalError)) else 'JOURNAL_RECONCILIATION_FAILED', 'runtimeModified': False}))
        raise SystemExit(1)
