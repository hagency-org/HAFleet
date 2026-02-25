#!/usr/bin/env node

if (!process.env.PUSH_RELAY_MODE) {
  process.env.PUSH_RELAY_MODE = 'local';
}

await import('./lib/push-relay-core.js');
