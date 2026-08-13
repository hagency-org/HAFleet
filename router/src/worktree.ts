import { execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INHERITED_BOOTSTRAP_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NO_COLOR', 'FORCE_COLOR',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
] as const;

function bootstrapEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_BOOTSTRAP_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export interface WorktreeSpec {
  repositoryPath: string;
  worktreesDir: string;
  agentId: string;
  threadRootEventId: string;
  bootstrap?: readonly string[];
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  safeLabel: string;
  resourceId: string;
  created: boolean;
}

export interface WorktreeInspection extends WorktreeInfo {
  dirty: boolean;
}

function segment(value: string, fallback: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return normalized || fallback;
}

function shortDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function resourceDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function ensureInside(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('worktree target must be a strict child of worktrees_dir');
  }
}

function identity(spec: WorktreeSpec): { branch: string; target: string; safeLabel: string; resourceId: string } {
  const agent = segment(spec.agentId, 'agent');
  const thread = `${segment(spec.threadRootEventId, 'thread').slice(0, 28)}-${shortDigest(spec.threadRootEventId)}`;
  const branch = `agentchat/${agent}/${thread}`;
  const target = path.resolve(spec.worktreesDir, agent, thread);
  return {
    branch,
    target,
    safeLabel: `${agent}/${thread}`,
    resourceId: `worktree:${resourceDigest(JSON.stringify([
      spec.repositoryPath,
      spec.worktreesDir,
      spec.agentId,
      spec.threadRootEventId,
    ]))}`,
  };
}

interface BootstrapState {
  version: 1;
  status: 'running' | 'failed' | 'complete';
  digest: string;
}

function bootstrapStatePath(worktreePath: string): string {
  const rawGitDir = git(worktreePath, ['rev-parse', '--git-dir']);
  const gitDir = realpathSync(path.resolve(worktreePath, rawGitDir));
  return path.join(gitDir, 'agentchat-bootstrap.json');
}

function readBootstrapState(statePath: string): BootstrapState | null {
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<BootstrapState>;
    if (
      parsed.version !== 1
      || !['running', 'failed', 'complete'].includes(parsed.status ?? '')
      || typeof parsed.digest !== 'string'
    ) return null;
    return parsed as BootstrapState;
  } catch {
    return null;
  }
}

