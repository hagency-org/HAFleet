import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';

// Node services that shell out to tmux and own the runtime tree.
const NODE_UNITS = [
  'hafleet-backend.service',
  'hafleet.service',
  'hafleet-push-relay.service',
  'bridge-matrix.service',
];

const AUTODEPLOY_UNIT = 'hafleet-stable-autodeploy.service';
const ALL_UNITS = [...NODE_UNITS, AUTODEPLOY_UNIT];

// Sandboxing every long-lived Node service must carry.
const REQUIRED_SANDBOX = [
  'NoNewPrivileges=yes',
  'ProtectSystem=full',
  'ProtectKernelTunables=yes',
  'ProtectKernelModules=yes',
  'ProtectKernelLogs=yes',
  'ProtectControlGroups=yes',
  'ProtectClock=yes',
  'ProtectHostname=yes',
  'RestrictSUIDSGID=yes',
  'RestrictRealtime=yes',
  'RestrictNamespaces=yes',
  'LockPersonality=yes',
  'CapabilityBoundingSet=',
  'SystemCallArchitectures=native',
];

// Directives that would break this deployment if anyone "helpfully" adds them.
//   PrivateTmp  - hides tmux's /tmp/tmux-<uid> server socket.
//   ProtectHome - the runtime tree (WorkingDirectory, data/, logs/) is under $HOME.
const FORBIDDEN_EVERYWHERE = ['PrivateTmp', 'ProtectHome'];

/** Parse a unit file into { section: [ 'Key=value', ... ] }. */
function parseUnit(name) {
  const sections = {};
  let current = null;
  for (const rawLine of readFileSync(name, 'utf-8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = /^\[(.+)\]$/.exec(line);
    if (sectionMatch) {
      current = sectionMatch[1];
      sections[current] = sections[current] || [];
      continue;
    }
    if (current) sections[current].push(line);
  }
  return sections;
}

const directiveKeys = (entries) => (entries || []).map((entry) => entry.split('=')[0]);

describe('systemd unit hardening', () => {
  test.each(NODE_UNITS)('%s carries the full sandbox set', (unit) => {
    const service = parseUnit(unit).Service || [];
    for (const directive of REQUIRED_SANDBOX) {
      expect(service, `${unit} is missing ${directive}`).toContain(directive);
    }
  });

  test.each(NODE_UNITS)('%s sets resource limits and a stop timeout', (unit) => {
    const keys = directiveKeys(parseUnit(unit).Service);
    expect(keys, `${unit} is missing LimitNOFILE`).toContain('LimitNOFILE');
    expect(keys, `${unit} is missing MemoryHigh`).toContain('MemoryHigh');
    expect(keys, `${unit} is missing TimeoutStopSec`).toContain('TimeoutStopSec');
  });

  test.each(ALL_UNITS)('%s omits directives that break tmux or the home tree', (unit) => {
    const keys = directiveKeys(parseUnit(unit).Service);
    for (const directive of FORBIDDEN_EVERYWHERE) {
      expect(keys, `${unit} sets ${directive}, which breaks this deployment`).not.toContain(directive);
    }
  });

  test.each(ALL_UNITS)('%s declares restart rate limits in [Unit], not [Service]', (unit) => {
    const sections = parseUnit(unit);
    const unitKeys = directiveKeys(sections.Unit);
    const serviceKeys = directiveKeys(sections.Service);
    // systemd reads StartLimit* from [Unit]; in [Service] they are ignored.
    expect(unitKeys, `${unit} is missing StartLimitIntervalSec`).toContain('StartLimitIntervalSec');
    expect(unitKeys, `${unit} is missing StartLimitBurst`).toContain('StartLimitBurst');
    expect(serviceKeys).not.toContain('StartLimitIntervalSec');
    expect(serviceKeys).not.toContain('StartLimitBurst');
  });

  test.each(ALL_UNITS)('%s never runs as root', (unit) => {
    const service = parseUnit(unit).Service || [];
    expect(service).not.toContain('User=root');
    expect(service).not.toContain('Group=root');
    expect(service, `${unit} must declare a User=`).toContain('User=__USER__');
  });

  describe(AUTODEPLOY_UNIT, () => {
    test('enables the release gate so untested commits cannot deploy', () => {
      const service = parseUnit(AUTODEPLOY_UNIT).Service || [];
      expect(service).toContain('Environment=HAFLEET_RELEASE_GATE=worktree');
      expect(service).not.toContain('Environment=HAFLEET_RELEASE_GATE=none');
    });

    test('omits the three directives that would break sudo escalation', () => {
      // It runs unprivileged and reaches systemctl through a narrow sudoers
      // rule. NoNewPrivileges and RestrictSUIDSGID block setuid binaries, and
      // an empty CapabilityBoundingSet strips what sudo needs to escalate.
      const service = parseUnit(AUTODEPLOY_UNIT).Service || [];
      expect(service).not.toContain('NoNewPrivileges=yes');
      expect(service).not.toContain('RestrictSUIDSGID=yes');
      expect(service).not.toContain('CapabilityBoundingSet=');
    });

    test('still carries the sandboxing that is compatible with sudo', () => {
      const service = parseUnit(AUTODEPLOY_UNIT).Service || [];
      for (const directive of [
        'ProtectSystem=full',
        'ProtectKernelTunables=yes',
        'ProtectKernelModules=yes',
        'LockPersonality=yes',
        'SystemCallArchitectures=native',
      ]) {
        expect(service, `${AUTODEPLOY_UNIT} is missing ${directive}`).toContain(directive);
      }
    });
  });
});

describe('autodeploy release gate default', () => {
  test('script defaults to the gate ON', () => {
    const script = readFileSync('scripts/hafleet-stable-autodeploy.sh', 'utf-8');
    expect(script).toContain('RELEASE_GATE="${HAFLEET_RELEASE_GATE:-worktree}"');
    expect(script).not.toContain('RELEASE_GATE="${HAFLEET_RELEASE_GATE:-none}"');
  });

  test('systemctl calls escalate via sudo when unprivileged', () => {
    const script = readFileSync('scripts/hafleet-stable-autodeploy.sh', 'utf-8');
    expect(script).toContain('sudo -n "$SYSTEMCTL_BIN"');
    // An explicitly overridden binary (tests, custom harnesses) bypasses sudo.
    expect(script).toContain('[ -n "${HAFLEET_SYSTEMCTL_BIN:-}" ]');
  });
});

describe('documented install source', () => {
  test.each(['README.md', 'README.zh-CN.md'])('%s clones this fork, not upstream', (readme) => {
    const text = readFileSync(readme, 'utf-8');
    expect(text).toContain('github.com/hagency-org/HAFleet.git');
    expect(text).not.toContain('git clone https://github.com/shisuiki/agent-chat.git');
  });
});
