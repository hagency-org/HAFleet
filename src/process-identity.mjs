import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getProcessStartIdentity(pid) {
  if (!pidAlive(pid)) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(/\s+/);
    const startTicks = fields[19];
    return startTicks ? `proc:${startTicks}` : null;
  } catch {}
  try {
    const value = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 1000,
    }).trim();
    return value ? `ps:${value}` : null;
  } catch {
    return null;
  }
}

export function processIdentityMatches(record) {
  const expected = String(record?.processStartIdentity || '');
  return Boolean(expected) && getProcessStartIdentity(Number(record?.pid)) === expected;
}
