-- AlterTable
ALTER TABLE "egg_order" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "unitPriceCents" INTEGER NOT NULL DEFAULT 200;

-- CreateIndex
CREATE INDEX "egg_order_orderedAt_idx" ON "egg_order"("orderedAt");
