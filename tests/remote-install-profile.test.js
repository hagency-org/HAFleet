import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

function read(relPath) {
  return readFileSync(path.resolve(relPath), 'utf8');
}

describe('remote install profile decision contracts', () => {
  test('full-clone helper profile remains explicit and decision-gated', () => {
    const installSource = read('remote/install-remote.sh');
    const remoteReadme = read('remote/README.md');
    const decisionDoc = read('docs/salt/14-cd-next-decisions.md');
    const cdB0Doc = read('docs/salt/16-cd-b0-remote-install-profile.md');

    expect(installSource).toMatch(/BIN_SOURCE_DIR="\$SCRIPT_DIR\/bin"[\s\S]*REPO_ROOT\/bin[\s\S]*BIN_SOURCE_DIR="\$REPO_ROOT\/bin"/);
    expect(remoteReadme).toContain('In normal `git clone` deployments, `install-remote.sh` uses repo-root `bin/` as the helper source of truth.');
    expect(decisionDoc).toContain('Decision 6: Full Clone Remote Command Surface');
    expect(cdB0Doc).toContain('R-047');
    expect(cdB0Doc).toContain('Current full-clone installs link helpers from root `bin/` when it exists.');
  });

  test('remote dependency lock policy is explicit and not silently enforced by the package gate', () => {
    const gitignoreSource = read('.gitignore');
    const buildSource = read('scripts/build-remote-package.sh');
    const decisionDoc = read('docs/salt/14-cd-next-decisions.md');
    const cdB0Doc = read('docs/salt/16-cd-b0-remote-install-profile.md');

    expect(gitignoreSource).toMatch(/^remote\/package-lock\.json$/m);
    expect(buildSource).not.toContain('remote/package-lock.json:package-lock.json');
    expect(decisionDoc).toContain('Decision 7: Remote Dependency Reproducibility');
    expect(cdB0Doc).toContain('R-048');
    expect(cdB0Doc).toContain('Remote runtime dependencies are currently lockless from git/CD perspective.');
  });

  test('standalone remote package expected-version boundary is documented', () => {
    const relaySource = read('lib/push-relay-core.js');
    const remoteRelaySource = read('remote/lib/push-relay-core.js');
    const buildSource = read('scripts/build-remote-package.sh');
    const decisionDoc = read('docs/salt/14-cd-next-decisions.md');
    const cdB0Doc = read('docs/salt/16-cd-b0-remote-install-profile.md');

    expect(relaySource).toContain("execFileSync('git', ['rev-parse', '--short', 'HEAD']");
    expect(remoteRelaySource).toContain("execFileSync('git', ['rev-parse', '--short', 'HEAD']");
    expect(buildSource).not.toMatch(/AGENT_CHAT_VERSION|VERSION_FILE|version\.txt/);
    expect(decisionDoc).toContain('Decision 8: Standalone Remote Package Version');
    expect(cdB0Doc).toContain('R-049');
    expect(cdB0Doc).toContain('Standalone `remote-dist` packages currently have no packaged version file.');
  });

  test('remote autodeploy installs remote runtime dependencies from the remote tree', () => {
    const installSource = read('remote/install-remote.sh');
    const autodeploySource = read('scripts/agentchat-remote-autodeploy.sh');
    const decisionDoc = read('docs/salt/14-cd-next-decisions.md');
    const cdB0Doc = read('docs/salt/16-cd-b0-remote-install-profile.md');

    expect(installSource).toMatch(/cd "\$SCRIPT_DIR"[\s\S]*npm install --omit=dev/);
    expect(autodeploySource).toContain('diff --name-only "$old_ref" "$new_ref" -- remote/package.json remote/package-lock.json');
    expect(autodeploySource).toContain('local remote_dir="$REPO_DIR/remote"');
    expect(autodeploySource).toContain('(cd "$remote_dir" && npm install --omit=dev)');
    expect(decisionDoc).toContain('Decision 9: Remote Autodeploy Install Scope Beyond Dependencies');
    expect(cdB0Doc).toContain('R-050');
    expect(cdB0Doc).toContain('Remote autodeploy remains code/remote-dependency/restart only and does not rerun `remote/install-remote.sh`.');
  });

  test('standalone package does not install broken git-only autodeploy', () => {
    const buildSource = read('scripts/build-remote-package.sh');
    const installSource = read('remote/install-remote.sh');

    expect(buildSource).not.toContain('scripts/agentchat-remote-autodeploy.sh:');
    expect(installSource).toContain('AUTODEPLOY_SCRIPT="$REPO_ROOT/scripts/agentchat-remote-autodeploy.sh"');
    expect(installSource).toContain('[ ! -d "$REPO_ROOT/.git" ]');
    expect(installSource).toContain('standalone package has no git checkout for autodeploy');
    expect(installSource).toContain('[ ! -x "$AUTODEPLOY_SCRIPT" ]');
    expect(installSource).toContain('AUTODEPLOY_INSTALLED=true');
    expect(installSource).toContain('if [ "$AUTODEPLOY_INSTALLED" = true ]; then');
  });

  test('standalone package omits git-checkout-only audit and skill sync commands', () => {
    const buildSource = read('scripts/build-remote-package.sh');
    const syncSource = read('scripts/check-remote-sync.sh');
    const manifestSource = read('scripts/cli-command-manifest.json');
    const remoteCli = read('remote/bin/agentchat');
    const installSource = read('remote/install-remote.sh');
    const remoteReadme = read('remote/README.md');

    expect(buildSource).not.toContain('bin/agent-audit:bin/agent-audit');
    expect(buildSource).not.toContain('bin/agentchat-sync-skills:bin/agentchat-sync-skills');
    expect(syncSource).not.toContain('"bin/agent-audit"');
    expect(syncSource).not.toContain('"bin/agentchat-sync-skills"');
    expect(manifestSource).toContain('"audit"');
    expect(manifestSource).toContain('"sync-skills"');
    expect(remoteCli).not.toMatch(/^\s*audit\)/m);
    expect(remoteCli).not.toMatch(/^\s*sync-skills\)/m);
    expect(installSource).not.toContain('agent-audit');
    expect(installSource).not.toContain('agentchat-sync-skills');
    expect(remoteReadme).not.toContain('bin/agent-audit');
    expect(remoteReadme).not.toContain('bin/agentchat-sync-skills');
    expect(remoteReadme).not.toContain('agentchat audit');
    expect(remoteReadme).not.toContain('agentchat sync-skills');
  });
});
