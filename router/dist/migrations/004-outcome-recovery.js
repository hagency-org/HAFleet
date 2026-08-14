export const OUTCOME_RECOVERY_SCHEMA = `
ALTER TABLE resources ADD COLUMN dirty_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE resources ADD COLUMN dirty_dispatch_id TEXT REFERENCES dispatches(dispatch_id);

UPDATE resources
SET dirty_generation = 1,
    dirty_dispatch_id = (
      SELECT d.dispatch_id FROM dispatches d
      WHERE d.workspace_resource_id = resources.resource_id
        AND d.state = 'outcome_unknown'
      ORDER BY d.settled_at DESC, d.created_at DESC
      LIMIT 1
    )
WHERE dirty = 1;

CREATE TABLE IF NOT EXISTS outcome_inspections (
  inspection_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL REFERENCES dispatches(dispatch_id),
  resource_id TEXT REFERENCES resources(resource_id),
  dirty_generation INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS outcome_inspections_dispatch
  ON outcome_inspections(dispatch_id, created_at);
CREATE INDEX IF NOT EXISTS dispatches_session_state_recovery
  ON dispatches(session_id, state, settled_at);

CREATE TABLE IF NOT EXISTS outcome_resolutions (
  dispatch_id TEXT PRIMARY KEY REFERENCES dispatches(dispatch_id),
  request_id TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  inspection_id TEXT NOT NULL UNIQUE REFERENCES outcome_inspections(inspection_id),
  action TEXT NOT NULL CHECK (action IN ('continue','accept_completed','keep_blocked')),
  operator_note TEXT NOT NULL,
  recovery_instruction TEXT,
  replacement_dispatch_id TEXT REFERENCES dispatches(dispatch_id),
  resolved_at INTEGER NOT NULL
);

UPDATE router_event_meta SET schema_version = 4 WHERE id = 1;
`;
