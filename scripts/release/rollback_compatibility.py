#!/usr/bin/env python3
"""Read-only release/rollback gate. It never invokes a restore, migration or rollback driver."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import urllib.parse

CAPABILITIES={
 'warehouse-review-posting-v1': ['routes/warehouseDocs.js','routes/warehouseInventory.js','routes/warehouseStocktake.js','routes/inventoryManagement.js','routes/warehouseInboundDrafts.js','services/warehouseReviewPosting.js','services/warehouseDocs.js','services/warehouseStocktake.js','services/inventoryManagement.js','services/warehouseInboundDrafts.js','services/warehouseLedger.js'],
 'credential-envelope-v1': ['lib/credential-vault.js','services/wecom.js','services/meituan/tokenStore.js','routes/wecom.js','routes/stores.js','lib/safe-request-log.js','lib/provider-log-safety.js','services/meituan/callLogger.js','services/meituan/client.js','routes/meituanAdmin.js','services/notify/index.js'],
 'submission-reservation-v1': ['routes/orders.js','routes/products.js','routes/replenishmentOrders.js','services/orderSubmissionReservation.js','services/warehouseLedger.js','services/warehouseLedgerAudit.js','services/supplierStockReservation.js','services/deliveryItemRemoval.js','services/replenishmentOrderService.js','services/replenishmentStockReservation.js'],
 'store-transfer-posting-v1': ['routes/storeTransfers.js','lib/businessTime.js','services/storeTransferPosting.js','services/storeInventory.js','services/inventoryCosting.js','services/inventoryUnits.js','services/unitContractGuard.js'],
 'inventory-net-cost-basis-v1': ['routes/inventoryNetCostBasis.js','routes/inventoryReports.js','services/inventoryReports.js','services/inventoryNetCost.js','services/inventoryNetCostRead.js','services/inventoryNetCostBasis.js','services/inventoryNetReportProjection.js','services/inventoryReportSupplement.js'],
 'browser-session-v1': ['index.js','lib/browser-session.js','lib/authenticate-principal.js','lib/revoke-session.js','lib/idempotency.js','services/authTokens.js','services/browserSessionOrder.js','routes/auth.js','routes/users.js'],
}
EXTRA_ARTIFACTS={
 'warehouse-review-posting-v1':['packages/db/prisma/schema.prisma'],
 'credential-envelope-v1':['packages/db/index.js'],
 'browser-session-v1':['web/BUILD_ID','web/application.tar.gz'],
 'submission-reservation-v1':['packages/db/prisma/schema.prisma'],
 'store-transfer-posting-v1':['packages/db/prisma/schema.prisma'],
 'inventory-net-cost-basis-v1':['packages/db/prisma/schema.prisma'],
}
BASE_FIELDS={
 'wecom_configs':['appSecret','contactSecret','callbackToken','encodingAESKey','accessToken','contactToken'],
 'meituan_auth_tokens':['appAuthToken','refreshToken'],
 'stores':['aggregatorApiKeyEnc','aggregatorSecretEnc','wechatApiV3KeyEnc','alipayPrivateKeyEnc'],
 'purchase_orders':['submittedSnapshot'], 'store_transfers':['status'],
}
class Refused(Exception):pass

def checksum(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()

def query(env,sql,runner=subprocess.run):
 result=runner(['psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-c','BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout=15000; '+sql+'; ROLLBACK;'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
 if result.returncode:raise Refused('READ_ONLY_DATABASE_PROBE_FAILED')
 try:return json.loads(result.stdout)
 except Exception:raise Refused('READ_ONLY_DATABASE_RESULT_INVALID')

def database_env(url,target):
 try:p=urllib.parse.urlsplit(url)
 except Exception:raise Refused('DATABASE_BOUNDARY_INVALID')
 if p.scheme not in ('postgres','postgresql') or not p.hostname:raise Refused('DATABASE_BOUNDARY_INVALID')
 name=p.path.lstrip('/')
 if target in ('production','uat') and name!={'production':'dianjie_v4','uat':'dianjie_v4_uat'}[target]:raise Refused('DATABASE_ENVIRONMENT_MISMATCH')
 if target=='isolated' and (p.hostname not in ('127.0.0.1','localhost','::1') or p.port not in (15439,15449) or not name.startswith('dianjie_') or not name.endswith('test')):raise Refused('ISOLATED_DATABASE_REQUIRED')
 env={k:os.environ[k] for k in ['PATH','HOME','LANG','LC_ALL'] if k in os.environ};env.update(PGHOST=p.hostname,PGPORT=str(p.port or 5432),PGDATABASE=name,PGUSER=urllib.parse.unquote(p.username or ''),PGPASSWORD=urllib.parse.unquote(p.password or ''),PGOPTIONS='-c default_transaction_read_only=on')
 ssl=urllib.parse.parse_qs(p.query).get('sslmode')
 if ssl:env['PGSSLMODE']=ssl[0]
 return env

def inspect_state(env,runner=subprocess.run):
 catalog=query(env,"SELECT coalesce(json_object_agg(table_name, cols),'{}'::json) FROM (SELECT table_name,json_agg(column_name) cols FROM information_schema.columns WHERE table_schema='public' GROUP BY table_name) c",runner)
 for table,fields in BASE_FIELDS.items():
  if table not in catalog or not set(fields).issubset(catalog[table]):raise Refused('DATABASE_SCHEMA_NOT_RECOGNIZED')
 review_fields={'warehouse_docs':{'postingPolicy','postedAt'},'warehouse_stocktakes':{'postingPolicy','reviewStatus','auditedAt','auditedById'}}
 for table,fields in review_fields.items():
  if 'postingPolicy' in catalog.get(table,[]) and not fields.issubset(catalog[table]):raise Refused('WAREHOUSE_REVIEW_SCHEMA_INCOMPLETE')
 scans=[];unknown=[];key_scans=[]
 for table in ['wecom_configs','meituan_auth_tokens','stores']:
  for field in BASE_FIELDS[table]:
   scans.append(f'''SELECT 1 FROM "{table}" WHERE "{field}" LIKE 'djenc:v1:%' ''')
   key_scans.append(f'''SELECT split_part("{field}", ':', 3) AS key_id FROM "{table}" WHERE "{field}" LIKE 'djenc:v1:%' ''')
   unknown.append(f'''SELECT 1 FROM "{table}" WHERE "{field}" LIKE 'djenc:%' AND "{field}" NOT LIKE 'djenc:v1:%' ''')
 def exists(table,where='true'):
  return f'''EXISTS(SELECT 1 FROM "{table}" WHERE {where})''' if table in catalog else 'false'
 pairs={
  'ciphertexts':"EXISTS("+' UNION ALL '.join(scans)+')',
  'unsupportedCiphertext':"EXISTS("+' UNION ALL '.join(unknown)+')',
  'submissionV1':'''EXISTS(SELECT 1 FROM purchase_orders WHERE "submittedSnapshot"->>'stockReservationPolicy'='SUBMISSION_V1')''',
  'replenishmentHolds':exists('replenishment_stock_holds'),
  'warehouseReviewDocs':exists('warehouse_docs',"\"postingPolicy\"='REVIEW'") if 'postingPolicy' in catalog.get('warehouse_docs',[]) else 'false',
  'warehouseReviewStocktakes':exists('warehouse_stocktakes',"\"postingPolicy\"='REVIEW'") if 'postingPolicy' in catalog.get('warehouse_stocktakes',[]) else 'false',
  'unsupportedWarehousePostingPolicy':' OR '.join(exists(table,"\"postingPolicy\" IS NULL OR \"postingPolicy\" NOT IN ('LEGACY','REVIEW')") for table in review_fields if 'postingPolicy' in catalog.get(table,[])) or 'false',
  'frozenSupplierUnits':exists('supplier_stock_reservations','"stockUnitSnapshot" IS NOT NULL') if 'stockUnitSnapshot' in catalog.get('supplier_stock_reservations',[]) else 'false',
  'transferFacts':exists('store_transfer_movements'),
  'partialTransfers':'''EXISTS(SELECT 1 FROM store_transfers WHERE status::text='PARTIALLY_RECEIVED')''',
  'netCostBasis':exists('warehouse_net_cost_basis_confirmations'),
  'browserSessionClock':exists('BrowserSessionClock'),
 }
 pairs['credentialKeyIds']="(SELECT coalesce(json_agg(DISTINCT key_id),'[]'::json) FROM ("+' UNION ALL '.join(key_scans)+") k)"
 result=query(env,'SELECT json_build_object('+','.join("'"+name+"',"+sql for name,sql in pairs.items())+')',runner)
 if set(result)!=set(pairs) or any(type(result[k])is not bool for k in pairs if k!='credentialKeyIds') or not isinstance(result['credentialKeyIds'],list) or any(not isinstance(k,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,40}',k) for k in result['credentialKeyIds']):raise Refused('DATABASE_STATE_INVALID')
 return result

def safe_file(root,relative):
 if not isinstance(relative,str) or not relative or Path(relative).is_absolute() or '..' in Path(relative).parts:raise Refused('UNSAFE_PACKAGE_PATH')
 root=Path(root).resolve();file=root/relative
 if not file.is_file() or file.is_symlink() or root not in file.resolve().parents:raise Refused('PACKAGE_ARTIFACT_MISSING_OR_UNSAFE')
 for parent in file.parents:
  if parent==root:break
  if parent.is_symlink():raise Refused('PACKAGE_ARTIFACT_MISSING_OR_UNSAFE')
 return file

def required_capabilities(state,mode):
 if state.get('unsupportedCiphertext'):raise Refused('UNSUPPORTED_CREDENTIAL_FORMAT')
 if state.get('unsupportedWarehousePostingPolicy'):raise Refused('UNSUPPORTED_WAREHOUSE_POSTING_POLICY')
 required=set(CAPABILITIES) if mode=='publish' else set()
 if state.get('ciphertexts'):required.add('credential-envelope-v1')
 if state.get('submissionV1') or state.get('frozenSupplierUnits') or state.get('replenishmentHolds'):required.add('submission-reservation-v1')
 if state.get('transferFacts') or state.get('partialTransfers'):required.add('store-transfer-posting-v1')
 if state.get('netCostBasis'):required.add('inventory-net-cost-basis-v1')
 if state.get('browserSessionClock'):required.add('browser-session-v1')
 if state.get('warehouseReviewDocs') or state.get('warehouseReviewStocktakes'):required.add('warehouse-review-posting-v1')
 return required

def recovery_identity(manifest):
 """New manifests distinguish runtime reconstruction from a software rollback.

 Legacy compatible-rollback manifests retain their existing meaning and gates.
 A forward delivery manifest is never accepted by assigning a recoveryKind.
 """
 kind = manifest.get('packageKind')
 if kind == 'compatible-rollback':
  if 'recoveryKind' in manifest:
   raise Refused('RECOVERY_KIND_REQUIRES_EXPLICIT_PACKAGE')
  return None
 if kind != 'compatible-recovery':
  raise Refused('LEGACY_OR_UNVERIFIED_ROLLBACK_REFUSED')
 recovery_kind = manifest.get('recoveryKind')
 if recovery_kind not in ('same-version-redeploy', 'compatible-version-rollback'):
  raise Refused('EXPLICIT_RECOVERY_KIND_REQUIRED')
 def pair(value):
  if not isinstance(value,dict) or set(value) != {'api','web'} or any(
   not isinstance(v,str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',v) for v in value.values()):
   raise Refused('PINNED_RECOVERY_IMAGES_REQUIRED')
  return value
 source = pair(manifest.get('recoverySourceImages'))
 target = pair(manifest.get('runtimeImages'))
 if recovery_kind == 'same-version-redeploy' and source != target:
  raise Refused('SAME_VERSION_RECOVERY_IMAGE_MISMATCH')
 if recovery_kind == 'compatible-version-rollback' and source == target:
  raise Refused('SOFTWARE_ROLLBACK_REQUIRES_DIFFERENT_RUNTIME')
 return {'recoveryKind':recovery_kind, 'sourceImages':source, 'targetImages':target,
         'scope':'runtime-only' if recovery_kind == 'same-version-redeploy' else 'software-version'}


def credential_probe(root,node='node'):
 module=safe_file(root,'api/dist/lib/credential-vault.js')
 # Only the reviewed pure vault module is loaded. No application entrypoint, DB client or provider is invoked.
 code="""const crypto=require('node:crypto');process.env.CREDENTIAL_ENCRYPTION_KEYS=JSON.stringify({current:'probe',keys:{probe:crypto.randomBytes(32).toString('hex')}});process.env.CREDENTIAL_LEGACY_READ_ALLOWED='false';const v=require(process.argv[1]);const c=v.credentialContext('synthetic-tenant','wecom','appSecret'),cipher=v.sealCredential('synthetic-probe-only',c);if(!cipher.startsWith('djenc:v1:')||v.openCredential(cipher,c)!=='synthetic-probe-only')process.exit(2);let refused=false;try{v.openCredential(cipher,c+'wrong')}catch{refused=true}if(!refused)process.exit(3);"""
 result=subprocess.run([node,'-e',code,str(module)],env={k:os.environ[k] for k in ['PATH','HOME','LANG','LC_ALL'] if k in os.environ},stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
 if result.returncode:raise Refused('CANDIDATE_CREDENTIAL_READER_PROBE_FAILED')

def keyring_ids(raw):
 try:
  ring=json.loads(raw);keys=ring['keys']
  if not isinstance(keys,dict) or ring['current'] not in keys or not keys:raise ValueError()
  for key,value in keys.items():
   if not re.fullmatch(r'[a-zA-Z0-9_-]{1,40}',key) or not isinstance(value,str) or not re.fullmatch(r'[a-fA-F0-9]{64}',value):raise ValueError()
  return sorted(keys)
 except Exception:raise Refused('CREDENTIAL_KEYRING_METADATA_INVALID')

def keyring_fingerprint(raw):
 keyring_ids(raw)
 ring=json.loads(raw)
 return hashlib.sha256(json.dumps({'current':ring['current'],'keys':ring['keys']},sort_keys=True,separators=(',',':')).encode()).hexdigest()

def verify_package(root,manifest_path,state,mode='publish',node='node',probe=credential_probe,runtime_key_ids=None,runtime_keyring_sha256=None,approved_manifest_sha256=None):
 required=required_capabilities(state,mode)
 if not manifest_path:raise Refused('VERIFIED_COMPATIBLE_ROLLBACK_PACKAGE_REQUIRED')
 if not isinstance(approved_manifest_sha256,str) or not re.fullmatch(r'[a-f0-9]{64}',approved_manifest_sha256):raise Refused('APPROVED_MANIFEST_FINGERPRINT_REQUIRED')
 if checksum(manifest_path)!=approved_manifest_sha256:raise Refused('APPROVED_MANIFEST_FINGERPRINT_MISMATCH')
 try:m=json.loads(Path(manifest_path).read_text())
 except Exception:raise Refused('COMPATIBILITY_MANIFEST_INVALID')
 if m.get('format')!=1:raise Refused('LEGACY_OR_UNVERIFIED_ROLLBACK_REFUSED')
 identity=recovery_identity(m)
 policy=m.get('dataPolicy',{})
 if any(policy.get(k) is not False for k in ['restoreBusinessDatabase','decryptCredentialsAtRest','runSchemaDownMigrations']):raise Refused('UNSAFE_ROLLBACK_DATA_POLICY')
 if not required.issubset(set(m.get('retainedCapabilities',[]))):raise Refused('ROLLBACK_CAPABILITIES_INCOMPLETE')
 artifacts=m.get('artifacts');
 if not isinstance(artifacts,dict) or not artifacts:raise Refused('PACKAGE_FINGERPRINT_REQUIRED')
 for relative,sha in artifacts.items():
  if not isinstance(sha,str) or len(sha)!=64 or checksum(safe_file(root,relative))!=sha:raise Refused('PACKAGE_FINGERPRINT_MISMATCH')
 if required:
  for relative in ['api/application.tar.gz','packages/db/client.tar.gz']:
   if relative not in artifacts:raise Refused('COMPLETE_API_AND_GENERATED_CLIENT_ARTIFACTS_REQUIRED')
 for capability in required:
  for file in CAPABILITIES[capability]:
   if 'api/dist/'+file not in artifacts:raise Refused('COMPATIBILITY_ARTIFACT_COVERAGE_INCOMPLETE')
  for file in EXTRA_ARTIFACTS.get(capability,[]):
   if file not in artifacts:raise Refused('COMPATIBILITY_ARTIFACT_COVERAGE_INCOMPLETE')
 driver=m.get('rollbackDriver')
 if not driver or driver not in artifacts:raise Refused('VERIFIED_ROLLBACK_DRIVER_REQUIRED')
 fingerprint=hashlib.sha256(json.dumps(artifacts,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 evidence=m.get('verificationEvidence',{})
 proof_file=safe_file(root,evidence.get('path'))
 if checksum(proof_file)!=evidence.get('sha256'):raise Refused('COMPATIBILITY_EVIDENCE_MISMATCH')
 try:proof=json.loads(proof_file.read_text())
 except Exception:raise Refused('COMPATIBILITY_EVIDENCE_INVALID')
 if proof.get('candidateFingerprint')!=fingerprint or proof.get('status')!='passed' or any(proof.get('cases',{}).get(cap)!='passed' for cap in required | {'no-business-data-rewrite','wrong-target-refused','compatibility-gate-enforced'}):raise Refused('COMPATIBLE_ROLLBACK_NOT_VERIFIED')
 if identity is not None:
  # New evidence must attest this exact kind and both pinned image pairs. Merely
  # changing labels or borrowing a different recovery strategy's proof fails.
  if proof.get('recoveryIdentity') != identity or proof.get('cases',{}).get(identity['recoveryKind']) != 'passed':
   raise Refused('RECOVERY_KIND_EVIDENCE_MISMATCH')
 if 'credential-envelope-v1' in required:
  escrow=proof.get('credentialKeyEscrow') or {}
  if escrow.get('offlineRecoveryVerified') is not True or not isinstance(escrow.get('keyIds'),list) or not escrow['keyIds']:raise Refused('OFFLINE_CREDENTIAL_KEY_ESCROW_REQUIRED')
  if not set(state.get('credentialKeyIds',[]) + (runtime_key_ids or [])).issubset(set(escrow['keyIds'])):raise Refused('CREDENTIAL_KEY_ESCROW_INCOMPLETE')
  escrow_file=safe_file(root,escrow.get('path'))
  if checksum(escrow_file)!=escrow.get('sha256'):raise Refused('CREDENTIAL_KEY_ESCROW_FINGERPRINT_MISMATCH')
  receipt_file=safe_file(root,escrow.get('receiptPath'))
  if checksum(receipt_file)!=escrow.get('receiptSha256'):raise Refused('OFFLINE_KEY_ESCROW_RECEIPT_MISMATCH')
  if not isinstance(runtime_keyring_sha256,str) or not re.fullmatch(r'[a-f0-9]{64}',runtime_keyring_sha256):raise Refused('RUNTIME_KEYRING_FINGERPRINT_REQUIRED')
  receipt=json.loads(receipt_file.read_text())
  if receipt.get('status')!='offline_credential_keyring_verified' or receipt.get('offlineRecoveryVerified') is not True or receipt.get('encryptedSha256')!=escrow['sha256'] or set(receipt.get('keyIds',[]))!=set(escrow['keyIds']) or receipt.get('plaintextSha256')!=runtime_keyring_sha256:raise Refused('OFFLINE_KEY_ESCROW_RECEIPT_MISMATCH')
  probe(root,node)
 result={'status':'compatibility_gate_passed','mode':mode,'requiredCapabilities':sorted(required),'candidateFingerprint':fingerprint,'rollbackExecuted':False,'databaseModified':False}
 if identity is not None:result['recoveryIdentity']=identity
 return result

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--target',choices=['production','uat','isolated'],required=True);p.add_argument('--database-url-env',default='DATABASE_URL');p.add_argument('--candidate-root',required=True);p.add_argument('--compat-manifest');p.add_argument('--approved-manifest-sha256');p.add_argument('--mode',choices=['publish','rollback'],default='publish');p.add_argument('--node',default='node');p.add_argument('--credential-keys-env',default='CREDENTIAL_ENCRYPTION_KEYS');a=p.parse_args()
 try:
  state=inspect_state(database_env(os.environ.get(a.database_url_env,''),a.target))
  needed=required_capabilities(state,a.mode)
  runtime_raw=os.environ.get(a.credential_keys_env,'')
  runtime_keys=keyring_ids(runtime_raw) if 'credential-envelope-v1' in needed else []
  runtime_fingerprint=keyring_fingerprint(runtime_raw) if 'credential-envelope-v1' in needed else None
  result=verify_package(a.candidate_root,a.compat_manifest,state,a.mode,a.node,runtime_key_ids=runtime_keys,runtime_keyring_sha256=runtime_fingerprint,approved_manifest_sha256=a.approved_manifest_sha256);print(json.dumps({**result,'state':state}))
 except Exception as error:
  print(json.dumps({'status':'blocked','reason':str(error) if isinstance(error,Refused) else 'PREFLIGHT_FAILED','rollbackExecuted':False,'databaseModified':False}));raise SystemExit(1)
if __name__=='__main__':main()
