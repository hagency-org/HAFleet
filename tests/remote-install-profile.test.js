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

  test('remote autodeploy install-scope gap remains documented before behavior changes', () => {
    const installSource = read('remote/install-remote.sh');
    const autodeploySource = read('scripts/agentchat-remote-autodeploy.sh');
    const decisionDoc = read('docs/salt/14-cd-next-decisions.md');
    const cdB0Doc = read('docs/salt/16-cd-b0-remote-install-profile.md');

    expect(installSource).toMatch(/cd "\$SCRIPT_DIR"[\s\S]*npm install --omit=dev/);
    expect(autodeploySource).toContain('diff --name-only "$old_ref" "$new_ref" -- package.json package-lock.json');
    expect(autodeploySource).toContain('(cd "$REPO_DIR" && npm install --omit=dev)');
    expect(decisionDoc).toContain('Decision 9: Remote Autodeploy Install Scope Beyond Dependencies');
    expect(cdB0Doc).toContain('R-050');
    expect(cdB0Doc).toContain('Remote autodeploy remains code/dependency/restart only and does not rerun `remote/install-remote.sh`.');
  });
});
