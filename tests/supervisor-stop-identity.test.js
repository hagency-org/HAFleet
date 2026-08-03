import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import path from 'node:path';

// `hafleet stop` refused on a fleet host with "supervisor PID belongs to an unexpected
// process", leaving a crash-looping service that could not be removed. The
// supervisor is launched from the runtime root as
//   node services/hafleet-services.mjs run --profile ... --runtime <runtime-root>
// so ps reports a RELATIVE script path, while the guard compared against the
// ABSOLUTE cliPath. It could never match, so the fleet was unstoppable through
// its own CLI — the check was not protecting anything, only refusing everything.

/** The guard, extracted so the real command lines below can be run through it. */
function matcher() {
  const source = readFileSync('services/hafleet-services.mjs', 'utf-8');
  const start = source.indexOf('function supervisorCommandMatches');
  const body = source.slice(start, source.indexOf('\n}', start));
  const logic = body.slice(body.indexOf('const relativeCli'), body.indexOf('} catch'));
  return new Function('path', 'command', 'cliPath', 'runtimeRoot', `${logic}`);
}

const RUNTIME = '/srv/hafleet';
const CLI = `${RUNTIME}/services/hafleet-services.mjs`;
const run = (command) => matcher()(path, command, CLI, RUNTIME);

describe('the supervisor is recognised however it was launched', () => {
  test('the exact command line observed on a fleet host matches', () => {
    expect(run(`node services/hafleet-services.mjs run --profile ${RUNTIME}/services-macos.json --runtime ${RUNTIME}\n`)).toBe(true);
  });

  test('an absolute launch still matches', () => {
    expect(run(`node ${CLI} run --profile ${RUNTIME}/services-macos.json --runtime ${RUNTIME}\n`)).toBe(true);
  });

  test('a different process on the same host does not match', () => {
    // The guard exists to avoid SIGTERMing a recycled pid. It must still say no.
    expect(run(`node scripts/hafleet-acp-agent.mjs --name octos-agent --runtime ${RUNTIME}\n`)).toBe(false);
    expect(run('/usr/bin/vim services/hafleet-services.mjs\n')).toBe(false);
  });

  test('the same CLI for a different runtime root does not match', () => {
    expect(run('node services/hafleet-services.mjs run --profile p.json --runtime /Users/other/hafleet\n')).toBe(false);
  });

  test('a status invocation is not mistaken for the running supervisor', () => {
    expect(run(`node services/hafleet-services.mjs status --profile p.json --runtime ${RUNTIME}\n`)).toBe(false);
  });

  test('a cli outside the runtime root does not fall back to a loose match', () => {
    // path.relative would be "../..", which must not be searched for in the
    // command line — every absolute path contains it somewhere.
    const outside = new Function('path', 'command', 'cliPath', 'runtimeRoot',
      readFileSync('services/hafleet-services.mjs', 'utf-8')
        .match(/const relativeCli[\s\S]*?return namesThisCli[^;]*;/)[0]);
    expect(outside(path, `node /opt/hafleet/services/hafleet-services.mjs run --runtime ${RUNTIME}\n`,
      '/opt/hafleet/services/hafleet-services.mjs', RUNTIME)).toBe(true);
    expect(outside(path, `node something-else run --runtime ${RUNTIME}\n`,
      '/opt/hafleet/services/hafleet-services.mjs', RUNTIME)).toBe(false);
  });
});
