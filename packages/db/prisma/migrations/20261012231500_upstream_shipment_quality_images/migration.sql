BEGIN;
ALTER TABLE document_quality_images ADD COLUMN "shipmentId" VARCHAR(64);
ALTER TABLE document_quality_images ADD CONSTRAINT document_quality_images_tenantId_shipmentId_fkey FOREIGN KEY ("tenantId","shipmentId") REFERENCES upstream_shipments("tenantId",id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX document_quality_images_tenantId_shipmentId_version_key ON document_quality_images("tenantId","shipmentId",version);
ALTER TABLE document_quality_images DROP CONSTRAINT document_quality_source_check;
ALTER TABLE document_quality_images ADD CONSTRAINT document_quality_source_check CHECK (num_nonnulls("warehouseDocId","receiptId","returnId","shipmentId")=1);
COMMIT;
