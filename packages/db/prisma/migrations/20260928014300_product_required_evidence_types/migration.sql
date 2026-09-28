ALTER TABLE "products"
  ADD COLUMN "requiredEvidenceTypes" "SupplierEvidenceDocumentType"[] NOT NULL DEFAULT ARRAY[]::"SupplierEvidenceDocumentType"[];

ALTER TABLE "product_evidence_requirement_changes"
  ADD COLUMN "beforeRequiredTypes" "SupplierEvidenceDocumentType"[] NOT NULL DEFAULT ARRAY[]::"SupplierEvidenceDocumentType"[],
  ADD COLUMN "afterRequiredTypes" "SupplierEvidenceDocumentType"[] NOT NULL DEFAULT ARRAY[]::"SupplierEvidenceDocumentType"[];

ALTER TABLE "products"
  ADD CONSTRAINT "products_required_evidence_types_check" CHECK (
    NOT ('BUSINESS_LICENSE'::"SupplierEvidenceDocumentType" = ANY("requiredEvidenceTypes"))
    AND (
      "evidenceRequirement" = 'REQUIRED'::"ProductEvidenceRequirement"
      OR cardinality("requiredEvidenceTypes") = 0
    )
  );

ALTER TABLE "product_evidence_requirement_changes"
  ADD CONSTRAINT "product_evidence_requirement_changes_types_check" CHECK (
    NOT ('BUSINESS_LICENSE'::"SupplierEvidenceDocumentType" = ANY("beforeRequiredTypes"))
    AND NOT ('BUSINESS_LICENSE'::"SupplierEvidenceDocumentType" = ANY("afterRequiredTypes"))
    AND (
      "beforeStatus" = 'REQUIRED'::"ProductEvidenceRequirement"
      OR cardinality("beforeRequiredTypes") = 0
    )
    AND (
      "afterStatus" = 'REQUIRED'::"ProductEvidenceRequirement"
      OR cardinality("afterRequiredTypes") = 0
    )
  );
