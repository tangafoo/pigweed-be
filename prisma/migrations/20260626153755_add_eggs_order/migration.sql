-- CreateEnum
CREATE TYPE "egg_order_source" AS ENUM ('MANUAL', 'SUBSCRIPTION');

-- CreateTable
CREATE TABLE "egg_order" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eggs" INTEGER NOT NULL,
    "orderedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "egg_order_source" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "egg_order_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "egg_order_userId_orderedAt_idx" ON "egg_order"("userId", "orderedAt");

-- AddForeignKey
ALTER TABLE "egg_order" ADD CONSTRAINT "egg_order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
