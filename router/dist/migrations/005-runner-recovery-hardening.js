export const RUNNER_RECOVERY_HARDENING_SCHEMA = `
CREATE UNIQUE INDEX IF NOT EXISTS one_task_binding_per_agent_thread
  ON task_bindings(assignee_agent_id, room_id, thread_root_event_id);

ALTER TABLE dispatches ADD COLUMN launch_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dispatches ADD COLUMN available_at INTEGER;
ALTER TABLE dispatches ADD COLUMN last_launch_error TEXT;

CREATE INDEX IF NOT EXISTS dispatch_queue_availability
  ON dispatches(state, available_at, created_at);

UPDATE router_event_meta SET schema_version = 5 WHERE id = 1;
`;
