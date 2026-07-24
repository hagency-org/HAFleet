import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from 'fs';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const LOCAL_CACHE_TTL_MS = 15_000;
const REMOTE_CACHE_TTL_MS = 60_000;
const MAX_SPEC_FILES = 160;
const MAX_ISSUE_FILES = 120;
const MAX_SCAN_DEPTH = 4;
const MAX_PREFIX_BYTES = 32 * 1024;
const ATOMGIT_API_BASE = 'https://api.atomgit.com';

function text(value, max = 512) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : null;
}

function shortHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function safeBasename(value) {
  const normalized = text(value, 4096);
  return normalized ? path.basename(normalized) : null;
}

function readPrefix(filePath) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(MAX_PREFIX_BYTES);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore close failure */ }
    }
  }
}

function modifiedAt(filePath) {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

function collectMarkdownFiles(root, {
  maxFiles,
  maxDepth = MAX_SCAN_DEPTH,
  match = () => true,
} = {}) {
  if (!root || !existsSync(root)) return [];
  const output = [];
  const walk = (current, depth) => {
    if (output.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (output.length >= maxFiles) break;
      if (entry.name.startsWith('.')) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const relativePath = path.relative(root, entryPath).split(path.sep).join('/');
      if (match(relativePath)) output.push({ path: entryPath, relativePath });
    }
  };
  walk(root, 0);
  return output;
}

function frontmatterField(source, key) {
  const match = String(source || '').match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match) return null;
  return text(match[1].replace(/^["']|["']$/g, ''), 1000);
}

function frontmatterList(source, key) {
  const raw = frontmatterField(source, key);
  if (!raw) return [];
  return raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(item => text(item.replace(/^["']|["']$/g, ''), 128))
    .filter(Boolean)
    .slice(0, 40);
}

export function summarizeSpecFile(filePath, relativePath) {
  const source = readPrefix(filePath);
  if (!source) return null;
  const kind = frontmatterField(source, 'spec')
    || (path.basename(relativePath) === 'project.spec.md' ? 'project' : 'task');
  const name = frontmatterField(source, 'name')
    || source.match(/^#\s+(.+)$/m)?.[1]?.trim()
    || path.basename(relativePath, '.md');
  const scenarios = (source.match(/^Scenario:\s+/gm) || []).length;
  const tests = (source.match(/^\s*Test:\s+/gm) || []).length;
  return {
    id: shortHash(relativePath),
    kind: text(kind, 32) || 'task',
    name: text(name, 255) || path.basename(relativePath),
    file: relativePath,
    satisfies: frontmatterList(source, 'satisfies'),
    tags: frontmatterList(source, 'tags'),
    scenarios,
    tests,
    modifiedAt: modifiedAt(filePath),
  };
}

export function summarizeLocalIssueFile(filePath, relativePath, publishTarget = null) {
  const source = readPrefix(filePath);
  if (!source) return null;
  const basename = path.basename(relativePath, '.md');
  const heading = source.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const number = basename.match(/^(\d+)[-_]/)?.[1] || null;
  return {
    id: `local:${shortHash(relativePath)}`,
    source: 'local',
    number,
    title: text(heading, 255) || basename,
    state: frontmatterField(source, 'status')?.toLowerCase() || 'local',
    file: relativePath,
    modifiedAt: modifiedAt(filePath),
    publishTarget,
  };
}

function providerForHost(host) {
  const normalized = String(host || '').toLowerCase();
  if (normalized === 'github.com') return 'github';
  if (normalized === 'atomgit.com' || normalized.endsWith('.atomgit.com')) return 'atomgit';
  if (normalized === 'gitlab.com' || normalized.includes('gitlab')) return 'gitlab';
  if (normalized === 'gitee.com') return 'gitee';
  return normalized ? 'git' : 'unknown';
}

export function normalizeGitRemote(rawRemote) {
  const raw = text(rawRemote, 4096);
  if (!raw) return null;
  let host = null;
  let repoPath = null;
  const scpLike = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scpLike && !raw.includes('://')) {
    host = scpLike[1];
    repoPath = scpLike[2];
  } else {
    try {
      const url = new URL(raw);
      if (url.protocol === 'file:') return null;
      host = url.hostname;
      repoPath = url.pathname.replace(/^\/+/, '');
    } catch {
      return null;
    }
  }
  repoPath = String(repoPath || '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  const parts = repoPath.split('/').filter(Boolean);
  if (!host || parts.length < 2) return null;
  const owner = parts.slice(0, -1).join('/');
  const name = parts[parts.length - 1];
  const provider = providerForHost(host);
  const webUrl = `https://${host}/${owner}/${name}`;
  return {
    id: `${provider}:${host.toLowerCase()}:${owner}/${name}`.toLowerCase(),
    provider,
    host: host.toLowerCase(),
    owner,
    name,
    fullName: `${owner}/${name}`,
    webUrl,
  };
}

function safeCommandError(error, fallback) {
  if (error?.code === 'ENOENT') return `${fallback} executable unavailable`;
  if (error?.killed === true || error?.signal === 'SIGTERM') return `${fallback} timed out`;
  return `${fallback} unavailable`;
}

function safeRemoteError(error, provider) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return `${provider} observation timed out`;
  }
  if (error?.status === 401) return `${provider} authentication unavailable`;
  if (error?.status === 403) return `${provider} access denied`;
  return `${provider} observation unavailable`;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedSecret(value) {
  const normalized = text(value, 4096);
  return normalized && !/\s/.test(normalized) ? normalized : null;
}

function encodedRepositoryPath(repository) {
  const owner = String(repository?.owner || '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  const name = encodeURIComponent(String(repository?.name || ''));
  return owner && name ? `${owner}/${name}` : null;
}

function countChecks(rows) {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    const conclusion = String(row?.conclusion || '').toUpperCase();
    const status = String(row?.status || '').toUpperCase();
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) counts.passed++;
    else if (['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(conclusion)) counts.failed++;
    else if (!conclusion || ['QUEUED', 'IN_PROGRESS', 'PENDING', 'REQUESTED', 'WAITING'].includes(status)) counts.pending++;
  }
  return counts;
}

export function normalizeGitHubIssue(row, repository) {
  if (!row || !Number.isFinite(Number(row.number))) return null;
  return {
    id: `github:${repository.fullName}:issue:${Number(row.number)}`,
    source: 'remote',
    provider: 'github',
    repositoryId: repository.id,
    repository: repository.fullName,
    number: Number(row.number),
    title: text(row.title, 255) || `Issue #${row.number}`,
    state: String(row.state || 'open').toLowerCase(),
    url: text(row.url, 2048),
    updatedAt: text(row.updatedAt, 128),
    labels: (Array.isArray(row.labels) ? row.labels : [])
      .map(label => text(label?.name || label, 64))
      .filter(Boolean)
      .slice(0, 20),
    assignees: (Array.isArray(row.assignees) ? row.assignees : [])
      .map(assignee => text(assignee?.login || assignee?.name || assignee, 128))
      .filter(Boolean)
      .slice(0, 20),
  };
}

export function normalizeGitHubChangeRequest(row, repository) {
  if (!row || !Number.isFinite(Number(row.number))) return null;
  const rawState = String(row.state || 'open').toLowerCase();
  const state = row.isDraft === true ? 'draft' : rawState;
  return {
    id: `github:${repository.fullName}:change:${Number(row.number)}`,
    provider: 'github',
    kind: 'pull_request',
    repositoryId: repository.id,
    repository: repository.fullName,
    number: Number(row.number),
    title: text(row.title, 255) || `PR #${row.number}`,
    state,
    url: text(row.url, 2048),
    headBranch: text(row.headRefName, 255),
    baseBranch: text(row.baseRefName, 255),
    updatedAt: text(row.updatedAt, 128),
    mergeState: text(row.mergeStateStatus, 64)?.toLowerCase(),
    checks: countChecks(row.statusCheckRollup),
    additions: Number.isFinite(Number(row.additions)) ? Number(row.additions) : null,
    deletions: Number.isFinite(Number(row.deletions)) ? Number(row.deletions) : null,
    changedFiles: Number.isFinite(Number(row.changedFiles)) ? Number(row.changedFiles) : null,
  };
}

export function normalizeAtomGitIssue(row, repository) {
  const number = finiteNumber(row?.number);
  if (!row || number === null) return null;
  const assignees = Array.isArray(row.assignees)
    ? row.assignees
    : (row.assignee ? [row.assignee] : []);
  return {
    id: `atomgit:${repository.fullName}:issue:${number}`,
    source: 'remote',
    provider: 'atomgit',
    repositoryId: repository.id,
    repository: repository.fullName,
    number,
    title: text(row.title, 255) || `Issue #${number}`,
    state: String(row.state || 'open').toLowerCase(),
    url: text(row.html_url || row.web_url || row.url, 2048),
    updatedAt: text(row.updated_at, 128),
    labels: (Array.isArray(row.labels) ? row.labels : [])
      .map(label => text(label?.name || label?.title || label, 64))
      .filter(Boolean)
      .slice(0, 20),
    assignees: assignees
      .map(assignee => text(assignee?.login || assignee?.name || assignee, 128))
      .filter(Boolean)
      .slice(0, 20),
  };
}

export function normalizeAtomGitChangeRequest(row, repository) {
  const number = finiteNumber(row?.number ?? row?.iid);
  if (!row || number === null) return null;
  const rawState = String(row.state || 'open').toLowerCase();
  const mergeable = typeof row.mergeable === 'boolean'
    ? (row.mergeable ? 'mergeable' : 'blocked')
    : null;
  return {
    id: `atomgit:${repository.fullName}:change:${number}`,
    provider: 'atomgit',
    kind: 'change_request',
    repositoryId: repository.id,
    repository: repository.fullName,
    number,
    title: text(row.title, 255) || `Change request #${number}`,
    state: row.draft === true ? 'draft' : rawState,
    url: text(row.html_url || row.web_url || row.url, 2048),
    headBranch: text(row.head?.ref || row.source_branch, 255),
    baseBranch: text(row.base?.ref || row.target_branch, 255),
    updatedAt: text(row.updated_at, 128),
    mergeState: text(row.merge_status || row.can_merge_check, 64)?.toLowerCase() || mergeable,
    checks: countChecks(row.status_checks || row.checks),
    additions: finiteNumber(row.added_lines ?? row.additions),
    deletions: finiteNumber(row.removed_lines ?? row.deletions),
    changedFiles: finiteNumber(row.changed_files ?? row.changedFiles),
  };
}

function createCache() {
  const records = new Map();
  return {
    get(key, ttlMs, loader) {
      const now = Date.now();
      const existing = records.get(key);
      if (existing && existing.expiresAt > now) return existing.promise;
      const promise = Promise.resolve().then(loader);
      records.set(key, { promise, expiresAt: now + ttlMs });
      promise.catch(() => {
        if (records.get(key)?.promise === promise) records.delete(key);
      });
      return promise;
    },
    clear() {
      records.clear();
    },
  };
}

export function createProjectInspector({
  commandRunner = async (command, args, options = {}) => execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeout || 2500,
    maxBuffer: options.maxBuffer || 2 * 1024 * 1024,
    env: options.env || process.env,
  }),
  atomGitFetch = globalThis.fetch,
  atomGitToken = process.env.ATOMGIT_TOKEN,
  remoteSync = process.env.AGENT_PROJECT_BOARD_REMOTE_SYNC !== '0',
  localCacheTtlMs = LOCAL_CACHE_TTL_MS,
  remoteCacheTtlMs = REMOTE_CACHE_TTL_MS,
} = {}) {
  const localCache = createCache();
  const remoteCache = createCache();

  async function run(command, args, cwd, timeout = 2500) {
    const result = await commandRunner(command, args, { cwd, timeout });
    return String(result?.stdout || '').trim();
  }

  async function inspectGit(location) {
    let rev;
    try {
      rev = await run('git', ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir', 'HEAD'], location);
    } catch (error) {
      return {
        repository: null,
        git: {
          available: false,
          error: safeCommandError(error, 'git'),
          branch: null,
          head: null,
          dirty: null,
          changeCount: null,
          isWorktree: null,
        },
      };
    }
    const lines = rev.split(/\r?\n/);
    const root = lines[0] || location;
    const gitDir = lines[1] ? path.resolve(location, lines[1]) : null;
    const commonDir = lines[2] ? path.resolve(location, lines[2]) : gitDir;
    const head = lines[3] || null;
    const [branchResult, statusResult, remoteResult] = await Promise.allSettled([
      run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], location),
      run('git', ['status', '--porcelain=v1', '--untracked-files=normal'], location, 4000),
      run('git', ['remote', 'get-url', 'origin'], location),
    ]);
    const statusOutput = statusResult.status === 'fulfilled' ? statusResult.value : '';
    const changes = statusOutput ? statusOutput.split(/\r?\n/).filter(Boolean) : [];
    const repository = remoteResult.status === 'fulfilled'
      ? normalizeGitRemote(remoteResult.value)
      : null;
    const fallbackRepositoryId = `local:${shortHash(commonDir || root)}`;
    return {
      repository: repository
        ? { ...repository, sync: { status: remoteSync && repository.provider === 'github' ? 'pending' : 'unsupported', error: null } }
        : {
            id: fallbackRepositoryId,
            provider: 'local',
            host: null,
            owner: null,
            name: safeBasename(root) || 'repository',
            fullName: safeBasename(root) || 'repository',
            webUrl: null,
            sync: { status: 'local', error: null },
          },
      git: {
        available: true,
        error: null,
        branch: branchResult.status === 'fulfilled' ? text(branchResult.value, 255) : null,
        head: head ? head.slice(0, 12) : null,
        dirty: changes.length > 0,
        changeCount: changes.length,
        isWorktree: Boolean(gitDir && commonDir && path.resolve(gitDir) !== path.resolve(commonDir)),
      },
    };
  }

  async function inspectRemote(repository) {
    if (!repository || !remoteSync) {
      return {
        sync: { status: repository?.provider === 'local' ? 'local' : 'unsupported', error: null },
        issues: [],
        changeRequests: [],
      };
    }

    const observers = {
      github: async () => {
        const [issuesJson, changesJson] = await Promise.all([
          run('gh', [
            'issue', 'list',
            '--repo', repository.fullName,
            '--state', 'all',
            '--limit', '30',
            '--json', 'number,title,state,url,updatedAt,labels,assignees',
          ], undefined, 8000),
          run('gh', [
            'pr', 'list',
            '--repo', repository.fullName,
            '--state', 'all',
            '--limit', '30',
            '--json', 'number,title,state,isDraft,url,headRefName,baseRefName,updatedAt,mergeStateStatus,statusCheckRollup,additions,deletions,changedFiles',
          ], undefined, 8000),
        ]);
        const issueRows = JSON.parse(issuesJson || '[]');
        const changeRows = JSON.parse(changesJson || '[]');
        return {
          issues: issueRows.map(row => normalizeGitHubIssue(row, repository)).filter(Boolean),
          changeRequests: changeRows.map(row => normalizeGitHubChangeRequest(row, repository)).filter(Boolean),
        };
      },
      atomgit: async () => {
        if (typeof atomGitFetch !== 'function') {
          const error = new Error('AtomGit fetch unavailable');
          error.code = 'ENOENT';
          throw error;
        }
        const repositoryPath = encodedRepositoryPath(repository);
        if (!repositoryPath) throw new Error('Invalid AtomGit repository');
        const token = normalizedSecret(atomGitToken);
        const headers = {
          Accept: 'application/json',
          'User-Agent': 'agent-chat-project-board',
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        const request = async resource => {
          const url = new URL(`/api/v5/repos/${repositoryPath}/${resource}`, ATOMGIT_API_BASE);
          url.searchParams.set('state', 'all');
          url.searchParams.set('page', '1');
          url.searchParams.set('per_page', '30');
          const response = await atomGitFetch(url, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(8000),
          });
          if (!response?.ok) {
            const error = new Error('AtomGit request failed');
            error.status = Number(response?.status) || 500;
            throw error;
          }
          const body = await response.json();
          if (!Array.isArray(body)) throw new Error('Invalid AtomGit response');
          return body;
        };
        const [issueRows, changeRows] = await Promise.all([
          request('issues'),
          request('pulls'),
        ]);
        return {
          issues: issueRows.map(row => normalizeAtomGitIssue(row, repository)).filter(Boolean),
          changeRequests: changeRows
            .map(row => normalizeAtomGitChangeRequest(row, repository))
            .filter(Boolean),
        };
      },
    };
    const observer = observers[repository.provider];
    if (!observer) {
      return {
        sync: { status: repository.provider === 'local' ? 'local' : 'unsupported', error: null },
        issues: [],
        changeRequests: [],
      };
    }

    return remoteCache.get(repository.id, remoteCacheTtlMs, async () => {
      try {
        const observed = await observer();
        return {
          sync: { status: 'ok', error: null, observedAt: new Date().toISOString() },
          issues: observed.issues,
          changeRequests: observed.changeRequests,
        };
      } catch (error) {
        const providerName = repository.provider === 'atomgit' ? 'AtomGit' : 'GitHub';
        return {
          sync: {
            status: 'unavailable',
            error: repository.provider === 'github'
              ? safeCommandError(error, `${providerName} observation`)
              : safeRemoteError(error, providerName),
          },
          issues: [],
          changeRequests: [],
        };
      }
    });
  }

  async function inspectManagedProject(entry, agentName) {
    const originPath = text(entry?.originPath, 4096);
    const managedPath = text(entry?.path, 4096);
    const location = [originPath, managedPath].find(candidate => {
      if (!candidate || !path.isAbsolute(candidate) || !existsSync(candidate)) return false;
      try { return lstatSync(candidate).isDirectory() || lstatSync(candidate).isSymbolicLink(); } catch { return false; }
    });
    const name = text(entry?.name, 128) || safeBasename(location) || 'project';
    if (!location) {
      return {
        id: `missing:${shortHash(`${agentName}:${name}:${managedPath || originPath || ''}`)}`,
        agent: text(agentName, 128),
        project: name,
        mode: text(entry?.source, 64) || 'unknown',
        locationLabel: safeBasename(originPath || managedPath) || name,
        available: false,
        repository: null,
        git: { available: false, error: 'managed project unavailable', branch: null, head: null, dirty: null, changeCount: null, isWorktree: null },
        specs: [],
        localIssues: [],
        remoteIssues: [],
        changeRequests: [],
      };
    }

    return localCache.get(`${agentName}:${location}`, localCacheTtlMs, async () => {
      const inspected = await inspectGit(location);
      const publishTarget = inspected.repository && inspected.repository.provider !== 'local'
        ? {
            provider: inspected.repository.provider,
            repositoryId: inspected.repository.id,
            repository: inspected.repository.fullName,
            url: inspected.repository.webUrl,
          }
        : null;
      const specsRoot = path.join(location, 'specs');
      const issuesRoot = path.join(location, 'issues');
      const specs = collectMarkdownFiles(specsRoot, {
        maxFiles: MAX_SPEC_FILES,
        match: relative => relative.endsWith('.spec.md') || relative === 'project.spec.md',
      })
        .map(file => summarizeSpecFile(file.path, `specs/${file.relativePath}`))
        .filter(Boolean);
      const localIssues = collectMarkdownFiles(issuesRoot, {
        maxFiles: MAX_ISSUE_FILES,
        maxDepth: 1,
      })
        .map(file => summarizeLocalIssueFile(file.path, `issues/${file.relativePath}`, publishTarget))
        .filter(Boolean)
        .sort((left, right) => String(right.modifiedAt || '').localeCompare(String(left.modifiedAt || '')));
      const remote = await inspectRemote(inspected.repository);
      return {
        id: `worktree:${shortHash(location)}`,
        agent: text(agentName, 128),
        project: name,
        mode: text(entry?.source, 64) || 'unknown',
        locationLabel: safeBasename(location) || name,
        available: true,
        repository: inspected.repository
          ? { ...inspected.repository, sync: remote.sync }
          : null,
        git: inspected.git,
        specs,
        localIssues,
        remoteIssues: remote.issues,
        changeRequests: remote.changeRequests,
      };
    });
  }

  return {
    inspectManagedProject,
    clear() {
      localCache.clear();
      remoteCache.clear();
    },
  };
}
