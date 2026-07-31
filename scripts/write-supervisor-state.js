#!/usr/bin/env node
import path from 'path';
import { readFileSync } from 'fs';
import { readV1AgentManifest } from '../lib/agent-home-v1.js';

function parseArgs(argv) {
  const args = { command: '' };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!args.command && !t.startsWith('-')) { args.command = t; continue; }
    if (t === '--target' && argv[i + 1]) { args.target = argv[++i]; continue; }
    if (t === '--state' && argv[i + 1]) { args.state = argv[++i]; continue; }
    if (t === '--confidence' && argv[i + 1]) { args.confidence = argv[++i]; continue; }
    if (t === '--reason' && argv[i + 1]) { args.reason = argv[++i]; continue; }
    if (t === '--suggested-action' && argv[i + 1]) { args.suggestedAction = argv[++i]; continue; }
    if (t === '--domain' && argv[i + 1]) { args.domain = argv[++i]; continue; }
    if (t === '--pattern' && argv[i + 1]) { args.pattern = argv[++i]; continue; }
    if (t === '--workdir' && argv[i + 1]) { args.workdir = argv[++i]; continue; }
    if (t === '--web-url' && argv[i + 1]) { args.webUrl = argv[++i]; continue; }
    if (t === '-h' || t === '--help') { args.help = true; continue; }
    throw new Error(`Unknown argument: ${t}`);
  }
  return args;
}

function usage() {
  console.log(`Usage: write-supervisor-state <start|assess|heartbeat|done> [options]

Commands:
  start       Post initial idle assessment
  assess      Post a state assessment
  heartbeat   Renew lease
  done        End supervision session

Options:
  --target <agent>           Target agent name
  --state <state>            focused|drifting|lost|stuck|idle|done
  --confidence <0-1>         Confidence score
  --reason <text>            Assessment reason
  --suggested-action <act>   none|nudge|escalate|interrupt
  --domain <domain>          core|adjacent|outside
  --pattern <pattern>        Drift pattern or null
  --workdir <path>           Agent workdir (default: cwd)
  --web-url <url>            Backend API base URL
`);
}

function resolveWorkdir(raw) {
  if (raw) return path.resolve(raw);
  return process.cwd();
}

function defaultApiBaseUrl(env = process.env) {
  const explicit = String(env.HAFLEET_API || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const port = parseInt(env.HAFLEET_BACKEND_PORT || '8090', 10);
  return `http://127.0.0.1:${port}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.command) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const workdir = resolveWorkdir(args.workdir);
  const manifest = readV1AgentManifest(path.join(workdir, '..'));
  const agentName = manifest?.name || path.basename(path.dirname(workdir));
  const apiBase = args.webUrl || defaultApiBaseUrl();

  // Read agent token
  const agentTokenPath = path.join(workdir, '..', 'state', 'agent-token');
  let agentToken = '';
  try { agentToken = readFileSync(agentTokenPath, 'utf-8').trim(); } catch {}

  const headers = { 'Content-Type': 'application/json' };
  if (agentToken) headers['X-Agent-Token'] = agentToken;

  const target = args.target || '';
  if (!target && args.command !== 'heartbeat') {
    console.error('Error: --target is required');
    process.exit(1);
  }

  async function apiFetch(method, urlPath, body) {
    const url = `${apiBase}${urlPath}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`API error ${res.status}: ${json?.error || res.statusText}`);
      process.exit(1);
    }
    return json;
  }

  switch (args.command) {
    case 'start': {
      const result = await apiFetch('PATCH', `/api/supervisor-state/${target}`, {
        state: 'idle',
        confidence: 0.5,
        reason: 'Supervision session starting',
        suggested_action: 'none',
      });
      console.log(`Supervision started for ${target}`);
      break;
    }

    case 'assess': {
      if (!args.state) { console.error('Error: --state is required for assess'); process.exit(1); }
      const confidence = args.confidence ? parseFloat(args.confidence) : 0.5;
      if (isNaN(confidence) || confidence < 0 || confidence > 1) {
        console.error('Error: --confidence must be between 0 and 1');
        process.exit(1);
      }
      const result = await apiFetch('PATCH', `/api/supervisor-state/${target}`, {
        state: args.state,
        confidence,
        reason: args.reason || '',
        suggested_action: args.suggestedAction || 'none',
        domain: args.domain || null,
        pattern: args.pattern || null,
      });
      console.log(`Assessment posted: ${args.state} (${confidence})`);
      break;
    }

    case 'heartbeat': {
      const hbTarget = target || agentName.replace(/^supervisor-/, '');
      const result = await apiFetch('POST', `/api/supervisor-state/${hbTarget}/heartbeat`, {});
      console.log(`Heartbeat sent for ${hbTarget}`);
      break;
    }

    case 'done': {
      const result = await apiFetch('PATCH', `/api/supervisor-state/${target}`, {
        state: 'done',
        confidence: 1.0,
        reason: 'Supervision session ended',
        suggested_action: 'none',
      });
      console.log(`Supervision ended for ${target}`);
      break;
    }

    default:
      console.error(`Unknown command: ${args.command}`);
      usage();
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
