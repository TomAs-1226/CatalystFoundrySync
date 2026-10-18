-- Shared across all users of the private OAuth app. No automatic reset: an
-- administrator must verify the actual Onshape allocation before raising it.
CREATE TABLE IF NOT EXISTS onshape_budget (
 id TEXT PRIMARY KEY,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0)
);
