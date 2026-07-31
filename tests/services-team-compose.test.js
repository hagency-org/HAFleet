import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const composePath = path.resolve('services/services-team.compose.yml');
const dockerfilePath = path.resolve('services/Dockerfile');

describe('services-team Compose contract', () => {
  test('defines exactly four durable host-network services', () => {
    const compose = readFileSync(composePath, 'utf8');
    const servicesSection = compose.split('\nvolumes:\n', 1)[0];
    const serviceNames = [...servicesSection.matchAll(/^  ([a-z][a-z-]+):$/gm)].map((match) => match[1]);

    expect(serviceNames).toEqual(['backend', 'dashboard', 'bridge', 'relay']);
    expect(compose.match(/restart: unless-stopped/g)).toHaveLength(4);
    expect(compose.match(/network_mode: host/g)).toHaveLength(4);
    expect(compose.match(/read_only: true/g)).toHaveLength(4);
    expect(compose.match(/hafleet-runtime:\/var\/lib\/hafleet/g)).toHaveLength(4);
    expect(compose).toMatch(/^volumes:\n  hafleet-runtime:$/m);
  });

  test('uses backend health as the startup dependency', () => {
    const compose = readFileSync(composePath, 'utf8');

    expect(compose).toMatch(/backend:[\s\S]*healthcheck:[\s\S]*_matrix|backend:[\s\S]*healthcheck:/);
    expect(compose.match(/condition: service_healthy/g)).toHaveLength(3);
    expect(compose).toMatch(/command: \["node", "backend-v2\.js"\]/);
    expect(compose).toMatch(/command: \["node", "server\.js"\]/);
    expect(compose).toMatch(/command: \["services\/run-bridge-container\.sh"\]/);
    expect(compose).toMatch(/command: \["node", "push-relay\.js"\]/);
    expect(compose).toMatch(/PUSH_RELAY_MODE: local/);
    expect(compose).toContain('$${process.env.HAFLEET_BACKEND_PORT || 8090}');
    expect(compose).toContain('$${process.env.HAFLEET_WEB_PORT || 8084}');
  });

  test('contains no literal credentials and requires an operator env file', () => {
    const compose = readFileSync(composePath, 'utf8');

    expect(compose).toMatch(/env_file:\n\s+- \$\{HAFLEET_ENV_FILE:-\.\.\/\.env\}/);
    expect(compose).not.toMatch(/(?:API_TOKEN|PASSWORD|SECRET|AS_TOKEN|HS_TOKEN):\s*[A-Za-z0-9]/);
    expect(compose).not.toContain('change-me');
    expect(compose).not.toContain('dev-token');
    expect(compose).not.toMatch(/^\s+HAFLEET_(?:API|WEB_URL):/m);
  });

  test('serializes bridge ownership with a crash-safe container lock', () => {
    const compose = readFileSync(composePath, 'utf8');
    const dockerfile = readFileSync(dockerfilePath, 'utf8');

    expect(compose).toMatch(/command: \["services\/run-bridge-container\.sh"\]/);
    expect(compose).toMatch(/bridge:[\s\S]*?command: \["services\/run-bridge-container\.sh"\][\s\S]*?pid: host/);
    const wrapper = readFileSync(path.resolve('services/run-bridge-container.sh'), 'utf8');
    expect(wrapper).toMatch(/flock --nonblock 9/);
    expect(wrapper).toMatch(/prepare-bridge-container\.mjs/);
    expect(wrapper).not.toMatch(/rm -f .*bridge-owner\.lock/);
    expect(dockerfile).toMatch(/apt-get install[^\n]*util-linux/);
  });

  test('builds a non-root Node 22 production image', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8');

    expect(dockerfile).toMatch(/^FROM node:22-bookworm-slim$/m);
    expect(dockerfile).toMatch(/npm ci --omit=dev/);
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/\/var\/lib\/hafleet/);
    expect(dockerfile).not.toMatch(/(?:API_TOKEN|PASSWORD|SECRET)=/);
  });
});
