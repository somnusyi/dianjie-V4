import importlib.util
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('gate',Path(__file__).with_name('rollback_compatibility.py'));gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)

class RollbackGate(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  repo=Path(os.environ.get('DIANJIE_SOURCE_ROOT',Path(__file__).resolve().parents[2]))
  source=repo/'apps/api/src/lib/credential-vault.ts'
  cls.vault=subprocess.check_output(['node','-e',"const t=require('typescript'),f=require('fs');process.stdout.write(t.transpileModule(f.readFileSync(process.argv[1],'utf8'),{compilerOptions:{module:t.ModuleKind.CommonJS,target:t.ScriptTarget.ES2022}}).outputText)",str(source)],cwd=repo)
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.state={k:False for k in ['ciphertexts','unsupportedCiphertext','submissionV1','replenishmentHolds','frozenSupplierUnits','transferFacts','partialTransfers','netCostBasis','browserSessionClock','warehouseReviewDocs','warehouseReviewStocktakes','unsupportedWarehousePostingPolicy']};self.state['credentialKeyIds']=[]
  self.manifest=self.root/'manifest.json';self.ring=json.dumps({'current':'test','keys':{'test':'ab'*32}})
 def tearDown(self):self.temp.cleanup()
 def package(self,caps=None):
  caps=set(caps or gate.CAPABILITIES);artifacts={}
  for cap in caps:
   for file in gate.CAPABILITIES[cap]:
    relative='api/dist/'+file;p=self.root/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(self.vault if file=='lib/credential-vault.js' else b'// synthetic artifact fixture; never executed\n');artifacts[relative]=gate.checksum(p)
  for relative in ['api/application.tar.gz','packages/db/client.tar.gz']:
   p=self.root/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b'synthetic runtime archive fixture; never executed');artifacts[relative]=gate.checksum(p)
  for cap in caps:
   for relative in gate.EXTRA_ARTIFACTS.get(cap,[]):
    p=self.root/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b'synthetic artifact fixture; never executed');artifacts[relative]=gate.checksum(p)
  driver=self.root/'rollback-driver.py';driver.write_text('# synthetic code-only driver fixture; never executed\n');artifacts[driver.name]=gate.checksum(driver)
  escrow=self.root/'credential-keyring.enc';escrow.write_bytes(b'synthetic-ciphertext-fixture')
  receipt=self.root/'offline-receipt.json';receipt.write_text(json.dumps({'status':'offline_credential_keyring_verified','offlineRecoveryVerified':True,'keyIds':['test'],'encryptedSha256':gate.checksum(escrow),'plaintextSha256':gate.keyring_fingerprint(self.ring)}))
  proof={'status':'passed','candidateFingerprint':hashlib.sha256(json.dumps(artifacts,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'cases':{c:'passed' for c in caps|{'no-business-data-rewrite','wrong-target-refused','compatibility-gate-enforced'}},'credentialKeyEscrow':{'path':escrow.name,'sha256':gate.checksum(escrow),'keyIds':['test'],'offlineRecoveryVerified':True,'receiptPath':receipt.name,'receiptSha256':gate.checksum(receipt)}}
  proofpath=self.root/'evidence.json';proofpath.write_text(json.dumps(proof))
  m={'format':1,'packageKind':'compatible-rollback','dataPolicy':{k:False for k in ['restoreBusinessDatabase','decryptCredentialsAtRest','runSchemaDownMigrations']},'retainedCapabilities':sorted(caps),'artifacts':artifacts,'rollbackDriver':driver.name,'verificationEvidence':{'path':proofpath.name,'sha256':gate.checksum(proofpath)}}
  self.manifest.write_text(json.dumps(m));return m,proof
 def verify(self,state,*args,**kwargs):return gate.verify_package(self.root,self.manifest,state,*args,approved_manifest_sha256=gate.checksum(self.manifest),runtime_keyring_sha256=gate.keyring_fingerprint(self.ring),**kwargs)
 def save_proof(self,m,proof):
  p=self.root/'evidence.json';p.write_text(json.dumps(proof));m['verificationEvidence']['sha256']=gate.checksum(p);self.manifest.write_text(json.dumps(m))
 def test_publish_has_no_legacy_fallback_without_verified_compatible_package(self):
  with self.assertRaisesRegex(gate.Refused,'VERIFIED_COMPATIBLE'):gate.verify_package(self.root,None,self.state)
  self.manifest.write_text(json.dumps({'version':'1.3.2'}))
  with self.assertRaisesRegex(gate.Refused,'LEGACY_OR_UNVERIFIED'):self.verify(self.state)
 def test_each_new_fact_requires_its_compatibility_family(self):
  for state,cap in [('ciphertexts','credential-envelope-v1'),('submissionV1','submission-reservation-v1'),('replenishmentHolds','submission-reservation-v1'),('frozenSupplierUnits','submission-reservation-v1'),('transferFacts','store-transfer-posting-v1'),('partialTransfers','store-transfer-posting-v1'),('netCostBasis','inventory-net-cost-basis-v1'),('browserSessionClock','browser-session-v1'),('warehouseReviewDocs','warehouse-review-posting-v1'),('warehouseReviewStocktakes','warehouse-review-posting-v1')]:
   self.package(set(gate.CAPABILITIES)-{cap});facts={**self.state,state:True}
   with self.assertRaisesRegex(gate.Refused,'CAPABILITIES_INCOMPLETE'):self.verify(facts,'rollback')
 def test_actual_credential_module_roundtrip_wrong_context_and_all_release_gates_pass(self):
  self.package();out=self.verify(self.state,runtime_key_ids=['test']);self.assertEqual(out['status'],'compatibility_gate_passed');self.assertFalse(out['rollbackExecuted']);self.assertFalse(out['databaseModified'])
 def test_unknown_cipher_format_is_never_guessed(self):
  self.package()
  with self.assertRaisesRegex(gate.Refused,'UNSUPPORTED_CREDENTIAL_FORMAT'):self.verify({**self.state,'unsupportedCiphertext':True})
 def test_hash_drift_or_unsafe_business_data_policy_refuses(self):
  m,_=self.package();(self.root/'api/dist/routes/orders.js').write_text('changed')
  with self.assertRaisesRegex(gate.Refused,'FINGERPRINT_MISMATCH'):self.verify(self.state)
  m,_=self.package();m['dataPolicy']['restoreBusinessDatabase']=True;self.manifest.write_text(json.dumps(m))
  with self.assertRaisesRegex(gate.Refused,'UNSAFE_ROLLBACK_DATA_POLICY'):self.verify(self.state)
 def test_business_routes_for_reservation_and_cost_basis_are_required(self):
  for relative in ('api/dist/routes/products.js','api/dist/routes/inventoryNetCostBasis.js'):
   m,_=self.package();m['artifacts'].pop(relative);self.manifest.write_text(json.dumps(m))
   with self.assertRaisesRegex(gate.Refused,'COMPATIBILITY_ARTIFACT_COVERAGE_INCOMPLETE'):
    self.verify(self.state)
 def test_transfer_cost_revaluation_dependencies_are_required(self):
  for relative in ('api/dist/lib/businessTime.js','api/dist/services/inventoryCosting.js',
                   'api/dist/services/inventoryUnits.js','api/dist/services/unitContractGuard.js'):
   with self.subTest(relative=relative):
    m,_=self.package();m['artifacts'].pop(relative);self.manifest.write_text(json.dumps(m))
    with self.assertRaisesRegex(gate.Refused,'COMPATIBILITY_ARTIFACT_COVERAGE_INCOMPLETE'):
     self.verify(self.state)
 def test_missing_or_unmatched_acceptance_evidence_refuses(self):
  m,proof=self.package();proof['cases']['compatibility-gate-enforced']='not-run';self.save_proof(m,proof)
  with self.assertRaisesRegex(gate.Refused,'NOT_VERIFIED'):self.verify(self.state)
  proof['cases']['compatibility-gate-enforced']='passed';proof['candidateFingerprint']='0'*64;self.save_proof(m,proof)
  with self.assertRaisesRegex(gate.Refused,'NOT_VERIFIED'):self.verify(self.state)
 def test_key_escrow_must_cover_both_database_and_current_runtime_ids(self):
  self.package()
  for state,keys in [({**self.state,'credentialKeyIds':['retired']},[]),(self.state,['new-current'])]:
   with self.assertRaisesRegex(gate.Refused,'ESCROW_INCOMPLETE'):self.verify(state,runtime_key_ids=keys)
 def test_same_key_id_with_different_key_material_cannot_reuse_an_old_escrow_receipt(self):
  self.package()
  changed=gate.keyring_fingerprint(json.dumps({'current':'test','keys':{'test':'cd'*32}}))
  with self.assertRaisesRegex(gate.Refused,'ESCROW_RECEIPT_MISMATCH'):gate.verify_package(self.root,self.manifest,self.state,approved_manifest_sha256=gate.checksum(self.manifest),runtime_key_ids=['test'],runtime_keyring_sha256=changed)
 def test_escrow_ciphertext_and_offline_receipt_are_pinned(self):
  m,proof=self.package();(self.root/'credential-keyring.enc').write_bytes(b'changed')
  with self.assertRaisesRegex(gate.Refused,'ESCROW_FINGERPRINT_MISMATCH'):self.verify(self.state)
  self.package();(self.root/'offline-receipt.json').write_text('{}')
  with self.assertRaisesRegex(gate.Refused,'ESCROW_RECEIPT_MISMATCH'):self.verify(self.state)
 def test_package_symlinks_and_traversal_refused(self):
  self.package();p=self.root/'api/dist/routes/orders.js';p.unlink();p.symlink_to(self.root/'rollback-driver.py')
  with self.assertRaisesRegex(gate.Refused,'MISSING_OR_UNSAFE'):self.verify(self.state)
  with self.assertRaises(gate.Refused):gate.safe_file(self.root,'../outside')
 def test_database_boundary_and_explicit_readonly_transaction_no_secret_return(self):
  with patch.dict(os.environ,{'CREDENTIAL_ENCRYPTION_KEYS':'do-not-pass-to-psql'}):env=gate.database_env('postgresql://synthetic@127.0.0.1:15449/dianjie_four_gap_test','isolated')
  self.assertEqual(env['PGOPTIONS'],'-c default_transaction_read_only=on');self.assertNotIn('CREDENTIAL_ENCRYPTION_KEYS',env)
  for url,target in [('postgresql://u@remote:5432/dianjie_four_gap_test','isolated'),('postgresql://u@127.0.0.1:15449/dianjie_v4','uat')]:
   with self.assertRaises(gate.Refused):gate.database_env(url,target)
  catalog={**gate.BASE_FIELDS,'store_transfer_movements':[],'warehouse_net_cost_basis_confirmations':[],'BrowserSessionClock':[],'replenishment_stock_holds':[]}
  commands=[];responses=[catalog,self.state]
  def runner(argv,**kw):
   commands.append(argv);self.assertIn('READ ONLY',argv[-1]);self.assertIn('ROLLBACK',argv[-1]);return subprocess.CompletedProcess(argv,0,json.dumps(responses.pop(0)).encode(),b'')
  self.assertEqual(gate.inspect_state(env,runner),self.state);self.assertEqual(len(commands),2)
  self.assertIn('replenishment_stock_holds',commands[1][-1])
 def test_only_the_separately_approved_manifest_hash_is_accepted(self):
  self.package()
  with self.assertRaisesRegex(gate.Refused,'APPROVED_MANIFEST_FINGERPRINT_REQUIRED'):gate.verify_package(self.root,self.manifest,self.state)
  with self.assertRaisesRegex(gate.Refused,'APPROVED_MANIFEST_FINGERPRINT_MISMATCH'):gate.verify_package(self.root,self.manifest,self.state,approved_manifest_sha256='0'*64)
 def test_keyring_metadata_never_accepts_missing_wrong_length_or_unknown_current(self):
  self.assertEqual(gate.keyring_ids(json.dumps({'current':'test','keys':{'test':'ab'*32}})),['test'])
  for ring in [{},{'current':'other','keys':{'test':'ab'*32}},{'current':'test','keys':{'test':'short'}}]:
   with self.assertRaises(gate.Refused):gate.keyring_ids(json.dumps(ring))
if __name__=='__main__':unittest.main()
