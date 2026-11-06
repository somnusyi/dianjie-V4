import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
sp=importlib.util.spec_from_file_location('review_gate',Path(__file__).with_name('rollback_compatibility.py'));gate=importlib.util.module_from_spec(sp);sp.loader.exec_module(gate)
class WarehouseReviewGate(unittest.TestCase):
 def test_new_manual_doc_requires_review_qualified_recovery(self):
  self.assertIn('warehouse-review-posting-v1',gate.required_capabilities({'warehouseReviewDocs':True},'rollback'))
 def test_new_count_requires_review_qualified_recovery(self):
  self.assertIn('warehouse-review-posting-v1',gate.required_capabilities({'warehouseReviewStocktakes':True},'rollback'))
 def test_publish_requires_review_capability_without_existing_facts(self):
  self.assertIn('warehouse-review-posting-v1',gate.required_capabilities({},'publish'))
 def test_legacy_records_do_not_implicitly_require_review(self):
  self.assertNotIn('warehouse-review-posting-v1',gate.required_capabilities({'warehouseReviewDocs':False,'warehouseReviewStocktakes':False},'rollback'))
 def test_review_qualified_recovery_covers_real_routes_module_and_schema(self):
  files=set(gate.CAPABILITIES.get('warehouse-review-posting-v1',[]))
  self.assertTrue({'routes/warehouseDocs.js','routes/warehouseInventory.js','routes/warehouseStocktake.js','routes/inventoryManagement.js','services/warehouseReviewPosting.js','services/warehouseDocs.js','services/warehouseStocktake.js','services/warehouseLedger.js'}.issubset(files))
  self.assertIn('packages/db/prisma/schema.prisma',gate.EXTRA_ARTIFACTS.get('warehouse-review-posting-v1',[]))
 def test_unknown_posting_policy_is_not_guessed(self):
  with self.assertRaises(gate.Refused):gate.required_capabilities({'unsupportedWarehousePostingPolicy':True},'rollback')
 def test_probe_checks_both_new_policy_tables_without_writing(self):
  catalog={**gate.BASE_FIELDS,'warehouse_docs':['postingPolicy','postedAt'],'warehouse_stocktakes':['postingPolicy','reviewStatus','auditedAt','auditedById']}
  state={k:False for k in ['ciphertexts','unsupportedCiphertext','submissionV1','replenishmentHolds','frozenSupplierUnits','transferFacts','partialTransfers','netCostBasis','browserSessionClock','warehouseReviewDocs','warehouseReviewStocktakes','unsupportedWarehousePostingPolicy']};state['warehouseReviewDocs']=True;state['credentialKeyIds']=[]
  commands=[]
  with patch.object(gate,'query',side_effect=[catalog,state]) as query:
   self.assertEqual(gate.inspect_state({}),state)
   sql=query.call_args_list[1].args[1]
   self.assertIn('warehouse_docs',sql);self.assertIn('warehouse_stocktakes',sql);self.assertIn('REVIEW',sql);self.assertIn('LEGACY',sql)
   self.assertNotIn('UPDATE ',sql);self.assertNotIn('DELETE ',sql);self.assertNotIn('INSERT ',sql)
 def test_partial_policy_schema_is_rejected_before_data_probe(self):
  catalog={**gate.BASE_FIELDS,'warehouse_docs':['postingPolicy']}
  with patch.object(gate,'query',return_value=catalog) as query:
   with self.assertRaises(gate.Refused):gate.inspect_state({})
   self.assertEqual(query.call_count,1)
if __name__=='__main__':unittest.main()
