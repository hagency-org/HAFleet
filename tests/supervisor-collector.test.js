import { afterEach, describe, expect, test, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { collectAgentContext, setCollectorTestHooks } from '../supervisor/collector.js';

describe('supervisor collector async pane capture', () => {
  let tempDir = null;

  afterEach(() => {
    setCollectorTestHooks();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  test('collectAgentContext awaits async tmux capture for local agents', async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'agent-chat-collector-test-'));
    const workspace = path.join(tempDir, 'workspace');
    const docsDir = path.join(workspace, 'docs', 'alpha');
    const metaRoot = path.join(tempDir, 'meta');
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(path.join(metaRoot, 'alpha'), { recursive: true });
    writeFileSync(path.join(metaRoot, 'alpha', 'meta.json'), JSON.stringify({ path: workspace }));
    writeFileSync(path.join(docsDir, 'AGENTS.md'), '## Role\nbuilder\n\n## Boundaries\nkeep tidy\n');
    writeFileSync(path.join(docsDir, 'plan.md'), '## Current\nship it\n');

    const execMock = vi.fn(async (file, args) => {
      expect(file).toBe('tmux');
      expect(args).toEqual(['capture-pane', '-t', 'alpha:0.0', '-p', '-S', '-20']);
      return { stdout: 'line one\nline two\n', stderr: '' };
    });
    setCollectorTestHooks({ execFileAsync: execMock });

    const result = await collectAgentContext({
      metaRoot,
      paneLines: 20,
      repoRoot: workspace,
      serverSshPath: path.join(tempDir, 'server-ssh.json'),
    }, 'alpha', { tmux: 'alpha:0.0', server: 'local' }, {});

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(result.pane.text).toBe('line one\nline two');
    expect(result.docs.roleText).toBe('builder');
    expect(result.docs.currentTask).toBe('ship it');
  });
});
