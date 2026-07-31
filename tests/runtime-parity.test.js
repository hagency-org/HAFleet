import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

describe('runtime parity regressions', () => {
  test('MCP auto-registration uses the shared server identity resolver', () => {
    const localSource = readFileSync(path.resolve('lib/mcp-server-core.js'), 'utf-8');
    const source = readFileSync(path.resolve('remote/lib/mcp-server-core.js'), 'utf-8');
    expect(localSource).toContain("import { resolveLocalServerId } from './server-identity.js';");
    expect(source).toContain("import { resolveLocalServerId } from './server-identity.js';");
    expect(source).toContain('const AGENT_SERVER = resolveLocalServerId();');
  });

  test('agent-up launches through wrappers and provides complete Codex MCP config', () => {
    for (const scriptPath of ['bin/agent-up', 'remote/bin/agent-up']) {
      const source = readFileSync(path.resolve(scriptPath), 'utf-8');
      expect(source).toContain('write_launch_script()');
      expect(source).toContain('launch-claude.sh');
      expect(source).toContain('launch-codex.sh');
      expect(source).toContain('mcp_servers.${CODEX_MCP_NAME}.command');
      expect(source).toContain('mcp_servers.${CODEX_MCP_NAME}.args');
      expect(source).toContain('codex_mcp_env API_TOKEN "${API_TOKEN:-}"');
      expect(source).toContain('codex_mcp_env AGENTCHAT_HOMEDIR "${AGENTCHAT_HOMEDIR:-}"');
      expect(source).toContain('tmux send-keys -t "$TMUX_PANE_TARGET" "exec $(shell_quote "$CODEX_LAUNCH_SCRIPT")" Enter');
      expect(source).toContain('MANAGED_RUNTIME_PID_FILE="$AGENT_DATA/managed-runtime.pid"');
      expect(source).toContain('preflight_runtime_approval_adapter');
      expect(source).toContain('CODEX_INIT_FILE=$(mktemp "$TMP_RUNTIME_DIR/init-codex.XXXXXX")');
      expect(source).toContain('CLAUDE_FLAGS="--permission-mode auto"');
      expect(source).toContain('CODEX_FLAGS="--sandbox workspace-write --ask-for-approval on-request -C $(shell_quote "$AGENT_PATH")"');
      expect(source).toContain("printf 'unset ANTHROPIC_API_KEY");
      expect(source).toContain('write_launch_env "ANTHROPIC_API_KEY" "$SAVED_RUNTIME_PROFILE_PRIMARY_API_KEY"');
      expect(source).toContain('node "$LAUNCH_POLICY_CHECK" "$TYPE" "$EXTRA_ARGS"');
      expect(source).toContain('CLAUDE_FLAGS="$CLAUDE_FLAGS $SAFE_EXTRA_ARGS"');
      expect(source).toContain('CODEX_FLAGS="$CODEX_FLAGS $SAFE_EXTRA_ARGS"');
      expect(source).toContain('MANAGED_PROJECT_PATHS="$(resolve_managed_project_paths)"');
      expect(source).toContain('codex $CODEX_FLAGS --');
      expect(source).not.toContain('CLAUDE_FLAGS="--dangerously-skip-permissions"');
      expect(source).not.toContain('CODEX_FLAGS="--yolo"');
      // Typing the init prompt into a pane after launch was banned outright,
      // because bin/agent-up tried it for Codex and abandoned it: "tmux key
      // timing is unreliable while Codex is still drawing its first prompt".
      //
      // Hermes leaves no alternative — both -z/--oneshot and `chat -q` print one
      // response and exit, so an interactive session cannot be given a starting
      // prompt any other way, and without one the agent never learns its name or
      // its tools. The ban is therefore narrowed rather than dropped: typing is
      // permitted only when the same branch first waits for a readiness marker
      // and refuses to type if it never appears. Blind typing stays forbidden.
      if (source.includes('send-keys -t "$TMUX_PANE_TARGET" -l "$INIT_PROMPT"')) {
        const branch = source.slice(source.lastIndexOf('elif [', source.indexOf('-l "$INIT_PROMPT"')));
        const upToTyping = branch.slice(0, branch.indexOf('-l "$INIT_PROMPT"'));
        expect(upToTyping, `${scriptPath}: init prompt typed without waiting for readiness`)
          .toMatch(/ready-fixed|grep -qF/);
        expect(upToTyping, `${scriptPath}: no refusal path if readiness never appears`)
          .toMatch(/did not appear within/);
      }
      expect(source).not.toContain('Launch cmd:');
    }
  });

  test('deployment and upstream helpers avoid machine-specific hardcoded home paths', async () => {
    const autodeploySource = readFileSync(path.resolve('scripts/agentchat-stable-autodeploy.sh'), 'utf-8');
    const autostartSource = readFileSync(path.resolve('bin/agentchat-autostart.sh'), 'utf-8');
    const previousRoot = process.env.AGENT_CHAT_ROOT;
    const previousUpstreamRoot = process.env.UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT;
    try {
      process.env.AGENT_CHAT_ROOT = '/tmp/agent-chat-root';
      delete process.env.UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT;
      const moduleUrl = pathToFileURL(path.resolve('lib/upstream-claude-subconscious.js')).href;
      const upstreamModule = await import(`${moduleUrl}?test=${Date.now()}`);

      expect(autodeploySource).not.toMatch(/\/home\/[a-z_][a-z0-9_-]*\/.*agent-chat/);
      expect(autostartSource).not.toMatch(/export HOME="\/home\/[a-z_][a-z0-9_-]*"/);
      expect(upstreamModule.UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT).toBe('/tmp/claude-subconscious');
    } finally {
      if (previousRoot === undefined) delete process.env.AGENT_CHAT_ROOT;
      else process.env.AGENT_CHAT_ROOT = previousRoot;
      if (previousUpstreamRoot === undefined) delete process.env.UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT;
      else process.env.UPSTREAM_CLAUDE_SUBCONSCIOUS_ROOT = previousUpstreamRoot;
    }
  });

  test('push-relay check_inbox hint exists', () => {
    const localSource = readFileSync(path.resolve('lib/push-relay-core.js'), 'utf-8');
    const hintPattern = /const checkHint = '([^']+)';/;
    const localHint = localSource.match(hintPattern)?.[1] || null;
    expect(localHint).toBe('FIRST ACTION: call check_inbox() now. Use check_inbox() in agent-chat MCP for full context before acting.');
  });

  test('backend and local push-relay import blocked patterns from the shared module', () => {
    const backendSource = readFileSync(path.resolve('backend-v2.js'), 'utf-8');
    const relaySource = readFileSync(path.resolve('lib/push-relay-core.js'), 'utf-8');
    const sharedSource = readFileSync(path.resolve('lib/blocked-patterns.js'), 'utf-8');
    const remoteSharedSource = readFileSync(path.resolve('remote/lib/blocked-patterns.js'), 'utf-8');

    expect(backendSource).toMatch(/from '\.\/lib\/blocked-patterns\.js';/);
    expect(relaySource).toMatch(/from '\.\/blocked-patterns\.js';/);
    expect(sharedSource).toMatch(/reason: 'approval-mode-toggle'/);
    expect(sharedSource).toMatch(/reason: 'interactive-confirm'/);
    expect(sharedSource).toMatch(/reason: 'update-required'/);
    expect(remoteSharedSource).toBe(sharedSource);
  });

  test('trusted ops docs describe reset-based stable deploy behavior', () => {
    const readmeSource = readFileSync(path.resolve('README.md'), 'utf-8');
    const operationsSource = readFileSync(path.resolve('OPERATIONS.md'), 'utf-8');
    const stableDeployPattern = /Stable Branch Auto Deploy \(Live\)[\s\S]*?## Configuration/;
    const readmeStableDeploy = readmeSource.match(stableDeployPattern)?.[0] || '';

    expect(readmeStableDeploy).not.toMatch(/git pull --ff-only origin stable/);
    expect(readmeStableDeploy).toContain('git reset --hard HEAD');
    expect(readmeStableDeploy).toContain('git clean -fd');
    expect(readmeStableDeploy).toContain('git reset --hard origin/stable');
    expect(readmeStableDeploy).toContain('npm run verify:cd-preflight');
    expect(readmeStableDeploy).toContain('agentchat verify-remote --samples 2 --interval 16 --expect-version <short-sha>');

    expect(operationsSource).toContain('The live deploy checkout is disposable.');
    expect(operationsSource).toContain('git reset --hard HEAD');
    expect(operationsSource).toContain('git clean -fd');
    expect(operationsSource).toContain('git reset --hard origin/stable');
  });

  test('stale deploy docs are archived and redirect to trusted runbooks', () => {
    const staleDocPaths = [
      'docs/architecture/ops-patterns.md',
      'docs/architecture/system-components.md',
      'docs/salt/README.md',
    ];

    for (const docPath of staleDocPaths) {
      const source = readFileSync(path.resolve(docPath), 'utf-8');
      expect(source).toContain('Archive notice:');
      expect(source).toContain('Current operator procedures live in root `README.md` and `OPERATIONS.md`');
    }

    const saltReadme = readFileSync(path.resolve('docs/salt/README.md'), 'utf-8');
    expect(saltReadme).not.toMatch(/temporary authority/);

    const remoteRoadmap = readFileSync(path.resolve('ROADMAP-remote.md'), 'utf-8');
    expect(remoteRoadmap).toContain('Archive notice:');
    expect(remoteRoadmap).toContain('superseded historical planning material');
    expect(remoteRoadmap).toContain('remote/README.md');
    expect(remoteRoadmap).toContain('OPERATIONS.md');

    const readmeSource = readFileSync(path.resolve('README.md'), 'utf-8');
    expect(readmeSource).toContain('`ROADMAP-remote.md` — Superseded remote planning archive');

    const staleIndex = readFileSync(path.resolve('docs/salt/05-docs-archive-index.md'), 'utf-8');
    expect(staleIndex).toContain('`docs/architecture/system-components.md` | Route tables and line counts are stale. | Keep archived with a top-level redirect');
    expect(staleIndex).toContain('`ROADMAP-remote.md` | Reads like future roadmap although remote support exists. | Keep archived/superseded with a top-level redirect');
    expect(staleIndex).not.toMatch(/ROADMAP-remote\.md`\s*\|[^\n]*operator review/);
  });
});
