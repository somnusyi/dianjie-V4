import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
import backup_envelope as envelope
import backup_migrate_encryption as migration
import backup

class EncryptedBackup(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder=tempfile.TemporaryDirectory();cls.keys=Path(cls.folder.name)
        for prefix in ('a','b'):
            key=rsa.generate_private_key(public_exponent=65537,key_size=3072)
            (cls.keys/(prefix+'.pub')).write_bytes(key.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo))
            (cls.keys/(prefix+'.key')).write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()));(cls.keys/(prefix+'.key')).chmod(0o600)
    @classmethod
    def tearDownClass(cls):cls.folder.cleanup()
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.root=Path(self.folder.name)
    def tearDown(self):self.folder.cleanup()
    def test_stream_roundtrip_and_private_only_recovery(self):
        plain=self.root/'source';plain.write_bytes(os.urandom(2*envelope.CHUNK+23));target=self.root/'sealed.enc'
        proof=envelope.seal_file(plain,target,self.keys/'a.pub')
        self.assertTrue(proof['writerRoundtripVerified']);self.assertEqual(envelope.verify_cipher(target)['plaintextSha256'],envelope.digest(plain))
        recovered=self.root/'recovered';envelope.recover_file(target,recovered,self.keys/'a.key');self.assertEqual(plain.read_bytes(),recovered.read_bytes())
        self.assertEqual(target.stat().st_mode&0o777,0o600);self.assertEqual(recovered.stat().st_mode&0o777,0o600)
        self.assertNotIn(plain.read_bytes()[:200],target.read_bytes())
    def test_wrong_key_and_cipher_tampering_never_publish_plaintext(self):
        plain=self.root/'source';plain.write_bytes(b'synthetic-credential');target=self.root/'sealed.enc';envelope.seal_file(plain,target,self.keys/'a.pub')
        output=self.root/'out'
        with self.assertRaises(ValueError):envelope.recover_file(target,output,self.keys/'b.key')
        self.assertFalse(output.exists())
        data=bytearray(target.read_bytes());data[-17]^=1;target.write_bytes(data)
        with self.assertRaises(Exception):envelope.recover_file(target,output,self.keys/'a.key')
        self.assertFalse(output.exists());self.assertEqual(list(self.root.glob('.out.*')),[])
    def test_never_replace_existing_archive_or_proof(self):
        plain=self.root/'source';plain.write_bytes(b'synthetic');target=self.root/'sealed.enc';target.write_bytes(b'keep')
        with self.assertRaises(FileExistsError):envelope.seal_file(plain,target,self.keys/'a.pub')
        self.assertEqual(target.read_bytes(),b'keep');target.unlink();proof=Path(str(target)+'.proof.json');proof.write_text('keep')
        with self.assertRaises(FileExistsError):envelope.seal_file(plain,target,self.keys/'a.pub')
        self.assertFalse(target.exists());self.assertEqual(proof.read_text(),'keep')
    def test_private_key_permissions_and_nonregular_inputs_rejected(self):
        unsafe=self.root/'private';unsafe.write_bytes((self.keys/'a.key').read_bytes());unsafe.chmod(0o644)
        with self.assertRaises(ValueError):envelope.load_private(unsafe)
        link=self.root/'link';link.symlink_to(self.keys/'a.key')
        with self.assertRaises(ValueError):envelope.load_private(link)
        source=self.root/'source';source.symlink_to(unsafe)
        with self.assertRaises(ValueError):envelope.seal_file(source,self.root/'out',self.keys/'a.pub')
    def command(self,argv,env=None):
        if argv[0]=='pg_dump':Path(argv[-1]).write_bytes(b'synthetic-credential-database')
        return b''
    def config(self,content_addressed):
        source=self.root/'attachments';source.mkdir();(source/'photo.jpg').write_bytes(b'quality-image')
        return {'attachment_directory':str(source),'directory':str(self.root/'production-weekly'),'content_addressed':content_addressed,'minimum_free_bytes':0,'offsite_deferred':True,'encryption':{'public_key_file':str(self.keys/'a.pub')}}
    def test_embedded_backup_and_isolated_recovery_no_plain_archive_published(self):
        config=self.config(False)
        with patch.dict(os.environ,{'DATABASE_URL':'postgresql://u@127.0.0.1:15439/dianjie_synthetic','RESTORE_DATABASE_URL':'postgresql://u@127.0.0.1:15439/dianjie_enc_restore_test'}),patch.object(backup,'run',side_effect=self.command):
            result=backup.backup(config);archive=Path(config['directory'])/result['archive']
            self.assertEqual(result['encryption'],'public_key_envelope_v1');self.assertTrue(archive.name.endswith('.enc'));self.assertEqual(list(archive.parent.glob('*.tar.gz')),[])
            with self.assertRaises(ValueError):backup.verify_archive(archive)
            self.assertEqual(backup.verify_archive(archive,self.keys/'a.key')['format'],1)
            backup.restore(archive,'RESTORE_DATABASE_URL',self.root/'restored',self.keys/'a.key')
            self.assertEqual((self.root/'restored'/'photo.jpg').read_bytes(),b'quality-image')
    def test_shared_blobs_encrypted_deduplicated_and_restored(self):
        config=self.config(True)
        with patch.dict(os.environ,{'DATABASE_URL':'postgresql://u@127.0.0.1:15439/dianjie_synthetic','RESTORE_DATABASE_URL':'postgresql://u@127.0.0.1:15439/dianjie_enc_restore_test'}),patch.object(backup,'run',side_effect=self.command):
            one=backup.backup(config);two=backup.backup(config);cache=self.root/'blobs';self.assertEqual(len(list(cache.glob('*.enc'))),1);self.assertEqual(len(list(cache.glob('*.proof.json'))),1)
            self.assertFalse(any(migration.BLOB.fullmatch(p.name) for p in cache.iterdir()))
            archive=Path(config['directory'])/two['archive'];self.assertEqual(backup.verify_archive(archive,self.keys/'a.key')['format'],2)
            backup.restore(archive,'RESTORE_DATABASE_URL',self.root/'restored',self.keys/'a.key');self.assertEqual((self.root/'restored'/'photo.jpg').read_bytes(),b'quality-image')
            encrypted=next(cache.glob('*.enc'));encrypted.write_bytes(b'corrupt')
            with self.assertRaises(ValueError):backup.backup(config)
    def test_existing_legacy_archives_migration_is_dryrun_idempotent_never_deletes(self):
        destination=self.root/'production-weekly';destination.mkdir();plain=destination/'dianjie-20261028T000000Z-abcd1234.tar.gz';plain.write_bytes(b'legacy')
        before=plain.read_bytes();plan=migration.migrate(destination,self.keys/'a.pub');self.assertEqual(plan['convertedCount'],0);self.assertFalse(Path(str(plain)+'.enc').exists())
        with self.assertRaises(ValueError):migration.migrate(destination,self.keys/'a.pub',True)
        result=migration.migrate(destination,self.keys/'a.pub',True,True);self.assertEqual(result['convertedCount'],1);self.assertEqual(plain.read_bytes(),before)
        again=migration.migrate(destination,self.keys/'a.pub',True,True);self.assertEqual(again['alreadyEncryptedCount'],1);self.assertEqual(again['convertedCount'],0)
        with self.assertRaises(ValueError):migration.migrate(destination,self.keys/'b.pub')
    def test_encrypted_retention_keeps_two_and_preserves_legacy_originals(self):
        import time
        for i in range(4):
            path=self.root/f'dianjie-2020010{i+1}T000000Z-1234abcd.tar.gz';path.write_bytes(b'legacy');envelope.seal_file(path,Path(str(path)+'.enc'),self.keys/'a.pub');os.utime(Path(str(path)+'.enc'),(time.time()-70*86400+i,)*2)
        self.assertEqual(backup.expire_archives(self.root,63,encrypted_only=True),2)
        self.assertEqual(len(list(self.root.glob('*.tar.gz'))),4);self.assertEqual(len(list(self.root.glob('*.enc'))),2);self.assertEqual(len(list(self.root.glob('*.proof.json'))),2)
    def test_private_key_cannot_be_configured_on_backup_writer(self):
        for item in [{'private_key_file':str(self.keys/'a.key')},{'public_key_file':str(self.keys/'a.pub'),'private_key_file':str(self.keys/'a.key')}]:
            with self.assertRaises(ValueError):backup.public_recipient({'encryption':item})

if __name__=='__main__':unittest.main()
