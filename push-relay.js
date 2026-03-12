#!/usr/bin/env node

if (!process.env.PUSH_RELAY_MODE) {
  process.env.PUSH_RELAY_MODE = 'local';
}

const core = await import('./lib/push-relay-core.js');
if (typeof core.main === 'function') {
  core.main().catch((e) => {
    console.error(`[push-relay] startup error: ${e?.message || e}`);
    process.exit(1);
  });
}
