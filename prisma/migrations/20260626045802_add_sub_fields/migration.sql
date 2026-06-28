-- AlterTable
ALTER TABLE "subscription" ADD COLUMN     "deliveryDay" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "plan_benefit" (
    "planId" TEXT NOT NULL,
    "benefitId" TEXT NOT NULL,

    CONSTRAINT "plan_benefit_pkey" PRIMARY KEY ("planId","benefitId")
);

-- CreateIndex
CREATE INDEX "plan_benefit_benefitId_idx" ON "plan_benefit"("benefitId");

-- AddForeignKey
ALTER TABLE "plan_benefit" ADD CONSTRAINT "plan_benefit_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscription_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_benefit" ADD CONSTRAINT "plan_benefit_benefitId_fkey" FOREIGN KEY ("benefitId") REFERENCES "subscription_benefit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
