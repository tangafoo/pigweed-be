-- Enable PostGIS — required before the post table's geo column (geography
-- type) is created. Hand-added (Prisma doesn't manage extensions). Idempotent.
CREATE EXTENSION IF NOT EXISTS postgis;

-- CreateEnum
CREATE TYPE "animal" AS ENUM ('CHICKEN', 'DOG', 'GOOSE');

-- CreateEnum
CREATE TYPE "gender" AS ENUM ('MALE', 'FEMALE', 'NONBINARY', 'UNDISCLOSED');

-- CreateEnum
CREATE TYPE "vote_value" AS ENUM ('UP', 'DOWN');

-- CreateEnum
CREATE TYPE "achievement_metric" AS ENUM ('POSTS_CREATED', 'COMMENTS_CREATED', 'AWARDS_GRANTED');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "username" TEXT NOT NULL,
    "gender" "gender" NOT NULL,
    "animal" "animal" NOT NULL,
    "avatarSeed" INTEGER NOT NULL,
    "coinBalance" INTEGER NOT NULL DEFAULT 0,
    "unlockCoins" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_pack" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "coins" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "stripePriceId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coin_pack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coin_purchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "coinPackId" TEXT NOT NULL,
    "stripeSessionId" TEXT NOT NULL,
    "stripeEventId" TEXT,
    "coinsGranted" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "coin_purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "upvoteCount" INTEGER NOT NULL DEFAULT 0,
    "downvoteCount" INTEGER NOT NULL DEFAULT 0,
    "moderated" BOOLEAN NOT NULL DEFAULT true,
    -- Hand-edited: Prisma scaffolds this as a plain column. We make it a
    -- Postgres GENERATED column so geo is always derived from lat/lng,
    -- auto-maintained on every insert/update with zero app code.
    "geo" geography(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography) STORED,

    CONSTRAINT "post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_media" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "parentCommentId" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "upvoteCount" INTEGER NOT NULL DEFAULT 0,
    "downvoteCount" INTEGER NOT NULL DEFAULT 0,
    "moderated" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_vote" (
    "userId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "value" "vote_value" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "post_vote_pkey" PRIMARY KEY ("userId","postId")
);

-- CreateTable
CREATE TABLE "comment_vote" (
    "userId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "value" "vote_value" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comment_vote_pkey" PRIMARY KEY ("userId","commentId")
);

