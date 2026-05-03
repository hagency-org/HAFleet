import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const CHECKER = path.join(REPO_ROOT, 'scripts', 'check-architecture-boundaries.js');

async function withFixture({ source, manifest }, fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-chat-arch-boundary-'));
  try {
    await writeFile(path.join(root, 'fixture.js'), source);
    const manifestPath = path.join(root, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    return await fn({ root, manifestPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runChecker(fixture) {
  return withFixture(fixture, async ({ root, manifestPath }) => {
    try {
      const result = await execFileAsync(process.execPath, [CHECKER], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          AGENTCHAT_ARCH_BOUNDARY_ROOT: root,
          AGENTCHAT_ARCH_BOUNDARY_MANIFEST: manifestPath,
        },
      });
      return { ok: true, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return { ok: false, stdout: error.stdout || '', stderr: error.stderr || '', code: error.code };
    }
  });
}

function manifestFor(routeOwnership) {
  return {
    importBoundaries: [],
    routeOwnership: {
      'fixture.js': routeOwnership,
    },
  };
}

describe('architecture boundary checker stateful GET routes', () => {
  test('fails when a stateful GET route has no owner entry', async () => {
    const result = await runChecker({
      source: `
        const app = {};
        app.get('/api/read', (req, res) => {
          saveThing();
          res.json({ ok: true });
        });
        function saveThing() {}
      `,
      manifest: manifestFor({
        mutationRoutes: [],
        sensitiveRoutes: [],
        statefulGetMarkers: ['saveThing('],
        statefulGetRoutes: [],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('stateful GET route lacks owner entry: GET /api/read');
  });

  test('passes listed stateful GET routes and validates their auth policy', async () => {
    const result = await runChecker({
      source: `
        const app = {};
        app.use('/api', createApiAuthMiddleware({}));
        app.get('/api/read', (req, res) => {
          saveThing();
          res.json({ ok: true });
        });
      `,
      manifest: manifestFor({
        mutationRoutes: [],
        sensitiveRoutes: [],
        statefulGetMarkers: ['saveThing('],
        statefulGetRoutes: [
          { method: 'GET', path: '/api/read', owner: 'fixture.read', auth: 'global-api-auth-only' },
        ],
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('1 stateful GET route(s) checked');
  });

  test('does not leak marker matches from following helpers into a route body', async () => {
    const result = await runChecker({
      source: `
        const app = {};
        app.get('/api/plain', (req, res) => {
          res.json({ ok: true });
        });
        function helper() {
          saveThing();
        }
      `,
      manifest: manifestFor({
        mutationRoutes: [],
        sensitiveRoutes: [],
        statefulGetMarkers: ['saveThing('],
        statefulGetRoutes: [],
      }),
    });

    expect(result.ok).toBe(true);
  });

  test('catches helper-mediated subconscious read-through state creation', async () => {
    const result = await runChecker({
      source: `
        const app = {};
        app.get('/api/subconscious/detail/:name', (req, res) => {
          const state = resolveSubconsciousState(req.params.name);
          res.json(state);
        });
      `,
      manifest: manifestFor({
        mutationRoutes: [],
        sensitiveRoutes: [],
        statefulGetMarkers: ['resolveSubconsciousState('],
        statefulGetRoutes: [],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('stateful GET route lacks owner entry: GET /api/subconscious/detail/:name');
  });

  test('recognizes explicit installRoute registrations for expected sensitive routes', async () => {
    const result = await runChecker({
      source: `
        const app = {};
        app.use('/api', createApiAuthMiddleware({}));
        sseAdapter.installRoute(app, '/api/stream');
      `,
      manifest: manifestFor({
        mutationRoutes: [],
        statefulGetMarkers: [],
        statefulGetRoutes: [],
        sensitiveRoutes: [
          { method: 'GET', path: '/api/stream', owner: 'fixture.stream', auth: 'global-api-auth-only' },
        ],
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('1 sensitive route(s)');
  });
});
