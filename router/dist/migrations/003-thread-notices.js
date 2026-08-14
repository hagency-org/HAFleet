export const THREAD_NOTICES_SCHEMA = `
CREATE TABLE IF NOT EXISTS notice_outbox (
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
  created_at INTEGER NOT NULL,
  CHECK (dispatch_id IS NOT NULL OR task_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS notice_outbox_state ON notice_outbox(state, created_at);

UPDATE router_event_meta SET schema_version = 3 WHERE id = 1;
`;
