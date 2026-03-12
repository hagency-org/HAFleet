// Stale data directory guard — import and call early in entry points
import { existsSync, readdirSync } from 'fs';
import path from 'path';

export function assertRuntimeDir(runtimeRoot) {
  if (!runtimeRoot || !existsSync(runtimeRoot)) return;
  // Check if the runtime root itself is a stale backup
  const base = path.basename(runtimeRoot);
  if (/stale.?backup/i.test(base)) {
    throw new Error(`FATAL: runtime root '${runtimeRoot}' appears to be a stale backup directory`);
  }
  // Check for stale-backup siblings of the data dir
  const dataDir = path.join(runtimeRoot, 'data');
  if (existsSync(dataDir)) {
    try {
      const siblings = readdirSync(path.dirname(dataDir));
      const stale = siblings.find(s => /^data[._-]stale/i.test(s));
      if (stale) {
        throw new Error(`FATAL: stale data marker '${path.join(path.dirname(dataDir), stale)}' found — runtime dir may be poisoned`);
      }
    } catch (e) {
      if (e.message.startsWith('FATAL:')) throw e;
    }
  }
}

export function isLocalAgentServer(serverId, localServerId = 'local') {
  const raw = typeof serverId === 'string' ? serverId.trim() : '';
  return !raw || raw === 'local' || raw === localServerId;
}
