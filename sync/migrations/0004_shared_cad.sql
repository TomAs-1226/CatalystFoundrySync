CREATE TABLE IF NOT EXISTS cad_snapshots (
 id TEXT PRIMARY KEY,
 team_id TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 metadata_json TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 compressed_bytes INTEGER NOT NULL,
 raw_bytes INTEGER NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cad_snapshots_team ON cad_snapshots(team_id,created_at DESC);
CREATE TABLE IF NOT EXISTS cad_snapshot_chunks (
 snapshot_id TEXT NOT NULL REFERENCES cad_snapshots(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL,
 payload TEXT NOT NULL,
 PRIMARY KEY(snapshot_id,sequence)
);
