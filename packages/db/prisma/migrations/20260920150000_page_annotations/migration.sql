-- UAT 灰度专用页面批注层：与业务表零外键隔离
CREATE TABLE "page_annotations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pageKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "authorPhone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_annotations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "page_annotations_tenantId_pageKey_createdAt_idx" ON "page_annotations"("tenantId", "pageKey", "createdAt");
