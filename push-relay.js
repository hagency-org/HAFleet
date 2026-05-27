#!/usr/bin/env node

import { enforceStartupConfig } from './lib/startup-config.js';

const requestedMode = (process.env.PUSH_RELAY_MODE || '').trim().toLowerCase();
if (!requestedMode) {
  process.env.PUSH_RELAY_MODE = 'local';
} else if (requestedMode !== 'local') {
  console.error(`[push-relay] FATAL: local entrypoint requires PUSH_RELAY_MODE=local, got ${process.env.PUSH_RELAY_MODE}`);
  process.exit(1);
}

enforceStartupConfig({
  serviceName: 'Agent Chat push relay',
});

const core = await import('./lib/push-relay-core.js');
if (typeof core.main === 'function') {
  if (typeof core.installPushRelayProcessHandlers === 'function') {
    core.installPushRelayProcessHandlers();
  }
  core.main().catch((e) => {
    console.error(`[push-relay] startup error: ${e?.message || e}`);
    process.exit(1);
  });
}
