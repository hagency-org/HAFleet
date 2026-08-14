export const INITIAL_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS router_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  room_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('main', 'thread')),
  thread_root_event_id TEXT,
  context_generation INTEGER NOT NULL DEFAULT 1,
  rolling_summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_active INTEGER NOT NULL,
  CHECK ((scope_kind = 'main' AND thread_root_event_id IS NULL) OR
         (scope_kind = 'thread' AND thread_root_event_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_main_session
  ON sessions(agent_id, room_id) WHERE scope_kind = 'main';
CREATE UNIQUE INDEX IF NOT EXISTS one_thread_session
  ON sessions(agent_id, room_id, thread_root_event_id)
  WHERE scope_kind = 'thread';

CREATE TABLE IF NOT EXISTS router_messages (
  message_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  matrix_event_id TEXT,
  thread_root_event_id TEXT,
  sender_mxid TEXT,
  sender_name TEXT,
  normalized_body TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  explicit_task INTEGER NOT NULL DEFAULT 0,
  UNIQUE(room_id, matrix_event_id)
);

CREATE TABLE IF NOT EXISTS session_messages (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES router_messages(message_id) ON DELETE CASCADE,
  projected_at INTEGER NOT NULL,
  processed_at INTEGER,
  PRIMARY KEY(session_id, message_id)
);

CREATE TABLE IF NOT EXISTS ingestion_cursors (
  source TEXT PRIMARY KEY,
  cursor_value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_store_migrations (
  migration_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('importing','verified','complete')),
  source_count INTEGER NOT NULL,
  source_digest TEXT NOT NULL,
  imported_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  verified_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created','accepted','in_progress','blocked','done')),
  priority TEXT NOT NULL CHECK (priority IN ('p0','p1','p2','p3')),
  granularity TEXT NOT NULL CHECK (granularity IN ('epic','task','subtask')),
  assignee_agent_id TEXT,
  assignee_name TEXT,
  created_by TEXT,
  parent_id TEXT REFERENCES tasks(task_id),
  labels_json TEXT NOT NULL,
  comments_json TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  heartbeat_at TEXT,
  waiting_reason TEXT,
  waiting_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_bindings (
  task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE CASCADE,
  creator_agent_id TEXT,
  assignee_agent_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  thread_root_event_id TEXT NOT NULL,
  thread_anchor_event_id TEXT,
  activation_state TEXT NOT NULL CHECK (activation_state IN ('pending_thread','active','thread_delivery_failed','closed')),
  request_scope TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  UNIQUE (request_scope, request_key)
);

CREATE TABLE IF NOT EXISTS task_inputs (
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES router_messages(message_id),
  role TEXT NOT NULL CHECK (role IN ('root', 'supplement')),
  attached_at INTEGER NOT NULL,
  activated_at INTEGER,
  PRIMARY KEY (task_id, message_id)
);

CREATE TABLE IF NOT EXISTS task_input_requests (
  request_scope TEXT NOT NULL,
  request_key TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  request_digest TEXT NOT NULL,
  attached_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (request_scope, request_key)
);

CREATE TABLE IF NOT EXISTS matrix_outbox (
  command_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  txn_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','claimed','delivered','failed')),
  claim_token_hash TEXT,
  claimed_until INTEGER,
  delivered_event_id TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS dispatches (
  dispatch_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  task_id TEXT REFERENCES tasks(task_id),
  state TEXT NOT NULL CHECK (state IN ('queued','leased','started','parked','completed','cancelled_before_start','outcome_unknown')),
  framework TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  may_write INTEGER NOT NULL,
  workspace_mode TEXT NOT NULL CHECK (workspace_mode IN ('shared','worktree')),
  workspace_resource_id TEXT,
  named_resources_json TEXT NOT NULL,
  fence_generation INTEGER NOT NULL DEFAULT 0,
  runner_id TEXT,
  lease_until INTEGER,
  effect_ack_at INTEGER,
  started_at INTEGER,
  parked_at INTEGER,
  settled_at INTEGER,
  terminal_reason TEXT,
  output_json TEXT,
  fenced_output_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dispatch_queue_order ON dispatches(state, created_at);

CREATE TABLE IF NOT EXISTS reply_outbox (
  command_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL UNIQUE REFERENCES dispatches(dispatch_id),
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
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS runner_capabilities (
  capability_hash TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL REFERENCES dispatches(dispatch_id) ON DELETE CASCADE,
  runner_id TEXT NOT NULL,
  fence_generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS resources (
  resource_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  safe_label TEXT NOT NULL,
  backend_path TEXT,
  branch_name TEXT,
  dirty INTEGER NOT NULL DEFAULT 0,
  dirty_reason TEXT,
  inspected_at INTEGER
);

CREATE TABLE IF NOT EXISTS resource_leases (
  resource_id TEXT PRIMARY KEY REFERENCES resources(resource_id) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL REFERENCES dispatches(dispatch_id) ON DELETE CASCADE,
  acquired_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_waits (
  approval_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL REFERENCES dispatches(dispatch_id) ON DELETE CASCADE,
  operation_digest TEXT NOT NULL,
  upstream_thread_id TEXT,
  upstream_turn_id TEXT,
  upstream_item_id TEXT,
  upstream_request_id TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  decision TEXT,
  UNIQUE(dispatch_id, operation_digest)
);

CREATE TABLE IF NOT EXISTS approval_inbox (
  decision_event_id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL REFERENCES dispatches(dispatch_id),
  decision TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  payload_digest TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS router_event_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  low_watermark INTEGER NOT NULL,
  high_watermark INTEGER NOT NULL
);
INSERT OR IGNORE INTO router_event_meta(id, schema_version, low_watermark, high_watermark)
VALUES (1, 1, 0, 0);

CREATE TABLE IF NOT EXISTS router_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  audience_scope TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
`;
