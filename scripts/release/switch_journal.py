"""Durable, secret-free write-ahead state for the local switch controller.

Caller must hold the controller lock. A pending journal never authorizes a
restart; it requires inspecting the recorded container identities first.
"""
import json
import os
import re
from pathlib import Path
import stat
import tempfile


TERMINAL = {'switched', 'previous_restored'}
PHASES = {'prepared', 'draining', 'creating_api', 'creating_web',
          'cleaning_candidate', 'restoring_previous'} | TERMINAL
FIELDS = {'format', 'phase', 'operationId', 'planSha256', 'controllerSha256',
          'previous', 'candidateNames', 'candidateImages', 'network'}


class JournalError(Exception):
    pass


def validate(value):
    """Validate persisted identities before they can become Docker selectors."""
    if (not isinstance(value, dict) or set(value) != FIELDS
        or type(value['format']) is not int or value['format'] != 1
        or not isinstance(value['phase'], str) or value['phase'] not in PHASES):
        raise JournalError('JOURNAL_FORMAT_INVALID')
    def matches(pattern, item):
        return isinstance(item, str) and re.fullmatch(pattern, item) is not None
    if (not matches(r'[a-f0-9]{12}', value['operationId'])
        or any(not matches(r'[a-f0-9]{64}', value[k]) for k in ('planSha256', 'controllerSha256'))
        or not matches(r'dianjie-compat-[a-z0-9-]{1,40}', value['network'])):
        raise JournalError('JOURNAL_OPERATION_IDENTITY_INVALID')
    for key in ('previous', 'candidateNames', 'candidateImages'):
        if not isinstance(value[key], dict) or set(value[key]) != {'api', 'web'}:
            raise JournalError('JOURNAL_ROLE_IDENTITIES_INVALID')
    for role in ('api', 'web'):
        previous = value['previous'][role]
        if (not isinstance(previous, dict) or set(previous) != {'id', 'imageId', 'name'}
            or not matches(r'[a-f0-9]{64}', previous['id'])
            or not matches(r'sha256:[a-f0-9]{64}', previous['imageId'])
            or not matches(r'/dianjie-compat-[a-z0-9-]{1,40}', previous['name'])
            or not matches(r'sha256:[a-f0-9]{64}', value['candidateImages'][role])
            or value['candidateNames'][role] != 'dianjie-compat-recovery-' + role + '-' + value['operationId']):
            raise JournalError('JOURNAL_CONTAINER_IDENTITY_INVALID')
    if (value['previous']['api']['id'] == value['previous']['web']['id']
        or value['previous']['api']['name'] == value['previous']['web']['name']
        or any(p['name'].lstrip('/') in value['candidateNames'].values() for p in value['previous'].values())):
        raise JournalError('JOURNAL_CONTAINER_ROLES_COLLIDE')


def read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise JournalError('JOURNAL_PERMISSIONS_INVALID')
        value = json.load(stream)
    validate(value)
    return value


def check_no_pending(path):
    path = Path(path)
    if path.is_symlink():
        raise JournalError('JOURNAL_SYMLINK_REFUSED')
    if path.exists() and read(path)['phase'] not in TERMINAL:
        raise JournalError('INTERRUPTED_SWITCH_REQUIRES_IDENTITY_RECONCILIATION')


class Journal:
    @classmethod
    def resume(cls, path, expected):
        value = read(path)
        if value != expected or value['phase'] in TERMINAL:
            raise JournalError('JOURNAL_RESUME_IDENTITY_CHANGED')
        record = cls.__new__(cls)
        record.path, record.value = Path(path), value
        return record

    def __init__(self, path, metadata):
        self.path = Path(path)
        if set(metadata) != FIELDS - {'format', 'phase'}:
            raise JournalError('JOURNAL_METADATA_INVALID')
        # Reject whole Docker inspection/environment objects at the API boundary.
        if set(metadata['previous']) != {'api', 'web'} or any(
                set(item) != {'id', 'imageId', 'name'} for item in metadata['previous'].values()):
            raise JournalError('JOURNAL_PREVIOUS_IDENTITY_INVALID')
        check_no_pending(self.path)
        self.value = {'format': 1, **metadata, 'phase': 'prepared'}
        self.write('prepared')

    def write(self, phase):
        if phase not in PHASES:
            raise JournalError('JOURNAL_PHASE_INVALID')
        value = {**self.value, 'phase': phase}
        validate(value)
        fd, temporary = tempfile.mkstemp(prefix='.switch-journal-', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(value, stream, sort_keys=True)
                stream.write('\n')
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            self.value = value
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
