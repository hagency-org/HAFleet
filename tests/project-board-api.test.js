import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createBackendTestContext } from './helpers/backend-test-runtime.js';

let context;

afterEach(() => {
  context?.cleanup();
  context = null;
});

describe('project board backend API', () => {
  it('returns a privacy-filtered project snapshot', async () => {
    const agentName = `board-agent-${Date.now()}`;
    context = await createBackendTestContext('hafleet-project-board-api-', {
      env: { AGENT_PROJECT_BOARD_REMOTE_SYNC: '0' },
      agents: {
        [agentName]: {
          name: agentName,
          type: 'codex',
          online: true,
          runtimeProfile: {
            primary: {
              framework: 'codex',
              model: 'review-model',
              apiKey: 'private-api-key',
            },
          },
          workspacePath: '/Users/private/workspace',
        },
      },
      groups: {
        demo: { name: 'demo', members: [agentName], createdAt: Date.now() },
      },
      messages: [
        { id: 'public-1', group: 'demo', from: agentName, summary: 'Public update', body: 'full body' },
        { id: 'private-1', from: agentName, to: 'owner', summary: 'Private update', body: 'approval secret' },
      ],
      rawDataFiles: {
        'workflow_bindings.json': JSON.stringify({
          demo: { bindingId: 'demo:workflow@1', group: 'demo', project: 'demo-project' },
        }),
      },
    });

    const response = await request(context.app).get('/api/project-board?activity_limit=5').expect(200);
    const serialized = JSON.stringify(response.body);

    /*
     * REQ-PROJECT-BOARD-ACTIVITY end to end. The unit test pins the filter against a
     * hand-built input; this pins it against the records the backend actually stored, which
     * is what the statement is about — the `group` on the backend's own record decides, not
     * anything the caller passed in. `private-1` targets an owner, carries no group, and does
     * not appear.
     */
    expect(response.body.projects).toHaveLength(1);
    expect(response.body.projects[0].activity).toEqual([
      expect.objectContaining({ id: 'public-1', summary: 'Public update' }),
    ]);
    expect(response.body.projects[0].binding).toEqual(expect.objectContaining({
      group: 'demo',
      project: 'demo-project',
    }));
    /*
     * REQ-PROJECT-BOARD-PRIVACY at the HTTP boundary, which is the boundary the statement
     * cares about — a projection that redacts correctly in a unit test but hands the raw
     * agent record to `res.json()` would satisfy the one and violate the other. The seeded
     * agent carries a runtime `apiKey` and a `workspacePath` precisely so the response can be
     * checked for them, and the direct message is here so its summary and body can be too.
     */
    expect(serialized).not.toContain('Private update');
    expect(serialized).not.toContain('full body');
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('private-api-key');
  });
});