-- CreateTable
CREATE TABLE "award_type" (
    "id" TEXT NOT NULL,
    "assetKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCoins" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "award_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_award" (
    "id" TEXT NOT NULL,
    "granterId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "awardTypeId" TEXT NOT NULL,
    "coinsSpent" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_award_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_award" (
    "id" TEXT NOT NULL,
    "granterId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "awardTypeId" TEXT NOT NULL,
    "coinsSpent" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_award_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_granters_unlock" (
    "userId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_granters_unlock_pkey" PRIMARY KEY ("userId","postId")
);

-- CreateTable
CREATE TABLE "comment_granters_unlock" (
    "userId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_granters_unlock_pkey" PRIMARY KEY ("userId","commentId")
);

-- CreateTable
CREATE TABLE "achievement" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "metric" "achievement_metric" NOT NULL,
    "threshold" INTEGER NOT NULL,
    "rewardCoins" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "achievement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_achievement" (
    "userId" TEXT NOT NULL,
    "achievementId" TEXT NOT NULL,
    "rewardCoins" INTEGER NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_achievement_pkey" PRIMARY KEY ("userId","achievementId")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_username_key" ON "user"("username");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "coin_pack_stripePriceId_key" ON "coin_pack"("stripePriceId");

-- CreateIndex
CREATE UNIQUE INDEX "coin_purchase_stripeSessionId_key" ON "coin_purchase"("stripeSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "coin_purchase_stripeEventId_key" ON "coin_purchase"("stripeEventId");

-- CreateIndex
CREATE INDEX "coin_purchase_userId_idx" ON "coin_purchase"("userId");

-- CreateIndex
CREATE INDEX "post_authorId_idx" ON "post"("authorId");

-- CreateIndex
CREATE INDEX "post_createdAt_idx" ON "post"("createdAt");

-- CreateIndex
CREATE INDEX "post_geo_idx" ON "post" USING GIST ("geo");

-- CreateIndex
CREATE INDEX "post_media_postId_idx" ON "post_media"("postId");

-- CreateIndex
CREATE INDEX "comment_postId_idx" ON "comment"("postId");

-- CreateIndex
CREATE INDEX "comment_authorId_idx" ON "comment"("authorId");

-- CreateIndex
CREATE INDEX "comment_parentCommentId_idx" ON "comment"("parentCommentId");

-- CreateIndex
CREATE INDEX "comment_postId_createdAt_idx" ON "comment"("postId", "createdAt");

-- CreateIndex
CREATE INDEX "post_vote_postId_idx" ON "post_vote"("postId");

-- CreateIndex
CREATE INDEX "post_vote_userId_value_idx" ON "post_vote"("userId", "value");

-- CreateIndex
CREATE INDEX "comment_vote_commentId_idx" ON "comment_vote"("commentId");

-- CreateIndex
CREATE INDEX "comment_vote_userId_value_idx" ON "comment_vote"("userId", "value");

-- CreateIndex
CREATE UNIQUE INDEX "award_type_assetKey_key" ON "award_type"("assetKey");

-- CreateIndex
CREATE INDEX "post_award_postId_idx" ON "post_award"("postId");

-- CreateIndex
CREATE INDEX "post_award_granterId_idx" ON "post_award"("granterId");

-- CreateIndex
CREATE INDEX "post_award_postId_awardTypeId_idx" ON "post_award"("postId", "awardTypeId");

-- CreateIndex
CREATE INDEX "comment_award_commentId_idx" ON "comment_award"("commentId");

-- CreateIndex
CREATE INDEX "comment_award_granterId_idx" ON "comment_award"("granterId");

-- CreateIndex
CREATE INDEX "comment_award_commentId_awardTypeId_idx" ON "comment_award"("commentId", "awardTypeId");

-- CreateIndex
CREATE INDEX "post_granters_unlock_postId_idx" ON "post_granters_unlock"("postId");

-- CreateIndex
CREATE INDEX "comment_granters_unlock_commentId_idx" ON "comment_granters_unlock"("commentId");

-- CreateIndex
CREATE UNIQUE INDEX "achievement_key_key" ON "achievement"("key");

-- CreateIndex
CREATE INDEX "achievement_metric_active_idx" ON "achievement"("metric", "active");

-- CreateIndex
CREATE INDEX "user_achievement_userId_idx" ON "user_achievement"("userId");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coin_purchase" ADD CONSTRAINT "coin_purchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coin_purchase" ADD CONSTRAINT "coin_purchase_coinPackId_fkey" FOREIGN KEY ("coinPackId") REFERENCES "coin_pack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post" ADD CONSTRAINT "post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_parentCommentId_fkey" FOREIGN KEY ("parentCommentId") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_vote" ADD CONSTRAINT "post_vote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_vote" ADD CONSTRAINT "post_vote_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_vote" ADD CONSTRAINT "comment_vote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_vote" ADD CONSTRAINT "comment_vote_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_award" ADD CONSTRAINT "post_award_granterId_fkey" FOREIGN KEY ("granterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_award" ADD CONSTRAINT "post_award_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_award" ADD CONSTRAINT "post_award_awardTypeId_fkey" FOREIGN KEY ("awardTypeId") REFERENCES "award_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_award" ADD CONSTRAINT "comment_award_granterId_fkey" FOREIGN KEY ("granterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_award" ADD CONSTRAINT "comment_award_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_award" ADD CONSTRAINT "comment_award_awardTypeId_fkey" FOREIGN KEY ("awardTypeId") REFERENCES "award_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_granters_unlock" ADD CONSTRAINT "post_granters_unlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_granters_unlock" ADD CONSTRAINT "post_granters_unlock_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_granters_unlock" ADD CONSTRAINT "comment_granters_unlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_granters_unlock" ADD CONSTRAINT "comment_granters_unlock_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_achievement" ADD CONSTRAINT "user_achievement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_achievement" ADD CONSTRAINT "user_achievement_achievementId_fkey" FOREIGN KEY ("achievementId") REFERENCES "achievement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
