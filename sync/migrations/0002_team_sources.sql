CREATE TABLE IF NOT EXISTS team_sources(
 id TEXT PRIMARY KEY,
 team_id TEXT NOT NULL,
 label TEXT NOT NULL,
 source_url TEXT NOT NULL,
 work_order TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_sources_team ON team_sources(team_id,updated_at DESC);
