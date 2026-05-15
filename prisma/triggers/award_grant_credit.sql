-- ─────────────────────────────────────────────────────────────
-- Postgres trigger: every 10th award a user grants (across both
-- post_award + comment_award) adds 5 unlockCoins to that user.
--
-- Why a DB trigger instead of app code: atomicity. The trigger
-- runs inside the same transaction as the award INSERT, so two
-- concurrent grants cannot both fire the milestone twice. App
-- code doing "count, then update" would race.
--
-- Prisma does NOT manage triggers; this lives in a hand-written
-- migration. Copy this whole file into a new migration body to
-- apply it.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pigweed_credit_unlock_coins_on_grant()
RETURNS TRIGGER AS $$
DECLARE
  total_grants INT;
BEGIN
  SELECT
    (SELECT COUNT(*) FROM "post_award"    WHERE "granterId" = NEW."granterId") +
    (SELECT COUNT(*) FROM "comment_award" WHERE "granterId" = NEW."granterId")
  INTO total_grants;

  IF total_grants > 0 AND total_grants % 10 = 0 THEN
    UPDATE "user"
    SET "unlockCoins" = "unlockCoins" + 5
    WHERE "id" = NEW."granterId";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_post_award_unlock_credit
  AFTER INSERT ON "post_award"
  FOR EACH ROW
  EXECUTE FUNCTION pigweed_credit_unlock_coins_on_grant();

CREATE TRIGGER trg_comment_award_unlock_credit
  AFTER INSERT ON "comment_award"
  FOR EACH ROW
  EXECUTE FUNCTION pigweed_credit_unlock_coins_on_grant();
