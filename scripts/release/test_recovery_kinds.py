"""Pure local manifest/CLI guards; fixtures are not runtime recovery evidence."""
import copy
import json
import unittest
import test_rollback_compatibility as fixtures
import rehearse_compatible_switch as switch
from test_rehearse_compatible_switch import plan

gate=fixtures.gate

class RecoveryKinds(fixtures.RollbackGate):
 def explicit_package(self,kind='same-version-redeploy'):
  m,proof=self.package()
  source={role:item['imageId'] for role,item in plan()['previous'].items()}
  target=copy.deepcopy(source)
  if kind=='compatible-version-rollback':target['api']='sha256:'+'f'*64
  m.update(packageKind='compatible-recovery',recoveryKind=kind,recoverySourceImages=source,runtimeImages=target)
  proof['recoveryIdentity']=copy.deepcopy(gate.recovery_identity(m))
  proof['cases'][kind]='passed'
  self.save_proof(m,proof)
  return m,proof
 def test_kind_same_version_full_gate_passes_without_claiming_software_rollback(self):
  m,_=self.explicit_package();out=self.verify(self.state,runtime_key_ids=['test'])
  self.assertEqual(out['recoveryIdentity']['scope'],'runtime-only')
  self.assertFalse(out['rollbackExecuted']);self.assertFalse(out['databaseModified'])
  images,identity=switch.validate_recovery_candidate(m,plan())
  self.assertEqual(images,m['runtimeImages']);self.assertEqual(identity['scope'],'runtime-only')
 def test_kind_old_forward_cannot_acquire_permission_from_recovery_kind(self):
  m,_=self.explicit_package();m['packageKind']='forward';self.manifest.write_text(json.dumps(m))
  with self.assertRaisesRegex(gate.Refused,'LEGACY_OR_UNVERIFIED'):self.verify(self.state)
  with self.assertRaisesRegex(switch.gate.Refused,'FORWARD_PACKAGE'):switch.validate_recovery_candidate(m,plan())
 def test_kind_same_version_does_not_accept_changed_or_wrong_source_images(self):
  m,_=self.explicit_package();m['runtimeImages']['api']='sha256:'+'f'*64
  with self.assertRaisesRegex(gate.Refused,'SAME_VERSION_RECOVERY_IMAGE_MISMATCH'):gate.recovery_identity(m)
  m,_=self.explicit_package();m['runtimeImages']['api']=m['recoverySourceImages']['api']='sha256:'+'f'*64
  with self.assertRaisesRegex(switch.gate.Refused,'RECOVERY_SOURCE_RUNTIME_MISMATCH'):switch.validate_recovery_candidate(m,plan())
 def test_kind_legacy_relabel_stays_refused_and_cannot_opt_in_implicitly(self):
  m,_=self.package();m['runtimeImages']={r:i['imageId']for r,i in plan()['previous'].items()}
  with self.assertRaisesRegex(switch.gate.Refused,'RELABEL_REFUSED'):switch.validate_recovery_candidate(m,plan())
  m['recoveryKind']='same-version-redeploy'
  with self.assertRaisesRegex(gate.Refused,'EXPLICIT_PACKAGE'):gate.recovery_identity(m)
 def test_kind_software_rollback_retains_distinct_semantics(self):
  m,_=self.explicit_package('compatible-version-rollback');out=self.verify(self.state,runtime_key_ids=['test'])
  self.assertEqual(out['recoveryIdentity']['scope'],'software-version')
  self.assertEqual(switch.validate_recovery_candidate(m,plan())[1]['scope'],'software-version')
  m['runtimeImages']=copy.deepcopy(m['recoverySourceImages'])
  with self.assertRaisesRegex(gate.Refused,'SOFTWARE_ROLLBACK_REQUIRES_DIFFERENT_RUNTIME'):gate.recovery_identity(m)
 def test_kind_unknown_missing_and_unpinned_identity_refused(self):
  for field,value in [('recoveryKind','other'),('recoveryKind',None),('runtimeImages',{}),('recoverySourceImages',{'api':'latest','web':'latest'})]:
   m,_=self.explicit_package();m[field]=value
   with self.subTest(field=field,value=value),self.assertRaises(gate.Refused):gate.recovery_identity(m)
 def test_kind_proof_cannot_be_borrowed_between_strategy_source_or_target(self):
  for mutate in [lambda p:p.pop('recoveryIdentity'),lambda p:p['recoveryIdentity'].update(recoveryKind='compatible-version-rollback'),lambda p:p['recoveryIdentity']['sourceImages'].update(api='sha256:'+'f'*64),lambda p:p['recoveryIdentity']['targetImages'].update(web='sha256:'+'f'*64),lambda p:p['cases'].pop('same-version-redeploy')]:
   m,proof=self.explicit_package();mutate(proof);self.save_proof(m,proof)
   with self.assertRaisesRegex(gate.Refused,'RECOVERY_KIND_EVIDENCE_MISMATCH'):self.verify(self.state)
 def test_kind_all_six_capabilities_required_with_new_review_facts(self):
  facts={**self.state,'ciphertexts':True,'submissionV1':True,'transferFacts':True,'netCostBasis':True,'browserSessionClock':True,'warehouseReviewDocs':True,'warehouseReviewStocktakes':True}
  for cap in gate.CAPABILITIES:
   m,_=self.explicit_package();m['retainedCapabilities'].remove(cap);self.manifest.write_text(json.dumps(m))
   with self.subTest(cap=cap),self.assertRaisesRegex(gate.Refused,'CAPABILITIES_INCOMPLETE'):self.verify(facts,'rollback')
 def test_kind_legacy_132_does_not_satisfy_new_facts(self):
  m,_=self.package({'browser-session-v1'});m['version']='1.3.2';self.manifest.write_text(json.dumps(m))
  with self.assertRaisesRegex(gate.Refused,'CAPABILITIES_INCOMPLETE'):self.verify({**self.state,'ciphertexts':True,'submissionV1':True,'transferFacts':True,'netCostBasis':True},'rollback')
 def test_kind_full_runtime_artifacts_are_not_optional(self):
  for relative in ['api/application.tar.gz','packages/db/client.tar.gz','web/application.tar.gz']:
   m,_=self.explicit_package();m['artifacts'].pop(relative);self.manifest.write_text(json.dumps(m))
   with self.subTest(relative=relative),self.assertRaises(gate.Refused):self.verify(self.state)
 def test_kind_hash_and_exact_offline_key_material_protection_remain(self):
  m,_=self.explicit_package();(self.root/'api/dist/routes/orders.js').write_text('changed')
  with self.assertRaisesRegex(gate.Refused,'FINGERPRINT_MISMATCH'):self.verify(self.state)
  m,proof=self.explicit_package();(self.root/'offline-receipt.json').write_text('{}')
  with self.assertRaisesRegex(gate.Refused,'ESCROW_RECEIPT_MISMATCH'):self.verify(self.state)
  self.explicit_package();changed=gate.keyring_fingerprint(json.dumps({'current':'test','keys':{'test':'cd'*32}}))
  with self.assertRaisesRegex(gate.Refused,'ESCROW_RECEIPT_MISMATCH'):
   gate.verify_package(self.root,self.manifest,self.state,approved_manifest_sha256=gate.checksum(self.manifest),runtime_key_ids=['test'],runtime_keyring_sha256=changed)
 def test_kind_unsafe_database_or_plaintext_policy_never_relaxed(self):
  for policy in ['restoreBusinessDatabase','decryptCredentialsAtRest','runSchemaDownMigrations']:
   m,_=self.explicit_package();m['dataPolicy'][policy]=True;self.manifest.write_text(json.dumps(m))
   with self.subTest(policy=policy),self.assertRaisesRegex(gate.Refused,'UNSAFE_ROLLBACK_DATA_POLICY'):self.verify(self.state)

# Reuse the existing package fixture but do not count inherited tests a second time.
def load_tests(loader,tests,pattern):
 return unittest.TestSuite(RecoveryKinds(name) for name in RecoveryKinds.__dict__ if name.startswith('test_kind_'))
