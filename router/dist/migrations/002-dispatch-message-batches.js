export const DISPATCH_MESSAGE_BATCHES_SCHEMA = `
CREATE TABLE IF NOT EXISTS dispatch_messages (
  dispatch_id TEXT NOT NULL REFERENCES dispatches(dispatch_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES router_messages(message_id) ON DELETE CASCADE,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY(dispatch_id, message_id),
  UNIQUE(session_id, message_id)
);
CREATE INDEX IF NOT EXISTS dispatch_messages_session
  ON dispatch_messages(session_id, assigned_at, message_id);

UPDATE router_event_meta SET schema_version = 2 WHERE id = 1;
`;
