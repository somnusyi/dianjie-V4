#!/usr/bin/env python3
"""Streaming RSA-OAEP/AES-GCM backup envelopes. The writer needs only a public key."""
import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import tempfile

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

MAGIC = b'DJBACKUP\x00\x01'
LABEL = b'dianjie-backup-envelope-v1'
CHUNK = 1024 * 1024
MAX_HEADER = 8192


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(CHUNK), b''):
            h.update(chunk)
    return h.hexdigest()


def _key_id(key):
    return hashlib.sha256(key.public_bytes(serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()


def load_public(path):
    key = serialization.load_pem_public_key(Path(path).read_bytes())
    if not isinstance(key, rsa.RSAPublicKey) or key.key_size < 3072:
        raise ValueError('Backup recipient must be an RSA public key of at least 3072 bits')
    return key


def load_private(path, password=None):
    path = Path(path)
    if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode) or path.stat().st_mode & 0o077:
        raise ValueError('Recovery private key must be a private regular file')
    key = serialization.load_pem_private_key(path.read_bytes(), password=password)
    if not isinstance(key, rsa.RSAPrivateKey) or key.key_size < 3072:
        raise ValueError('Invalid backup recovery private key')
    return key


def inspect(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError('Envelope must be a regular file')
    with path.open('rb') as handle:
        if handle.read(len(MAGIC)) != MAGIC:
            raise ValueError('Unknown encrypted backup format')
        raw_size = handle.read(4)
        if len(raw_size) != 4:
            raise ValueError('Truncated encrypted backup')
        size = struct.unpack('>I', raw_size)[0]
        if size < 1 or size > MAX_HEADER:
            raise ValueError('Invalid encrypted backup header size')
        raw = handle.read(size)
        if len(raw) != size:
            raise ValueError('Truncated encrypted backup header')
        header = json.loads(raw)
        if header.get('format') != 1 or header.get('algorithm') != 'RSA-OAEP-SHA256+AES-256-GCM':
            raise ValueError('Unsupported encrypted backup algorithm')
        if type(header.get('plaintextSize')) is not int or header['plaintextSize'] < 0:
            raise ValueError('Invalid encrypted backup size')
        if path.stat().st_size != len(MAGIC) + 4 + size + header['plaintextSize'] + 16:
            raise ValueError('Encrypted backup length mismatch')
        for field in ['plaintextSha256', 'recipientKeyId']:
            if len(header.get(field, '')) != 64 or any(c not in '0123456789abcdef' for c in header[field]):
                raise ValueError('Invalid encrypted backup checksum metadata')
        return header, raw, handle.tell()


def _decrypt_stream(path, data_key, output=None):
    header, aad, offset = inspect(path)
    nonce = base64.b64decode(header['nonce'], validate=True)
    if len(nonce) != 12:
        raise ValueError('Invalid encryption nonce')
    with Path(path).open('rb') as source:
        source.seek(-16, os.SEEK_END)
        tag = source.read(16)
        decryptor = Cipher(algorithms.AES(data_key), modes.GCM(nonce, tag)).decryptor()
        decryptor.authenticate_additional_data(aad)
        source.seek(offset)
        remaining = header['plaintextSize']
        h = hashlib.sha256()
        while remaining:
            chunk = source.read(min(CHUNK, remaining))
            if not chunk:
                raise ValueError('Truncated encrypted backup content')
            remaining -= len(chunk)
            plain = decryptor.update(chunk)
            h.update(plain)
            if output:
                output.write(plain)
        tail = decryptor.finalize()
        h.update(tail)
        if output:
            output.write(tail)
        if h.hexdigest() != header['plaintextSha256']:
            raise ValueError('Decrypted backup checksum mismatch')
    return header


def _publish_exclusive(partial, final):
    # Atomic publication without replacing a pre-existing archive or following a symlink.
    os.link(partial, final)
    Path(partial).unlink()
    fd = os.open(str(Path(final).parent), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_proof(path, value):
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(value, handle, sort_keys=True)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        _publish_exclusive(name, path)
    finally:
        if Path(name).exists():
            Path(name).unlink()


def seal_file(source, destination, public_key):
    source, destination = Path(source), Path(destination)
    if source.is_symlink() or not stat.S_ISREG(source.stat().st_mode):
        raise ValueError('Plaintext input must be a regular file')
    if destination.exists() or destination.is_symlink() or Path(str(destination)+'.proof.json').exists() or Path(str(destination)+'.proof.json').is_symlink():
        raise FileExistsError('Encrypted output already exists')
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    key = load_public(public_key)
    before = source.stat()
    plain_sha = digest(source)
    data_key, nonce = os.urandom(32), os.urandom(12)
    header = {'format': 1, 'algorithm': 'RSA-OAEP-SHA256+AES-256-GCM',
        'recipientKeyId': _key_id(key), 'originalName': source.name,
        'plaintextSha256': plain_sha, 'plaintextSize': before.st_size,
        'nonce': base64.b64encode(nonce).decode(),
        'wrappedKey': base64.b64encode(key.encrypt(data_key, padding.OAEP(
            mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=LABEL))).decode()}
    aad = json.dumps(header, sort_keys=True, separators=(',', ':')).encode()
    if len(aad) > MAX_HEADER:
        raise ValueError('Encrypted backup metadata too large')
    fd, partial = tempfile.mkstemp(prefix='.' + destination.name + '.', dir=destination.parent)
    try:
        encryptor = Cipher(algorithms.AES(data_key), modes.GCM(nonce)).encryptor()
        encryptor.authenticate_additional_data(aad)
        h = hashlib.sha256()
        with os.fdopen(fd, 'wb') as output, source.open('rb') as input_:
            output.write(MAGIC + struct.pack('>I', len(aad)) + aad)
            for chunk in iter(lambda: input_.read(CHUNK), b''):
                h.update(chunk)
                output.write(encryptor.update(chunk))
            output.write(encryptor.finalize())
            output.write(encryptor.tag)
            output.flush()
            os.fsync(output.fileno())
        after = source.stat()
        if (before.st_ino, before.st_dev, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_dev, after.st_size, after.st_mtime_ns) or h.hexdigest() != plain_sha:
            raise ValueError('Plaintext source changed during encryption')
        _decrypt_stream(Path(partial), data_key)  # Authentic tag + full plaintext hash, no private key on server.
        proof = {'format': 1, 'recipientKeyId': header['recipientKeyId'], 'plaintextSha256': plain_sha,
            'plaintextSize': before.st_size, 'cipherSha256': digest(Path(partial)),
            'originalName': source.name, 'writerRoundtripVerified': True}
        _publish_exclusive(partial, destination)
        write_proof(str(destination) + '.proof.json', proof)
        return proof
    finally:
        if Path(partial).exists():
            Path(partial).unlink()


def verify_cipher(path, expected_plain_sha=None):
    path = Path(path)
    header, _, _ = inspect(path)
    proof = json.loads(Path(str(path) + '.proof.json').read_text())
    if not proof.get('writerRoundtripVerified') or proof.get('cipherSha256') != digest(path):
        raise ValueError('Encrypted backup checksum verification failed')
    for name in ['recipientKeyId', 'plaintextSha256', 'plaintextSize', 'originalName']:
        if proof.get(name) != header[name]:
            raise ValueError('Encrypted backup proof/header mismatch')
    if expected_plain_sha is not None and header['plaintextSha256'] != expected_plain_sha:
        raise ValueError('Encrypted backup source checksum mismatch')
    # This verifies the unchanged output of a prior encryption roundtrip, not private-key recovery.
    return proof


def recover_file(source, destination, private_key, password=None):
    source, destination = Path(source), Path(destination)
    if destination.exists() or destination.is_symlink():
        raise FileExistsError('Plaintext recovery output already exists')
    key = load_private(private_key, password)
    header, _, _ = inspect(source)
    if _key_id(key.public_key()) != header['recipientKeyId']:
        raise ValueError('Recovery private key does not match recipient')
    data_key = key.decrypt(base64.b64decode(header['wrappedKey'], validate=True), padding.OAEP(
        mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=LABEL))
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, partial = tempfile.mkstemp(prefix='.' + destination.name + '.', dir=destination.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            _decrypt_stream(source, data_key, output)
            output.flush()
            os.fsync(output.fileno())
        _publish_exclusive(partial, destination)
        return header
    finally:
        if Path(partial).exists():
            Path(partial).unlink()
