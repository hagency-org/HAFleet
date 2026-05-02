import { afterEach, describe, expect, test } from 'vitest';
import { execFile } from 'child_process';
import { createServer } from 'http';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve('.');
const verifyRemoteBin = path.join(repoRoot, 'bin', 'verify-remote');
const serversPath = '/api/servers';

const openServers = [];

async function startFakeBackend(handler) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      Promise.resolve(handler(req, Buffer.concat(chunks).toString('utf8')))
        .then((result = {}) => {
          const status = result.status || 200;
          const body = result.body === undefined ? {} : result.body;
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(typeof body === 'string' ? body : JSON.stringify(body));
        })
        .catch((err) => {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
        });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.push(server);
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function closeFakeBackends() {
  while (openServers.length) {
    const server = openServers.pop();
    await new Promise((resolve) => server.close(resolve));
  }
}

function runVerifyRemote(args, options = {}) {
  return execFileAsync(verifyRemoteBin, args, {
    cwd: repoRoot,
    timeout: options.timeout || 8000,
    env: {
      ...process.env,
      AGENTCHAT_INTERNAL_DISPATCH: '1',
      API_TOKEN: '',
      AGENT_CHAT_API: '',
      AGENT_CHAT_SERVER: '',
      ...options.env,
    },
  });
}

describe('verify-remote cli', () => {
  afterEach(async () => {
    await closeFakeBackends();
  });

  test('passes when server heartbeat advances and version matches', async () => {
    let serverSamples = 0;
    const api = await startFakeBackend((req) => {
      if (req.url === serversPath) {
        serverSamples += 1;
        return {
          body: [
            {
              id: 'remote-a',
              online: true,
              lastSeen: 1000 + serverSamples,
              agentCount: 3,
              sourceIp: '127.0.0.1',
              version: 'abc1234',
            },
          ],
        };
      }
      return { status: 404, body: { error: 'not found' } };
    });

    const { stdout } = await runVerifyRemote([
      '--no-service',
      '--api', api,
      '--server', 'remote-a',
      '--samples', '2',
      '--interval', '1',
      '--expect-version', 'abc1234',
      '--service', 'definitely-missing',
    ]);

    expect(stdout).toContain('sample 1/2');
    expect(stdout).toContain('sample 2/2');
    expect(stdout).toContain('version=abc1234');
    expect(stdout).toContain('verify-remote passed.');
  });

  test('fails when expected version does not match loaded server version', async () => {
    const api = await startFakeBackend((req) => {
      if (req.url === serversPath) {
        return {
          body: [{ id: 'remote-a', online: true, lastSeen: 1000, agentCount: 1, version: 'old9999' }],
        };
      }
      return { status: 404, body: { error: 'not found' } };
    });

    await expect(runVerifyRemote([
      '--no-service',
      '--api', api,
      '--server', 'remote-a',
      '--samples', '1',
      '--interval', '1',
      '--expect-version', 'new0000',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining('version mismatch: expected=new0000, got=old9999'),
    });
  });

  test('fails when heartbeat lastSeen does not increase across samples', async () => {
    const api = await startFakeBackend((req) => {
      if (req.url === serversPath) {
        return {
          body: [{ id: 'remote-a', online: true, lastSeen: 1000, agentCount: 1, version: 'abc1234' }],
        };
      }
      return { status: 404, body: { error: 'not found' } };
    });

    await expect(runVerifyRemote([
      '--no-service',
      '--api', api,
      '--server', 'remote-a',
      '--samples', '2',
      '--interval', '1',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining('lastSeen not increasing: prev=1000, now=1000'),
    });
  });

  test('passes agent check when the agent belongs to the verified server', async () => {
    const api = await startFakeBackend((req) => {
      if (req.url === serversPath) {
        return {
          body: [{ id: 'remote-a', online: true, lastSeen: 1000, agentCount: 1, version: 'abc1234' }],
        };
      }
      if (req.url === '/api/agents/salt') {
        return {
          body: {
            name: 'salt',
            healthy: true,
            server: 'remote-a',
            serverOnline: true,
            serverLastSeen: 1000,
          },
        };
      }
      return { status: 404, body: { error: 'not found' } };
    });

    const { stdout } = await runVerifyRemote([
      '--no-service',
      '--api', api,
      '--server', 'remote-a',
      '--agent', 'salt',
      '--samples', '1',
      '--interval', '1',
      '--expect-version', 'abc1234',
    ]);

    expect(stdout).toContain('agent check passed: name=salt server=remote-a');
  });

  test('fails agent check when the agent belongs to a different server', async () => {
    const api = await startFakeBackend((req) => {
      if (req.url === serversPath) {
        return {
          body: [{ id: 'remote-a', online: true, lastSeen: 1000, agentCount: 1, version: 'abc1234' }],
        };
      }
      if (req.url === '/api/agents/salt') {
        return {
          body: {
            name: 'salt',
            healthy: true,
            server: 'remote-b',
            serverOnline: true,
            serverLastSeen: 1000,
          },
        };
      }
      return { status: 404, body: { error: 'not found' } };
    });

    await expect(runVerifyRemote([
      '--no-service',
      '--api', api,
      '--server', 'remote-a',
      '--agent', 'salt',
      '--samples', '1',
      '--interval', '1',
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining('Agent salt server mismatch: expected remote-a, got remote-b'),
    });
  });
});
