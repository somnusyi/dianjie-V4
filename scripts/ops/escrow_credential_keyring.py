#!/usr/bin/env python3
"""Seal a credential AES keyring for offline custody. Defaults to dry-run; never edits a database."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from backup_envelope import seal_file,recover_file,load_public,_key_id,digest,write_proof

class Refused(Exception):pass

def validated(raw):
 try:
  ring=json.loads(raw);keys=ring['keys'];current=ring['current']
  if not isinstance(keys,dict) or not keys or current not in keys:raise ValueError()
  if any(not isinstance(k,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,40}',k) or not isinstance(v,str) or not re.fullmatch(r'[a-fA-F0-9]{64}',v) for k,v in keys.items()):raise ValueError()
  return {'current':current,'keys':keys}
 except Exception:raise Refused('CREDENTIAL_KEYRING_INVALID')

def read_keyring(file=None,env_name=None):
 if bool(file)==bool(env_name):raise Refused('EXACTLY_ONE_KEYRING_SOURCE_REQUIRED')
 if file:
  p=Path(file);s=p.lstat()
  if not stat.S_ISREG(s.st_mode) or p.is_symlink() or s.st_mode&0o077:raise Refused('PRIVATE_REGULAR_KEYRING_FILE_REQUIRED')
  raw=p.read_text()
 else:raw=os.environ.get(env_name,'')
 return validated(raw)

def escrow(ring,public_key,output=None,execute=False):
 ring=validated(json.dumps(ring));key=load_public(public_key)
 result={'mode':'execute' if execute else 'dry-run','keyIds':sorted(ring['keys']),'currentKeyId':ring['current'],'recipientKeyId':_key_id(key),'databaseModified':False}
 if not execute:return result
 if not output:raise Refused('NEW_ESCROW_OUTPUT_REQUIRED')
 with tempfile.TemporaryDirectory(prefix='dianjie-keyring-escrow-') as folder:
  source=Path(folder)/'credential-keyring.json';source.write_text(json.dumps(ring,sort_keys=True,separators=(',',':')));source.chmod(0o600)
  proof=seal_file(source,output,public_key)
 return {**result,'encryptedSha256':digest(output),'plaintextSha256':proof['plaintextSha256']}

def verify_recovery(encrypted,private_key,receipt):
 if not receipt:raise Refused('NEW_OFFLINE_RECEIPT_REQUIRED')
 with tempfile.TemporaryDirectory(prefix='dianjie-keyring-recovery-') as folder:
  target=Path(folder)/'credential-keyring.json';header=recover_file(encrypted,target,private_key);ring=read_keyring(file=target)
  result={'format':1,'status':'offline_credential_keyring_verified','offlineRecoveryVerified':True,'keyIds':sorted(ring['keys']),'currentKeyId':ring['current'],'recipientKeyId':header['recipientKeyId'],'encryptedSha256':digest(encrypted),'plaintextSha256':digest(target),'databaseModified':False}
  write_proof(receipt,result)
  return result

def main():
 os.umask(0o077);p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['seal','verify-recovery']);p.add_argument('--keyring-file');p.add_argument('--keyring-env');p.add_argument('--public-key-file');p.add_argument('--output');p.add_argument('--execute',action='store_true');p.add_argument('--encrypted');p.add_argument('--private-key-file');p.add_argument('--receipt');a=p.parse_args()
 try:
  if a.action=='seal':result=escrow(read_keyring(a.keyring_file,a.keyring_env),a.public_key_file,a.output,a.execute)
  else:
   if a.execute or a.keyring_file or a.keyring_env or a.public_key_file or a.output:raise Refused('OFFLINE_VERIFICATION_ARGUMENTS_REQUIRED')
   result=verify_recovery(a.encrypted,a.private_key_file,a.receipt)
  print(json.dumps(result))
 except Exception as e:
  print(json.dumps({'status':'blocked','reason':str(e) if isinstance(e,Refused) else 'KEYRING_ESCROW_FAILED','databaseModified':False}));raise SystemExit(1)
if __name__=='__main__':main()
