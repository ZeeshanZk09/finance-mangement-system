/*
  Warnings:

  - Added the required column `tenantId` to the `Package` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tenantId` to the `Session` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "public"."Customer_email_idx";

-- DropIndex
DROP INDEX "public"."Customer_tenantId_idx";

-- DropIndex
DROP INDEX "public"."Item_tenantId_idx";

-- DropIndex
DROP INDEX "public"."Package_price_idx";

-- DropIndex
DROP INDEX "public"."PackageSubscription_packageId_idx";

-- DropIndex
DROP INDEX "public"."PackageSubscription_tenantId_idx";

-- DropIndex
DROP INDEX "public"."Session_userId_idx";

-- DropIndex
DROP INDEX "public"."Tenant_name_idx";

-- DropIndex
DROP INDEX "public"."User_tenantId_idx";

-- DropIndex
DROP INDEX "public"."Vendor_tenantId_idx";

-- AlterTable
ALTER TABLE "public"."Package" ADD COLUMN     "tenantId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "public"."Session" ADD COLUMN     "tenantId" INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX "Customer_tenantId_id_idx" ON "public"."Customer"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Item_tenantId_id_idx" ON "public"."Item"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Package_price_tenantId_name_idx" ON "public"."Package"("price", "tenantId", "name");

-- CreateIndex
CREATE INDEX "PackageSubscription_packageId_tenantId_idx" ON "public"."PackageSubscription"("packageId", "tenantId");

-- CreateIndex
CREATE INDEX "Session_userId_tenantId_id_idx" ON "public"."Session"("userId", "tenantId", "id");

-- CreateIndex
CREATE INDEX "Tenant_name_id_idx" ON "public"."Tenant"("name", "id");

-- CreateIndex
CREATE INDEX "User_tenantId_email_id_idx" ON "public"."User"("tenantId", "email", "id");

-- CreateIndex
CREATE INDEX "Vendor_tenantId_id_email_phone_idx" ON "public"."Vendor"("tenantId", "id", "email", "phone");

-- AddForeignKey
ALTER TABLE "public"."Session" ADD CONSTRAINT "Session_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Package" ADD CONSTRAINT "Package_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
