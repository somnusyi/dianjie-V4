-- Preserve inbound drafts and add a separately scoped outbound server draft mode.
ALTER TABLE "warehouse_inbound_drafts" DROP CONSTRAINT "warehouse_inbound_drafts_mode_check";
ALTER TABLE "warehouse_inbound_drafts" ADD CONSTRAINT "warehouse_inbound_drafts_mode_check" CHECK ("mode" IN ('SINGLE','BATCH','OUTBOUND'));
