-- 供应商门户批注按公司隔离：供应商页=本公司ID，其余=null
ALTER TABLE "page_annotations" ADD COLUMN "scopeSupplierId" TEXT;
