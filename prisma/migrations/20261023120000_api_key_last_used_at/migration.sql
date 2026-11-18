-- #500: record when an API key was last used to authenticate.
--
-- Nullable with no default on purpose: NULL means "has not authenticated since
-- this column existed", which is exactly what makes an abandoned key visible.
-- Backfilling it with now() would mark every key as freshly used and destroy
-- the signal on the day it shipped.
ALTER TABLE "api_keys" ADD COLUMN "last_used_at" TIMESTAMP(3);
