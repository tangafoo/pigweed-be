-- CreateEnum
CREATE TYPE "post_category" AS ENUM ('EGGS', 'VEGGIES', 'FRUITS');

-- AlterTable
ALTER TABLE "post" ADD COLUMN     "category" "post_category",
ADD COLUMN     "rating" INTEGER;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "isFarmOwner" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "post_category_idx" ON "post"("category");