function writeBootstrapState(statePath: string, state: BootstrapState): void {
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function ensureBootstrap(
  spec: WorktreeSpec,
  worktreePath: string,
): void {
  if (!spec.bootstrap || spec.bootstrap.length === 0) return;
  const executable = spec.bootstrap[0];
  if (!executable) throw new Error('worktree bootstrap executable is empty');
  const statePath = bootstrapStatePath(worktreePath);
  const stateExists = existsSync(statePath);
  const state = readBootstrapState(statePath);
  if (stateExists && !state) {
    throw new Error('worktree bootstrap state is corrupt; operator repair is required');
  }
  const bootstrapDigest = resourceDigest(JSON.stringify(spec.bootstrap));
  if (state?.status === 'complete' && state.digest === bootstrapDigest) return;
  if (state && git(worktreePath, ['status', '--porcelain']).length > 0) {
    const reason = state.status !== 'complete'
      ? 'worktree bootstrap previously failed and left a dirty workspace'
      : 'worktree bootstrap configuration changed while the workspace is dirty';
    throw new Error(`${reason}; operator repair is required`);
  }
  writeBootstrapState(statePath, { version: 1, status: 'running', digest: bootstrapDigest });
  try {
    execFileSync(executable, spec.bootstrap.slice(1), {
      cwd: worktreePath,
      stdio: 'inherit',
      env: bootstrapEnv(),
    });
  } catch (error) {
    writeBootstrapState(statePath, { version: 1, status: 'failed', digest: bootstrapDigest });
    throw error;
  }
  writeBootstrapState(statePath, { version: 1, status: 'complete', digest: bootstrapDigest });
}

export class WorktreeManager {
  private readonly preparations = new Map<string, Promise<WorktreeInfo>>();

  ensureAsync(spec: WorktreeSpec): Promise<WorktreeInfo> {
    const key = resourceDigest(JSON.stringify([
      spec.repositoryPath, spec.worktreesDir, spec.agentId, spec.threadRootEventId,
    ]));
    const existing = this.preparations.get(key);
    if (existing) return existing;
    const preparation = new Promise<WorktreeInfo>((resolve, reject) => {
      const worker = fork(fileURLToPath(new URL('./worktree-worker.js', import.meta.url)), [], {
        cwd: process.cwd(),
        env: bootstrapEnv(),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let settled = false;
      let stderr = '';
      worker.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
      });
      worker.once('message', (message: unknown) => {
        settled = true;
        if (
          message !== null && typeof message === 'object' && !Array.isArray(message)
          && (message as { ok?: unknown }).ok === true
        ) {
          resolve((message as { value: WorktreeInfo }).value);
        } else {
          const error = message !== null && typeof message === 'object' && !Array.isArray(message)
            ? String((message as { error?: unknown }).error ?? 'worktree preparation failed')
            : 'worktree preparation failed';
          reject(new Error(error));
        }
      });
      worker.once('error', (error) => {
        settled = true;
        reject(error);
      });
      worker.once('exit', (code) => {
        if (!settled && code !== 0) {
          reject(new Error(`worktree preparation worker exited ${code}: ${stderr}`.trim()));
        }
        else if (!settled) reject(new Error('worktree preparation worker exited without a result'));
      });
      worker.send(spec, (error) => {
        if (!error) return;
        settled = true;
        reject(error);
      });
    });
    this.preparations.set(key, preparation);
    void preparation.finally(() => this.preparations.delete(key)).catch(() => undefined);
    return preparation;
  }

  ensure(spec: WorktreeSpec): WorktreeInfo {
    const repositoryPath = realpathSync(spec.repositoryPath);
    const repositoryRoot = realpathSync(git(repositoryPath, ['rev-parse', '--show-toplevel']));
    if (repositoryRoot !== repositoryPath) throw new Error('repository_path must be the git worktree root');
    const requestedWorktreesDir = path.resolve(spec.worktreesDir);
    mkdirSync(requestedWorktreesDir, { recursive: true, mode: 0o700 });
    const worktreesDir = realpathSync(requestedWorktreesDir);
    const resolved = identity({ ...spec, repositoryPath, worktreesDir });
    ensureInside(worktreesDir, resolved.target);
    const registered = this.registeredWorktrees(repositoryPath);
    const existingBranchPath = registered.get(resolved.branch);
    if (existingBranchPath) {
      const existingCanonical = realpathSync(existingBranchPath);
      const targetCanonical = existsSync(resolved.target) ? realpathSync(resolved.target) : resolved.target;
      if (existingCanonical !== targetCanonical) {
        throw new Error(`branch ${resolved.branch} is already checked out elsewhere`);
      }
      if (!existsSync(resolved.target)) throw new Error('registered worktree path is missing');
      ensureBootstrap(spec, existingCanonical);
      return { ...resolved, path: existingCanonical, created: false };
    }
    if (existsSync(resolved.target)) {
      throw new Error('refusing to reuse an unregistered worktree directory');
    }
    mkdirSync(path.dirname(resolved.target), { recursive: true, mode: 0o700 });
    let branchExists = true;
    try { git(repositoryPath, ['show-ref', '--verify', '--quiet', `refs/heads/${resolved.branch}`]); }
    catch { branchExists = false; }
    if (branchExists) git(repositoryPath, ['worktree', 'add', resolved.target, resolved.branch]);
    else git(repositoryPath, ['worktree', 'add', '-b', resolved.branch, resolved.target, 'HEAD']);
    ensureBootstrap(spec, resolved.target);
    return { ...resolved, path: realpathSync(resolved.target), created: true };
  }

  inspect(spec: WorktreeSpec): WorktreeInspection {
    const info = this.ensure(spec);
    return { ...info, dirty: git(info.path, ['status', '--porcelain']).length > 0 };
  }

  remove(spec: WorktreeSpec, force = false): WorktreeInfo {
    const repositoryPath = realpathSync(spec.repositoryPath);
    const worktreesDir = realpathSync(path.resolve(spec.worktreesDir));
    const resolved = identity({ ...spec, repositoryPath, worktreesDir });
    ensureInside(worktreesDir, resolved.target);
    if (!existsSync(resolved.target)) throw new Error('worktree does not exist');
    const actual = realpathSync(resolved.target);
    const dirty = git(actual, ['status', '--porcelain']).length > 0;
    if (dirty && !force) throw new Error('dirty worktree requires explicit force');
    git(repositoryPath, ['worktree', 'remove', ...(force ? ['--force'] : []), actual]);
    return { ...resolved, path: actual, created: false };
  }

  private registeredWorktrees(repositoryPath: string): Map<string, string> {
    const output = git(repositoryPath, ['worktree', 'list', '--porcelain']);
    const result = new Map<string, string>();
    let currentPath: string | null = null;
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) currentPath = line.slice('worktree '.length);
      else if (line.startsWith('branch refs/heads/') && currentPath) {
        result.set(line.slice('branch refs/heads/'.length), currentPath);
      } else if (!line.trim()) currentPath = null;
    }
    return result;
  }
}
