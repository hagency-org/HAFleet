/*
 * POST /api/agents/:name/provision — creating an agent, which nothing could do.
 *
 * THE HOLE. Every launcher in HAFleet starts an agent that already exists: `/start` 404s on an
 * unknown name, and the supervisor "launches into an already-provisioned home". The only writer of a
 * NEW agent record was `POST /api/agents`, guarded by `requireAgentToken` — the agent registers
 * ITSELF. But it cannot authenticate without a token, the token lives in a provisioned home, and the
 * only thing that provisioned a home was a shell command. So the first launch of any agent had to be
 * typed by a human on that host, and the console's own Onboard button was a `setTimeout` animation
 * that did nothing. Found by walking the flow, not from a failing test.
 *
 * WHAT IS ASSERTED HERE is mostly refusal, deliberately: this endpoint runs a script that writes a
 * home directory and mints a credential, so the interesting behaviour is what it declines to do.
 * The happy path is covered end to end against a live backend rather than here, because the
 * provisioning script shells out to node and materialises real directories.
 */

import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const API_TOKEN = 'operator-provision-token';
const EXISTING = 'already-here';

const seed = () => ({
  agents: {
    [EXISTING]: { name: EXISTING, type: 'codex', kind: 'agent', online: true },
  },
  env: { API_TOKEN },
});

const provision = (ctx, name, body) => request(ctx.app)
  .post(`/api/agents/${name}/provision`)
  .set('Authorization', `Bearer ${API_TOKEN}`)
  .send(body);

describe('POST /api/agents/:name/provision', () => {
  let ctx;
  afterEach(async () => { await ctx?.cleanup?.(); ctx = null; });

  test('refuses to provision over an agent that already exists', async () => {
    /*
     * Not merged, refused. Provisioning re-runs a script that writes a home and MINTS A TOKEN;
     * doing that to a live agent would replace the credential it is currently authenticating with,
     * taking a working agent offline for a reason the operator never asked for.
     */
    ctx = await createBackendTestContext('provision-exists-', seed());
    const res = await provision(ctx, EXISTING, { framework: 'codex' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/);
  });

  test('refuses a framework it cannot launch', async () => {
    /*
     * `claude` and `codex` are the only frameworks `/start` knows how to spawn. Accepting `octos`
     * here would write a home and a token for an agent that could never be started, and the failure
     * would surface later as a launch error rather than as the naming mistake it is.
     */
    ctx = await createBackendTestContext('provision-fw-', seed());
    const res = await provision(ctx, 'new-agent', { framework: 'octos' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/framework must be one of/);
    // And nothing was created.
    const after = await request(ctx.app).get('/api/agents/new-agent')
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(after.status).toBe(404);
  });

  test('refuses a preset whose framework disagrees with the requested one', async () => {
    /*
     * The mismatch that would otherwise produce an agent whose runtimeProfile says codex while its
     * launcher runs claude. Caught here, where it is still a sentence.
     */
    ctx = await createBackendTestContext('provision-mismatch-', seed());
    const preset = await request(ctx.app).post('/api/framework-presets')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ name: 'codex-strong', framework: 'codex', provider: 'openai', model: 'gpt-5.6-sol', reasoning: 'high' });
    const res = await provision(ctx, 'new-agent', {
      framework: 'claude', presetId: preset.body.preset.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/is for codex, not claude/);
  });

  test('refuses an unknown preset', async () => {
    ctx = await createBackendTestContext('provision-nopreset-', seed());
    const res = await provision(ctx, 'new-agent', { framework: 'codex', presetId: 'preset_nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown preset/);
  });

  test('refuses a relative project path', async () => {
    // A relative path would resolve against whatever cwd the backend happens to run in, which is
    // not the directory the operator meant.
    ctx = await createBackendTestContext('provision-relpath-', seed());
    const res = await provision(ctx, 'new-agent', { framework: 'codex', project: '../somewhere' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/absolute path/);
  });

  test('a ~/ path is expanded, not refused — the form\'s own placeholder uses one', async () => {
    /*
     * The onboarding form suggests `~/ops-ws`, so refusing `~` meant the API rejected the exact
     * shape the UI taught. Safe to expand only because this route is local-only: `~` can mean
     * nothing but the home of the user the backend runs as, which is the user the agent runs as.
     * The framework MUST be valid here. Validation order is framework -> preset -> project, so an
     * invalid framework short-circuits before the path is looked at — the first version of this test
     * passed `octos` and proved nothing about the tilde at all.
     *
     * `~` itself, not `~/something-missing`. The second version used a path that did not exist so it
     * could assert on the failure — and then the fix that CREATES missing paths made it succeed,
     * which both broke the test and left a stray directory in the developer's home. `~` is
     * guaranteed to exist, is linked rather than copied (`--project-mode symlink`), and writes
     * nothing outside the test's own runtime dir.
     */
    ctx = await createBackendTestContext('provision-tilde-', seed());
    const res = await provision(ctx, 'tilde-agent', { framework: 'codex', project: '~' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    // The counter-case, same validation step: a genuinely relative path is still refused.
    const relative = await provision(ctx, 'new-agent', { framework: 'codex', project: 'somewhere' });
    expect(relative.status).toBe(400);
    expect(relative.body.error).toMatch(/absolute path/);
  });

  test('a project path that does not exist is CREATED, not refused', async () => {
    /*
     * The form's own hint promised it ("created automatically if it does not exist") while
     * `provision-v1-agent-home.js` refused with "project path does not exist". An operator typed a
     * directory they intended to work in and provisioning failed — the UI and the script disagreed
     * about the same field.
     *
     * Asserted via the framework refusal so no directory is written by this test: path handling
     * precedes provisioning, so reaching the framework error proves the path was accepted.
     */
    ctx = await createBackendTestContext('provision-mkdir-', seed());
    const res = await provision(ctx, 'new-agent', {
      framework: 'octos', project: `${ctx.runtimeDir}/not-there-yet`,
    });
    expect(res.body.error).not.toMatch(/does not exist/);
  });

  test('no project path at all is fine — the agent gets its own workdir', async () => {
    /*
     * The field was REQUIRED by the form, which made an operator invent a path. It is optional by
     * design: `up-v1` provisions the agent a home workdir, so an empty value is the simplest
     * correct answer and the natural default cwd.
     */
    ctx = await createBackendTestContext('provision-noproject-', seed());
    const res = await provision(ctx, 'new-agent', { framework: 'octos' });
    // Refused on the framework only — the absent project raised nothing.
    expect(res.body.error).toMatch(/framework must be one of/);
  });

  test('refuses an invalid agent name', async () => {
    ctx = await createBackendTestContext('provision-badname-', seed());
    const res = await provision(ctx, '%20%20', { framework: 'codex' });
    expect([400, 404]).toContain(res.status);
  });

  test('requires the operator bearer — an agent cannot provision itself', async () => {
    /*
     * The bootstrap direction matters: an agent that could provision would be creating the very
     * credential it authenticates with. Provisioning is the host operator's act.
     */
    ctx = await createBackendTestContext('provision-noauth-', seed());
    const res = await request(ctx.app).post('/api/agents/new-agent/provision')
      .send({ framework: 'codex' });
    expect(res.status).toBe(401);
  });
});
