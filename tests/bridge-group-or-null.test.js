import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/*
 * groupOrNull: a 404 from the backend is an ANSWER ("no such group"), not a failure.
 *
 * backendApi throws on every non-2xx. Three callers were written for an older `{ error }` contract
 * and tested `existing.error`, so an unknown group name — every customer project room — threw out
 * of onRoomEvent, the router answered 500, and the sync collector retried the batch until it
 * circuit-broke. Seen live on the first bot-less sync deployment.
 *
 * The bridge module is imported AFTER pointing HAFLEET_RUNTIME_DIR at a throwaway: its evaluation
 * mkdirs and may migrate state under that root (see tests/esm-linkage.test.js).
 */
let groupOrNull;
let runtime;
let savedRuntimeDir;
beforeAll(async () => {
  savedRuntimeDir = process.env.HAFLEET_RUNTIME_DIR;
  runtime = mkdtempSync(path.join(tmpdir(), 'hafleet-group-or-null-'));
  process.env.HAFLEET_RUNTIME_DIR = runtime;
  ({ groupOrNull } = await import('../bridge-matrix.js'));
});
afterAll(() => {
  rmSync(runtime, { recursive: true, force: true });
  if (savedRuntimeDir === undefined) delete process.env.HAFLEET_RUNTIME_DIR;
  else process.env.HAFLEET_RUNTIME_DIR = savedRuntimeDir;
});
afterEach(() => vi.unstubAllGlobals());

const reply = (status, body) => vi.fn().mockResolvedValue({
  ok: status < 300, status, text: async () => JSON.stringify(body),
});

describe('groupOrNull', () => {
  test('404 resolves to null', async () => {
    vi.stubGlobal('fetch', reply(404, { error: 'group not found' }));
    await expect(groupOrNull('e2e project room')).resolves.toBeNull();
  });

  test('a real backend failure still throws, with the status attached', async () => {
    vi.stubGlobal('fetch', reply(503, { error: 'busy' }));
    await expect(groupOrNull('x')).rejects.toMatchObject({ status: 503 });
  });

  test('an existing group comes back as its record', async () => {
    vi.stubGlobal('fetch', reply(200, { name: 'x', members: ['a'] }));
    await expect(groupOrNull('x')).resolves.toMatchObject({ name: 'x' });
  });
});
