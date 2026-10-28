-- The app no longer ships the vendor model catalogue (OpenRouter, Anthropic, OpenAI,
-- Google, DeepSeek, xAI, Bedrock, Copilot, ...). A deployment runs on exactly two
-- providers now: `local` for the operator's own OpenAI-compatible endpoint, and
-- `openai-compatible` for connections a user adds. Everything below drops the rows
-- and references that pointed at a provider which can no longer run.

-- Subscription sign-in is gone with the catalogue, so no session can be resumed.
DELETE FROM "model_oauth_sessions";

-- Connections to a removed provider have no model to run: drop the connection.
-- SpaceModelPreference and SpaceModelRoleChoice cascade from this row.
DELETE FROM "user_model_credentials"
WHERE "provider" NOT IN ('local', 'openai-compatible');

-- Role choices name a provider directly, so clear the ones left pointing at a
-- removed provider rather than leaving a role that resolves to nothing.
DELETE FROM "space_model_role_choices"
WHERE "provider" NOT IN ('local', 'openai-compatible');

-- These columns record which provider a bot, run, routine or steering message used.
-- Keep the row and its history: only the provider reference is meaningless now.
UPDATE "bots" SET "modelProvider" = NULL
WHERE "modelProvider" IS NOT NULL AND "modelProvider" NOT IN ('local', 'openai-compatible');
UPDATE "runs" SET "modelProvider" = NULL
WHERE "modelProvider" IS NOT NULL AND "modelProvider" NOT IN ('local', 'openai-compatible');
UPDATE "routines" SET "modelProvider" = NULL
WHERE "modelProvider" IS NOT NULL AND "modelProvider" NOT IN ('local', 'openai-compatible');
UPDATE "steering_messages" SET "modelProvider" = NULL
WHERE "modelProvider" IS NOT NULL AND "modelProvider" NOT IN ('local', 'openai-compatible');

-- The deployment default falls back to the managed endpoint when it named a
-- removed provider, so existing installations keep running without a rewrite.
UPDATE "deployment_settings" SET "defaultModelProvider" = NULL
WHERE "defaultModelProvider" IS NOT NULL AND "defaultModelProvider" NOT IN ('local', 'openai-compatible');
