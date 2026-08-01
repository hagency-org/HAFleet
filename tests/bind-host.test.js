import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';

import { resolveBindHost } from '../lib/startup-config.js';

describe('resolveBindHost', () => {
  test.each([undefined, null, '', '   '])('defaults to loopback for %j', (value) => {
    expect(resolveBindHost(value)).toEqual({ host: '127.0.0.1', warning: null });
  });

  test.each(['127.0.0.1', 'localhost', '::1'])('accepts loopback %s without warning', (value) => {
    expect(resolveBindHost(value)).toEqual({ host: value, warning: null });
  });

  test.each(['0.0.0.0', 'backend', '10.1.2.3'])('accepts %s but warns', (value) => {
    const result = resolveBindHost(value);
    expect(result.host).toBe(value);
    expect(result.warning).toMatch(/loopback trust check/);
  });

  // A typo must never widen the bind. Falling back to loopback fails closed.
  test.each(['http://0.0.0.0', '0.0.0.0 1.2.3.4', '0.0.0.0,::', 'host name'])(
    'falls back to loopback for malformed %j',
    (value) => {
      const result = resolveBindHost(value);
      expect(result.host).toBe('127.0.0.1');
      expect(result.warning).toMatch(/malformed/);
    },
  );

  test('honours an explicit non-loopback default', () => {
    expect(resolveBindHost('', { defaultHost: '0.0.0.0' }).host).toBe('0.0.0.0');
  });
});

describe('service bind wiring', () => {
  test('backend reads HAFLEET_BACKEND_HOST through resolveBindHost', () => {
    const src = readFileSync('backend-v2.js', 'utf-8');
    expect(src).toContain('resolveBindHost(process.env.HAFLEET_BACKEND_HOST)');
    // The hardcoded literal default must be gone, but loopback must remain the
    // effective default via resolveBindHost.
    expect(src).not.toContain("host = '127.0.0.1' } = {}");
  });

  test('dashboard reads HAFLEET_WEB_HOST through resolveBindHost', () => {
    const src = readFileSync('server.js', 'utf-8');
    expect(src).toContain('resolveBindHost(process.env.HAFLEET_WEB_HOST)');
    expect(src).not.toContain("host = '127.0.0.1' } = {}");
  });

  test('a wide bind is never silent', () => {
    for (const file of ['backend-v2.js', 'server.js']) {
      expect(readFileSync(file, 'utf-8'), file).toContain('console.warn(`[bind] ${warning}`)');
    }
  });
});
