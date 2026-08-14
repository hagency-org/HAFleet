export const AGENT_OPS_CLIENT_SCHEMA = `
ALTER TABLE tasks ADD COLUMN entity_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE dispatches ADD COLUMN entity_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE resources ADD COLUMN entity_version INTEGER NOT NULL DEFAULT 1;

CREATE TRIGGER IF NOT EXISTS tasks_entity_version_after_update
AFTER UPDATE ON tasks
WHEN NEW.entity_version = OLD.entity_version
BEGIN
  UPDATE tasks SET entity_version = OLD.entity_version + 1 WHERE task_id = OLD.task_id;
END;

CREATE TRIGGER IF NOT EXISTS dispatches_entity_version_after_update
AFTER UPDATE ON dispatches
WHEN NEW.entity_version = OLD.entity_version
BEGIN
  UPDATE dispatches SET entity_version = OLD.entity_version + 1 WHERE dispatch_id = OLD.dispatch_id;
END;

CREATE TRIGGER IF NOT EXISTS resources_entity_version_after_update
AFTER UPDATE ON resources
WHEN NEW.entity_version = OLD.entity_version
BEGIN
  UPDATE resources SET entity_version = OLD.entity_version + 1 WHERE resource_id = OLD.resource_id;
END;

CREATE TABLE IF NOT EXISTS agent_ops_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  contract_schema TEXT NOT NULL,
  stream_epoch TEXT NOT NULL,
  action_hmac_key BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_ops_scopes (
  scope_id TEXT PRIMARY KEY,
  owner_mxid TEXT NOT NULL,
  owner_dm_room_id TEXT NOT NULL,
  project_room_id TEXT NOT NULL,
  stable_agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  projection_id TEXT NOT NULL UNIQUE,
  matrix_device_id TEXT,
  matrix_device_ed25519 TEXT,
  matrix_device_curve25519 TEXT,
  auth_fence_generation INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_mxid, owner_dm_room_id, project_room_id, stable_agent_id)
);

CREATE TABLE IF NOT EXISTS agent_ops_grants (
  grant_jti TEXT PRIMARY KEY,
  matrix_event_id TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  scope_id TEXT NOT NULL REFERENCES agent_ops_scopes(scope_id) ON DELETE CASCADE,
  client_nonce TEXT NOT NULL,
  client_public_jwk_json TEXT NOT NULL,
  server_challenge TEXT NOT NULL,
  audience TEXT NOT NULL,
  auth_fence_generation INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS agent_ops_sessions (
  client_session_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES agent_ops_scopes(scope_id) ON DELETE CASCADE,
  capability_hash TEXT NOT NULL UNIQUE,
  client_public_jwk_json TEXT NOT NULL,
  audience TEXT NOT NULL,
  auth_fence_generation INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS agent_ops_request_nonces (
  client_session_id TEXT NOT NULL REFERENCES agent_ops_sessions(client_session_id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  consumed_at INTEGER NOT NULL,
  PRIMARY KEY(client_session_id, nonce)
);

CREATE TABLE IF NOT EXISTS agent_ops_action_uses (
  action_jti TEXT PRIMARY KEY,
  client_session_id TEXT NOT NULL REFERENCES agent_ops_sessions(client_session_id),
  request_id TEXT NOT NULL,
  consumed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_ops_idempotency (
  scope_id TEXT NOT NULL REFERENCES agent_ops_scopes(scope_id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(scope_id, request_id)
);

CREATE INDEX IF NOT EXISTS agent_ops_grants_scope ON agent_ops_grants(scope_id, expires_at);
CREATE INDEX IF NOT EXISTS agent_ops_sessions_scope ON agent_ops_sessions(scope_id, expires_at);
CREATE INDEX IF NOT EXISTS agent_ops_idempotency_created ON agent_ops_idempotency(created_at);

UPDATE router_event_meta SET schema_version = 6 WHERE id = 1;
`;

