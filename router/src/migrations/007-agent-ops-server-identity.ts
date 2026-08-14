export const AGENT_OPS_SERVER_IDENTITY_SCHEMA = `
ALTER TABLE agent_ops_meta ADD COLUMN server_identity_fingerprint TEXT;

UPDATE router_event_meta SET schema_version = 7 WHERE id = 1;
`;
