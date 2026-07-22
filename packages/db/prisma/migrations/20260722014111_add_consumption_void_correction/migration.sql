-- AlterTable
ALTER TABLE "stock_consumptions" ADD COLUMN     "correctionOfId" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedById" TEXT,
ADD COLUMN     "voidedReason" VARCHAR(200);

-- AddForeignKey
ALTER TABLE "stock_consumptions" ADD CONSTRAINT "stock_consumptions_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_consumptions" ADD CONSTRAINT "stock_consumptions_correctionOfId_fkey" FOREIGN KEY ("correctionOfId") REFERENCES "stock_consumptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
