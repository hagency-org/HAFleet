import { describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LAUNCH_PERMISSION_SUMMARY,
  assertSafeLaunchExtraArgs,
  defaultLaunchArgs,
  readFirstAgentManifest,
  resolveManagedProjectRoots,
  validateLaunchExtraArgs,
} from '../lib/agent-launch-policy.js';

describe('agent launch permission policy', () => {
  test('Claude defaults to auto-mode', () => {
    expect(defaultLaunchArgs('claude')).toEqual(['--permission-mode', 'auto']);
    expect(LAUNCH_PERMISSION_SUMMARY.claude).toBe('auto-mode');
  });

  test('Codex Level 2 maps to workspace-write plus on-request', () => {
    expect(defaultLaunchArgs('codex')).toEqual([
      '--sandbox', 'workspace-write',
      '--ask-for-approval', 'on-request',
    ]);
    expect(LAUNCH_PERMISSION_SUMMARY.codex).toContain('level2');
  });

  test.each([
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
    '--permission-mode bypassPermissions',
    '--permission-mode=manual',
  ])('rejects Claude permission override: %s', (extraArgs) => {
    expect(validateLaunchExtraArgs('claude', extraArgs).ok).toBe(false);
  });

  test.each([
    '--yolo',
    '--full-auto',
    '--dangerously-bypass-approvals-and-sandbox',
    '--sandbox danger-full-access',
    '--sandbox=read-only',
    '-s workspace-write',
    '-sdanger-full-access',
    '--ask-for-approval never',
    '-a on-request',
    '-a=never',
    '-c sandbox_mode="danger-full-access"',
    '-c=approval_policy="never"',
    '-csandbox_mode="danger-full-access"',
    '--config approval_policy="never"',
  ])('rejects Codex Level 2 override: %s', (extraArgs) => {
    expect(validateLaunchExtraArgs('codex', extraArgs).ok).toBe(false);
  });

  test('allows unrelated framework flags', () => {
    expect(validateLaunchExtraArgs('claude', '--effort high --verbose').ok).toBe(true);
    expect(validateLaunchExtraArgs('codex', '--search --enable fast_mode').ok).toBe(true);
  });

  test('preserves quoted values as individual tokens', () => {
    expect(validateLaunchExtraArgs('claude', '--model "custom model" --verbose')).toEqual({
      ok: true,
      tokens: ['--model', 'custom model', '--verbose'],
    });
  });

  test('rejects shell command injection and malformed quoting', () => {
    expect(validateLaunchExtraArgs('codex', '--search; touch /tmp/owned').ok).toBe(false);
    expect(validateLaunchExtraArgs('claude', '--model "unterminated').ok).toBe(false);
  });

  test('rejects an extra positional delimiter that could hide managed launch arguments', () => {
    expect(validateLaunchExtraArgs('claude', '--verbose --').ok).toBe(false);
    expect(validateLaunchExtraArgs('codex', '--search --').ok).toBe(false);
  });

  test('assert helper exposes a stable error code', () => {
    expect(() => assertSafeLaunchExtraArgs('codex', '--yolo')).toThrow(
      expect.objectContaining({ code: 'unsafe_launch_extra_args' }),
    );
  });

  test('canonicalizes symlink-mounted managed projects and deduplicates roots', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-launch-policy-'));
    try {
      const workdir = path.join(root, 'workdir');
      const sourceProject = path.join(root, 'source-project');
      const projectLink = path.join(workdir, 'projects', 'demo');
      mkdirSync(path.dirname(projectLink), { recursive: true });
      mkdirSync(sourceProject, { recursive: true });
      symlinkSync(sourceProject, projectLink, 'dir');
      const result = resolveManagedProjectRoots({
        manifest: { managedProjects: [{ path: projectLink }, { path: sourceProject }] },
        agentPath: workdir,
        homeDir: path.join(root, 'home'),
      });
      expect(result.roots).toEqual([realpathSync(sourceProject)]);
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects home, a home ancestor, or filesystem root as a managed project root', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-launch-policy-'));
    try {
      const workdir = path.join(root, 'workdir');
      const fakeHome = path.join(root, 'home');
      mkdirSync(workdir, { recursive: true });
      mkdirSync(fakeHome, { recursive: true });
      expect(() => resolveManagedProjectRoots({
        manifest: { managedProjects: [{ path: fakeHome }] },
        agentPath: workdir,
        homeDir: fakeHome,
      })).toThrow(expect.objectContaining({ code: 'unsafe_managed_project_root' }));
      expect(() => resolveManagedProjectRoots({
        manifest: { managedProjects: [{ path: root }] },
        agentPath: workdir,
        homeDir: fakeHome,
      })).toThrow(expect.objectContaining({ code: 'unsafe_managed_project_root' }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reads the first valid manifest candidate', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-launch-policy-'));
    try {
      const broken = path.join(root, 'broken.json');
      const valid = path.join(root, 'agent.json');
      writeFileSync(broken, '{broken');
      writeFileSync(valid, JSON.stringify({ name: 'alpha', managedProjects: [] }));
      expect(readFirstAgentManifest([broken, valid])).toMatchObject({ name: 'alpha' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
