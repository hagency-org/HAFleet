import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

describe('supervisor provisioning', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'supervisor-provision-test-'));
    process.env.HAFLEET_HOMEDIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.HAFLEET_HOMEDIR;
  });

  test('provisions supervisor agent home with directories, token, AGENTS.md, and manifest', async () => {
    const { provisionSupervisorAgent } = await import('../lib/supervisor-provisioning.js');
    const result = provisionSupervisorAgent('ac-topleader', {
      targetTmux: 'ac-topleader',
      targetWorkdir: '/home/test/.hafleet/agents/agent_ac-topleader/workdir',
    });

    expect(result.supervisorName).toBe('supervisor-ac-topleader');
    expect(result.tokenGenerated).toBe(true);
    expect(result.agentsWritten).toBe(true);

    // Verify directory structure
    expect(existsSync(result.paths.homeDir)).toBe(true);
    expect(existsSync(result.paths.stateDir)).toBe(true);
    expect(existsSync(result.paths.workdir)).toBe(true);
    expect(existsSync(result.paths.docsDir)).toBe(true);

    // Verify agent-token
    const tokenPath = path.join(result.paths.stateDir, 'agent-token');
    expect(existsSync(tokenPath)).toBe(true);
    const token = readFileSync(tokenPath, 'utf-8').trim();
    expect(token).toHaveLength(64); // 32 bytes hex

    // Verify AGENTS.md with template variables substituted
    const agentsPath = path.join(result.paths.workdir, 'AGENTS.md');
    expect(existsSync(agentsPath)).toBe(true);
    const agentsContent = readFileSync(agentsPath, 'utf-8');
    expect(agentsContent).toContain('supervisor-ac-topleader');
    expect(agentsContent).toContain('ac-topleader');
    expect(agentsContent).not.toContain('{{SUPERVISOR_NAME}}');
    expect(agentsContent).not.toContain('{{TARGET_AGENT}}');

    // Verify agent.json manifest
    const manifest = JSON.parse(readFileSync(result.paths.agentJsonPath, 'utf-8'));
    expect(manifest.name).toBe('supervisor-ac-topleader');
    expect(manifest.supervisorFor).toBe('ac-topleader');
    expect(manifest.workdir).toBe(result.paths.workdir);
    expect(manifest.stateDir).toBe(result.paths.stateDir);

    // Verify supervisor-writer script
    const writerPath = path.join(result.paths.workdir, 'supervisor-writer');
    expect(existsSync(writerPath)).toBe(true);
  });

  test('is idempotent — does not overwrite existing token or AGENTS.md', async () => {
    const { provisionSupervisorAgent } = await import('../lib/supervisor-provisioning.js');
    const first = provisionSupervisorAgent('ac-topleader');
    const firstToken = readFileSync(path.join(first.paths.stateDir, 'agent-token'), 'utf-8');

    const second = provisionSupervisorAgent('ac-topleader');
    expect(second.tokenGenerated).toBe(false);
    expect(second.agentsWritten).toBe(false);
    const secondToken = readFileSync(path.join(second.paths.stateDir, 'agent-token'), 'utf-8');
    expect(secondToken).toBe(firstToken);
  });

  test('re-provision preserves existing manifest fields', async () => {
    const { provisionSupervisorAgent } = await import('../lib/supervisor-provisioning.js');
    const first = provisionSupervisorAgent('ac-topleader');

    // Simulate runtime adding fields to manifest
    const manifestPath = first.paths.agentJsonPath;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.runtimeProfile = { primary: { framework: 'claude', model: 'opus' } };
    manifest.task = { id: 'task-123', title: 'Test task' };
    const { writeFileSync: writeFs } = await import('fs');
    writeFs(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

    // Re-provision
    provisionSupervisorAgent('ac-topleader');
    const updated = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    // Provisioning-owned fields updated
    expect(updated.supervisorFor).toBe('ac-topleader');
    expect(updated.name).toBe('supervisor-ac-topleader');
    // Existing fields preserved
    expect(updated.runtimeProfile).toEqual({ primary: { framework: 'claude', model: 'opus' } });
    expect(updated.task).toEqual({ id: 'task-123', title: 'Test task' });
    // createdAt preserved from original
    expect(updated.createdAt).toBe(manifest.createdAt);
  });

  test('readSupervisorToken returns generated token', async () => {
    const { provisionSupervisorAgent, readSupervisorToken } = await import('../lib/supervisor-provisioning.js');
    provisionSupervisorAgent('ac-topleader');
    const token = readSupervisorToken('supervisor-ac-topleader');
    expect(token).toHaveLength(64);
  });

  test('buildSupervisorAgentRecord returns valid registry entry', async () => {
    const { provisionSupervisorAgent, buildSupervisorAgentRecord } = await import('../lib/supervisor-provisioning.js');
    provisionSupervisorAgent('ac-topleader');
    const record = buildSupervisorAgentRecord('supervisor-ac-topleader', 'ac-topleader');
    expect(record.name).toBe('supervisor-ac-topleader');
    expect(record.kind).toBe('agent');
    expect(record.role).toContain('ac-topleader');
    expect(record.homeDir).toBeTruthy();
    expect(record.workdir).toBeTruthy();
    expect(record.supervisorFor).toBe('ac-topleader');
  });
});
