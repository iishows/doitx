-- A shell command that could destroy data still asks for a person, even when the
-- space is set to stop asking. On by default; the owner may turn it off.
ALTER TABLE "action_auto_review_preferences"
  ADD COLUMN IF NOT EXISTS "guardDangerousCommands" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "user_action_auto_review_preferences"
  ADD COLUMN IF NOT EXISTS "guardDangerousCommands" BOOLEAN NOT NULL DEFAULT true;
