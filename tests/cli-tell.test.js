import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import { createServer } from 'http';
import path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

// `hafleet tell` is the only way a human can message an agent: `hafleet send`
// types into a pane and refuses outside tmux, and POST /api/messages rejects any
// sender that is not a registered agent.
//
// It posts two fields. `full` goes to the inbox; `summary` is what the relay
// actually types into the agent's pane. So the summary is not a label — it is the
// instruction the agent reads and acts on. The first version cut it to 72
// characters, and a 73-character message arrived as "CODEX-FINA". The agent did
// exactly what it was told, which was the wrong thing, and nothing anywhere
// reported an error.
//
// These drive the real CLI against a stub API and assert on the body it sends.

const CLI = path.resolve('bin/hafleet-cli');
let server;
let received = [];
let api;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  api = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

/**
 * Run the real CLI against the stub and return the JSON body it posted.
 *
 * Async on purpose: the stub server runs in this process, and execFileSync would
 * block the event loop so the server could never answer. The CLI would then sit
 * there until curl's own timeout fired, which looks exactly like a server bug.
 */
async function tell(...args) {
  received = [];
  await run('bash', [CLI, 'tell', ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HAFLEET_API: api, API_TOKEN: 'test-token' },
  });
  expect(received.length, 'CLI posted nothing').toBe(1);
  return received[0];
}

describe('hafleet tell', () => {
  test('posts to /api/messages as the exempt "system" sender', async () => {
    // The backend has always exempted "system"; nothing exposed it until now.
    const { url, body } = await tell('agent-x', 'hello there');
    expect(url).toBe('/api/messages');
    expect(body.from).toBe('system');
    expect(body.to).toBe('agent-x');
    expect(body.type).toBe('task');
  });

  test('a short message reaches the pane whole', async () => {
    // The regression: this is the field the agent reads.
    const message = 'write CODEX-FINAL to /tmp/proof.txt and reply with the sha256 of the file';
    expect(message.length).toBeGreaterThan(72); // the old cutoff
    const { body } = await tell('agent-x', message);
    expect(body.summary).toBe(message);
    expect(body.full).toBe(message);
  });

  test.each([1, 71, 72, 73, 100, 239, 240])('a %i-character message is not truncated', async (n) => {
    // 72/73 bracket the original bug; 239/240 bracket the current boundary.
    const message = 'x'.repeat(n);
    const { body } = await tell('agent-x', message);
    expect(body.summary).toBe(message);
  });

  test('multi-word arguments are joined, not just the first taken', async () => {
    const { body } = await tell('agent-x', 'run', 'the', 'full', 'test', 'suite');
    expect(body.full).toBe('run the full test suite');
  });

  test('an over-long message keeps the whole text and marks the summary partial', async () => {
    // Truncation is still necessary somewhere, so it must be visible. An agent
    // that can see the text is partial will read the rest with check_inbox
    // instead of acting on a sentence that stops mid-thought.
    const message = `${'word '.repeat(80)}TAIL`;
    const { body } = await tell('agent-x', message);
    expect(body.full).toBe(message);
    expect(body.summary).not.toBe(message);
    expect(body.summary.endsWith('…'), 'truncation must be visible').toBe(true);
    expect(body.summary.length).toBeLessThanOrEqual(241);
  });

  test('truncation lands on a word boundary, never mid-word', async () => {
    const message = `${'alpha bravo charlie delta '.repeat(20)}omega`;
    const { body } = await tell('agent-x', message);
    const cut = body.summary.slice(0, -1); // drop the ellipsis
    expect(message.startsWith(cut)).toBe(true);
    // The character in the full text right after the cut must be whitespace,
    // otherwise a word was split.
    expect(message[cut.length]).toMatch(/\s/);
  });

  test('quotes and newlines survive as data rather than breaking the JSON', async () => {
    // The body is assembled with string interpolation, so the escaping is
    // load-bearing. A raw quote here would produce invalid JSON and a 400.
    const message = 'say "done" then\nnewline and a \\ backslash';
    const { body } = await tell('agent-x', message);
    expect(body.full).toBe(message);
  });

  test('an empty message is refused instead of posting a blank instruction', async () => {
    let failed = false;
    let stderr = '';
    try {
      execFileSync('bash', [CLI, 'tell', 'agent-x', '   '], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HAFLEET_API: api, API_TOKEN: 'test-token' },
      });
    } catch (error) {
      failed = true;
      stderr = String(error.stderr || '');
    }
    expect(failed).toBe(true);
    expect(stderr).toMatch(/Usage: hafleet-cli tell/);
  });
});
