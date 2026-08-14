export declare const AGENT_OPS_SERVER_IDENTITY_SCHEMA = "\nALTER TABLE agent_ops_meta ADD COLUMN server_identity_fingerprint TEXT;\n\nUPDATE router_event_meta SET schema_version = 7 WHERE id = 1;\n";
