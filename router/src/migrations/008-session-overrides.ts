export const SESSION_OVERRIDES_SCHEMA = `
ALTER TABLE sessions ADD COLUMN model_override TEXT
  CHECK (model_override IS NULL OR length(model_override) BETWEEN 1 AND 64);
ALTER TABLE sessions ADD COLUMN mode_override TEXT
  CHECK (mode_override IS NULL OR mode_override IN ('plan', 'auto'));

-- Session-configuration notices (e.g. /thread directive confirmations) have
-- no dispatch or task anchor, so the original both-null CHECK must go. SQLite
-- cannot drop a CHECK in place; rebuild the table.
CREATE TABLE notice_outbox_v8 (
  command_id TEXT PRIMARY KEY,
  dispatch_id TEXT REFERENCES dispatches(dispatch_id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(task_id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL UNIQUE,
  txn_id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL,
  thread_root_event_id TEXT,
  body TEXT NOT NULL,
  sender_agent_name TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','claimed','delivered','failed')),
  claim_token_hash TEXT,
  claimed_until INTEGER,
  delivered_event_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
INSERT INTO notice_outbox_v8 SELECT * FROM notice_outbox;
DROP TABLE notice_outbox;
ALTER TABLE notice_outbox_v8 RENAME TO notice_outbox;
CREATE INDEX IF NOT EXISTS notice_outbox_state ON notice_outbox(state, created_at);

UPDATE router_event_meta SET schema_version = 8 WHERE id = 1;
`;
