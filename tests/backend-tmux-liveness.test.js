import { afterEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

function readAgents(runtimeDir) {
  return JSON.parse(readFileSync(path.join(runtimeDir, 'data', 'agents.json'), 'utf-8'));
}

function seed() {
  return {
    agents: {
      alpha: {
        name: 'alpha',
        type: 'agent',
        kind: 'agent',
        online: true,
        server: null,
        tmux: 'alpha:0.0',
        manualDown: false,
        offlineReason: null,
        lastSeen: Date.now(),
      },
    },
    env: { AGENT_TMUX_MISSING_ALERT_GRACE_MS: '60000' },
  };
}

describe('backend local tmux liveness', () => {
  let context = null;

  afterEach(() => {
    context?.cleanup();
    context = null;
    vi.restoreAllMocks();
  });

  test('marks a failed tmux pane query as unknown and preserves agent state', async () => {
    context = await createBackendTestContext('backend-tmux-liveness-test-', seed());
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('tmux query timed out'), {
      code: 'ETIMEDOUT',
    }));

    const snapshot = await context.internals.buildLocalPaneMetadataSnapshotForTest(run);
    expect(snapshot.ok).toBe(false);
    expect(snapshot.error).toEqual(expect.objectContaining({
      code: 'ETIMEDOUT',
      message: 'tmux query timed out',
    }));

    await context.internals.sweepLocalActivityDurationsForTest(snapshot);

    expect(readAgents(context.runtimeDir).alpha).toEqual(expect.objectContaining({
      online: true,
      tmux: 'alpha:0.0',
      offlineReason: null,
    }));
  });

  test.each([
    'error connecting to /tmp/tmux-501/default (No such file or directory)',
    'no server running on /tmp/tmux-1000/default',
  ])('treats a missing tmux server as an empty snapshot and eventually marks agents offline: %s', async (stderr) => {
    context = await createBackendTestContext('backend-tmux-liveness-test-', seed());
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('tmux exited with status 1'), {
      code: 1,
      stderr,
    }));

    const snapshot = await context.internals.buildLocalPaneMetadataSnapshotForTest(run);
    expect(snapshot).toEqual(expect.objectContaining({
      ok: true,
      sessions: expect.any(Map),
      ttyToSession: expect.any(Map),
      error: null,
    }));

    await context.internals.sweepLocalActivityDurationsForTest(snapshot);
    await context.internals.sweepLocalActivityDurationsForTest(snapshot);
    expect(readAgents(context.runtimeDir).alpha.online).toBe(true);

    await context.internals.sweepLocalActivityDurationsForTest(snapshot);
    expect(readAgents(context.runtimeDir).alpha).toEqual(expect.objectContaining({
      online: false,
      tmux: null,
      offlineReason: 'tmux-missing:auto',
    }));
  });

  test('requires three consecutive missing-session observations before taking an agent offline', async () => {
    context = await createBackendTestContext('backend-tmux-liveness-test-', seed());
    const missingSnapshot = await context.internals.buildLocalPaneMetadataSnapshotForTest(
      vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    );
    const presentSnapshot = await context.internals.buildLocalPaneMetadataSnapshotForTest(
      vi.fn().mockResolvedValue({
        stdout: '/dev/ttys001\talpha\t123\tnode\t/tmp/project\n',
        stderr: '',
      }),
    );
    expect(missingSnapshot.ok).toBe(true);
    expect(presentSnapshot.ok).toBe(true);

    await context.internals.sweepLocalActivityDurationsForTest(missingSnapshot);
    await context.internals.sweepLocalActivityDurationsForTest(missingSnapshot);
    await context.internals.sweepLocalActivityDurationsForTest(presentSnapshot);
    await context.internals.sweepLocalActivityDurationsForTest(missingSnapshot);
    await context.internals.sweepLocalActivityDurationsForTest(missingSnapshot);

    expect(readAgents(context.runtimeDir).alpha).toEqual(expect.objectContaining({
      online: true,
      tmux: 'alpha:0.0',
      offlineReason: null,
    }));

    await context.internals.sweepLocalActivityDurationsForTest(missingSnapshot);

    expect(readAgents(context.runtimeDir).alpha).toEqual(expect.objectContaining({
      online: false,
      tmux: null,
      offlineReason: 'tmux-missing:auto',
    }));
  });

  test('does not allow configuration to lower the missing-session safety floor below three', async () => {
    const configuredSeed = seed();
    configuredSeed.env.AGENT_TMUX_MISSING_THRESHOLD = '1';
    context = await createBackendTestContext('backend-tmux-liveness-test-', configuredSeed);
    const missingSnapshot = await context.internals.buildLocalPaneMetadataSnapshotForTest(
      vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    );

    await context.internals.sweepLocalActivityDurationsForTest(missingSnapshot);
    await context.internals.sweepLocalActivityDurationsForTest(missingSnapshot);

    expect(readAgents(context.runtimeDir).alpha).toEqual(expect.objectContaining({
      online: true,
      tmux: 'alpha:0.0',
      offlineReason: null,
    }));

    await context.internals.sweepLocalActivityDurationsForTest(missingSnapshot);
    expect(readAgents(context.runtimeDir).alpha.online).toBe(false);
  });
});
