import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).parent))
import escrow_credential_keyring as escrow
from backup_envelope import recover_file
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

class KeyEscrow(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.folder=tempfile.TemporaryDirectory();cls.base=Path(cls.folder.name)
  for name in ('recovery','wrong'):
   key=rsa.generate_private_key(public_exponent=65537,key_size=3072)
   (cls.base/(name+'.pub')).write_bytes(key.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo))
   (cls.base/(name+'.key')).write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()));(cls.base/(name+'.key')).chmod(0o600)
  repo=Path(os.environ.get('DIANJIE_SOURCE_ROOT',Path(__file__).resolve().parents[2]))
  code=subprocess.check_output(['node','-e',"const t=require('typescript'),f=require('fs');process.stdout.write(t.transpileModule(f.readFileSync(process.argv[1],'utf8'),{compilerOptions:{module:t.ModuleKind.CommonJS,target:t.ScriptTarget.ES2022}}).outputText)",str(repo/'apps/api/src/lib/credential-vault.ts')],cwd=repo)
  cls.vault=cls.base/'credential-vault.js';cls.vault.write_bytes(code)
 @classmethod
 def tearDownClass(cls):cls.folder.cleanup()
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.ring={'current':'new','keys':{'old':os.urandom(32).hex(),'new':os.urandom(32).hex()}}
 def tearDown(self):self.temp.cleanup()
 def test_dryrun_is_metadata_only_no_output_and_no_key_values(self):
  output=self.root/'keyring.enc';result=escrow.escrow(self.ring,self.base/'recovery.pub',output)
  self.assertFalse(output.exists());self.assertEqual(result['keyIds'],['new','old']);self.assertEqual(result['mode'],'dry-run');self.assertNotIn(self.ring['keys']['new'],json.dumps(result))
 def test_seal_offline_recover_verifies_all_rotation_keys_without_changing_source(self):
  source=self.root/'keyring.json';source.write_text(json.dumps(self.ring));source.chmod(0o600);before=source.read_bytes();output=self.root/'keyring.enc'
  escrow.escrow(escrow.read_keyring(file=source),self.base/'recovery.pub',output,True)
  receipt=self.root/'receipt.json';result=escrow.verify_recovery(output,self.base/'recovery.key',receipt)
  self.assertTrue(result['offlineRecoveryVerified']);self.assertEqual(result['keyIds'],['new','old']);self.assertEqual(source.read_bytes(),before);self.assertFalse(result['databaseModified']);self.assertEqual(receipt.stat().st_mode&0o777,0o600)
 def test_unsafe_keyring_unknown_current_and_wrong_private_refused(self):
  source=self.root/'keyring.json';source.write_text(json.dumps(self.ring));source.chmod(0o644)
  with self.assertRaises(escrow.Refused):escrow.read_keyring(file=source)
  for value in [{},{'current':'missing','keys':{'old':'ab'*32}},{'current':'old','keys':{'old':'short'}}]:
   with self.assertRaises(escrow.Refused):escrow.validated(json.dumps(value))
  output=self.root/'keyring.enc';escrow.escrow(self.ring,self.base/'recovery.pub',output,True)
  with self.assertRaises(ValueError):escrow.verify_recovery(output,self.base/'wrong.key',self.root/'bad-receipt.json')
  self.assertFalse((self.root/'bad-receipt.json').exists())
 def test_execute_requires_output_and_does_not_replace_existing_escrow(self):
  with self.assertRaises(escrow.Refused):escrow.escrow(self.ring,self.base/'recovery.pub',execute=True)
  output=self.root/'keyring.enc';escrow.escrow(self.ring,self.base/'recovery.pub',output,True);before=output.read_bytes()
  with self.assertRaises(FileExistsError):escrow.escrow(self.ring,self.base/'recovery.pub',output,True)
  self.assertEqual(output.read_bytes(),before)
 def test_recovered_keyring_reads_existing_database_cipher_without_rewriting_it(self):
  env={k:os.environ[k] for k in ['PATH','HOME','LANG'] if k in os.environ};env['CREDENTIAL_ENCRYPTION_KEYS']=json.dumps(self.ring)
  sealed=subprocess.check_output(['node','-e',"const v=require(process.argv[1]);process.stdout.write(v.sealCredential('synthetic-secret-only',v.credentialContext('tenant-a','wecom','appSecret')))",str(self.vault)],env=env)
  record=self.root/'credential-record';record.write_bytes(sealed);before=record.read_bytes()
  encrypted=self.root/'keyring.enc';escrow.escrow(self.ring,self.base/'recovery.pub',encrypted,True)
  recovered=self.root/'offline-keyring.json';recover_file(encrypted,recovered,self.base/'recovery.key')
  clean={k:os.environ[k] for k in ['PATH','HOME','LANG'] if k in os.environ}
  subprocess.run(['node','-e',"const fs=require('fs');process.env.CREDENTIAL_ENCRYPTION_KEYS=fs.readFileSync(process.argv[2],'utf8');process.env.CREDENTIAL_LEGACY_READ_ALLOWED='false';const v=require(process.argv[1]);if(v.openCredential(fs.readFileSync(process.argv[3],'utf8'),v.credentialContext('tenant-a','wecom','appSecret'))!=='synthetic-secret-only')process.exit(2)",str(self.vault),str(recovered),str(record)],env=clean,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  self.assertEqual(record.read_bytes(),before)
if __name__=='__main__':unittest.main()
