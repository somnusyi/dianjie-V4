#!/usr/bin/env python3
"""Copy legacy backup artifacts into authenticated envelopes; dry-run by default. Never deletes originals."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import sys
from backup_envelope import seal_file,verify_cipher,digest,load_public,_key_id,recover_file,write_proof

ARCHIVE=re.compile(r'dianjie-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.gz')
BLOB=re.compile(r'[a-f0-9]{64}')

def selected(directory):
    directory=Path(directory)
    if directory.is_symlink() or not directory.is_dir():raise ValueError('Backup directory must be a regular directory')
    rows=[p for p in directory.iterdir() if ARCHIVE.fullmatch(p.name)]
    blobs=directory.parent/'blobs'
    if blobs.exists():
        if blobs.is_symlink() or not blobs.is_dir():raise ValueError('Invalid blob repository')
        rows.extend(p for p in blobs.iterdir() if BLOB.fullmatch(p.name))
    for p in rows:
        if p.is_symlink() or not p.is_file():raise ValueError('Backup inputs must be regular files')
    return sorted(rows)

def migrate(directory,public_key,execute=False,backup_confirmed=False):
    if execute and not backup_confirmed:raise ValueError('Explicit --backup-confirmed is required before copying historical archives')
    directory=Path(directory).resolve();key_id=_key_id(load_public(public_key))
    # Matches scheduled backup's environment lock. Shared blob copies remain exclusive/atomic.
    with (directory/'.backup.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        rows=selected(directory);converted=0;already=0
        for source in rows:
            target=Path(str(source)+'.enc')
            if target.exists():
                proof=verify_cipher(target,digest(source))
                if proof['recipientKeyId']!=key_id:raise ValueError('Existing envelope uses another recovery key')
                already+=1
            elif execute:
                seal_file(source,target,public_key);converted+=1
        return {'mode':'execute' if execute else 'dry-run','candidateCount':len(rows),'alreadyEncryptedCount':already,'convertedCount':converted,'originalsDeleted':0,'recipientKeyId':key_id}

def verify_recovery(directory,private_key,receipt_file):
    rows=selected(directory);proofs=[]
    import tempfile
    for source in rows:
        encrypted=Path(str(source)+'.enc')
        verify_cipher(encrypted,digest(source))
        with tempfile.TemporaryDirectory(prefix='dianjie-recovery-check-') as temp:
            plain=Path(temp)/'recovered'
            recovered=recover_file(encrypted,plain,private_key)
            if digest(plain)!=digest(source):raise ValueError('Recovery does not match original')
            # Archive schema and attachment hashes receive the existing full verifier too.
            if ARCHIVE.fullmatch(source.name):
                from backup import verify_archive
                verify_archive(encrypted,private_key)
        proofs.append({'source':str(source),'sourceSha256':digest(source),'cipherSha256':digest(encrypted),'recipientKeyId':recovered['recipientKeyId']})
    receipt={'format':1,'status':'offline_private_key_recovery_verified','items':proofs,'originalsDeleted':0}
    write_proof(receipt_file,receipt)
    return {'status':receipt['status'],'verifiedCount':len(rows),'originalsDeleted':0}

def main():
    os.umask(0o077)
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--directory',required=True);p.add_argument('--public-key-file');p.add_argument('--execute',action='store_true');p.add_argument('--backup-confirmed',action='store_true')
    p.add_argument('--verify-recovery',action='store_true');p.add_argument('--private-key-file');p.add_argument('--receipt-file')
    a=p.parse_args()
    try:
        if a.verify_recovery:
            if not a.private_key_file or not a.receipt_file or a.execute:raise ValueError('Recovery verification requires offline private key and a new receipt path')
            result=verify_recovery(a.directory,a.private_key_file,a.receipt_file)
        else:
            if not a.public_key_file or a.private_key_file or a.receipt_file:raise ValueError('Copy mode needs only a public key')
            result=migrate(a.directory,a.public_key_file,a.execute,a.backup_confirmed)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({'status':'failed','reason':type(e).__name__,'originalsDeleted':0}),file=sys.stderr);raise SystemExit(1)

if __name__=='__main__':main()
