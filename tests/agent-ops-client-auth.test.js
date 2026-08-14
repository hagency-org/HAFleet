import { afterEach, describe, expect, test } from 'vitest';
import canonicalJsonLibrary from 'another-json';
import { generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  agentOpsBodyDigest,
  canonicalAgentOpsJson,
  checkAgentOpsLoopbackRequest,
  loadAgentOpsServerIdentity,
  normalizeAgentOpsLoopbackOrigin,
  normalizeEd25519PublicJwk,
  verifyAgentOpsProof,
  verifyMatrixDeviceSelfSignature,
} from '../lib/agent-ops-client-auth.js';
import { AgentOpsService, openRouter } from '../router/dist/index.js';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Agent Operations authentication primitives', () => {
  test('agent ops canonical proof uses strict Ed25519 JWK and deterministic JSON', () => {
    const pair = generateKeyPairSync('ed25519');
    const publicJwk = pair.publicKey.export({ format: 'jwk' });
    expect(normalizeEd25519PublicJwk(publicJwk)).toEqual(publicJwk);
    expect(canonicalAgentOpsJson({ z: 1, a: { y: 2, x: 1 } }))
      .toBe('{"a":{"x":1,"y":2},"z":1}');
    expect(agentOpsBodyDigest({ b: 2, a: 1 })).toBe(agentOpsBodyDigest({ a: 1, b: 2 }));
    const material = { schema: 'com.hafleet.agent_ops.v1', nonce: 'proof-1' };
    const signature = sign(null, Buffer.from(canonicalAgentOpsJson(material)), pair.privateKey).toString('base64url');
    expect(verifyAgentOpsProof(publicJwk, signature, material)).toBe(true);
    expect(verifyAgentOpsProof({ ...publicJwk, extra: true }, signature, material)).toBe(false);
    expect(verifyAgentOpsProof(publicJwk, signature, { ...material, nonce: 'proof-2' })).toBe(false);
  });

  test('agent ops loopback boundary rejects aliases peers origins and path-bearing config', () => {
    expect(normalizeAgentOpsLoopbackOrigin('http://127.0.0.1:8090')).toBe('http://127.0.0.1:8090');
    expect(normalizeAgentOpsLoopbackOrigin('http://[::1]:8090')).toBe('http://[::1]:8090');
    for (const value of ['http://localhost:8090', 'https://127.0.0.1:8090', 'http://127.0.0.1:8090/path']) {
      expect(() => normalizeAgentOpsLoopbackOrigin(value)).toThrow();
    }
    const request = (remoteAddress, host = '127.0.0.1:8090', origin) => ({
      socket: { remoteAddress },
      headers: { host, ...(origin ? { origin } : {}) },
    });
    expect(checkAgentOpsLoopbackRequest(request('127.0.0.1'), 'http://127.0.0.1:8090')).toMatchObject({ ok: true });
    expect(checkAgentOpsLoopbackRequest(request('10.0.0.4'), 'http://127.0.0.1:8090')).toMatchObject({ ok: false, code: 'loopback_required' });
    expect(checkAgentOpsLoopbackRequest(request('127.0.0.1', 'localhost:8090'), 'http://127.0.0.1:8090')).toMatchObject({ ok: false, code: 'host_mismatch' });
    expect(checkAgentOpsLoopbackRequest(request('127.0.0.1', '127.0.0.1:8090', 'null'), 'http://127.0.0.1:8090')).toMatchObject({ ok: false, code: 'browser_origin_forbidden' });
  });

  test('agent ops server identity is persistent pinned and mode 0600', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-ops-identity-'));
    roots.push(root);
    const identityPath = path.join(root, 'identity.json');
    const first = loadAgentOpsServerIdentity(identityPath);
    const second = loadAgentOpsServerIdentity(identityPath);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(statSync(identityPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(identityPath, 'utf8')).private_key_pkcs8_pem).toContain('PRIVATE KEY');
    chmodSync(identityPath, 0o644);
    expect(() => loadAgentOpsServerIdentity(identityPath)).toThrow(/must not be accessible/);
  });

  test('server identity rotation fences every previously issued scoped session', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-ops-rotation-'));
    roots.push(root);
    const router = openRouter({ dbPath: path.join(root, 'router.db') });
    try {
      const service = new AgentOpsService(router);
      expect(service.bindServerIdentity('sha256:first')).toEqual({ rotated: false, revokedScopes: 0 });
      const client = generateKeyPairSync('ed25519');
      const scope = {
        ownerMxid: '@owner:example.org', ownerDmRoomId: '!owner:example.org',
        projectRoomId: '!project:example.org', stableAgentId: 'agent-stable', agentName: 'worker',
      };
      const device = {
        matrixDeviceId: 'DEVICE',
        matrixDeviceEd25519: Buffer.alloc(32, 4).toString('base64'),
        matrixDeviceCurve25519: Buffer.alloc(32, 5).toString('base64'),
      };
      expect(service.enrollDevice({ ...scope, ...device })).toMatchObject({ ok: true });
      const grant = service.issueGrant({
        ...scope, ...device, matrixEventId: '$rotation-bootstrap', clientNonce: 'rotation-client',
        clientPublicJwk: client.publicKey.export({ format: 'jwk' }), audience: 'http://127.0.0.1:8090',
      });
      expect(grant).toMatchObject({ ok: true });
      const session = service.exchangeGrant({
        grantJti: grant.grantJti, clientNonce: grant.clientNonce,
        serverChallenge: grant.serverChallenge, audience: grant.audience,
      });
      expect(session).toMatchObject({ ok: true });
      expect(service.bindServerIdentity('sha256:second')).toEqual({ rotated: true, revokedScopes: 1 });
      expect(service.sessionProofDescriptor({
        clientSessionId: session.clientSessionId,
        sessionCapability: session.sessionCapability,
        audience: 'http://127.0.0.1:8090',
      })).toMatchObject({ ok: false, code: 'auth_fence_stale' });
    } finally {
      router.close();
    }
  });

  test('Matrix bootstrap device self-signature binds owner device and curve key', () => {
    const ownerMxid = '@owner:example.org';
    const deviceId = 'DEVICE1';
    const pair = generateKeyPairSync('ed25519');
    const publicJwk = pair.publicKey.export({ format: 'jwk' });
    const ed25519 = Buffer.from(publicJwk.x, 'base64url').toString('base64').replace(/=+$/u, '');
    const curve25519 = Buffer.alloc(32, 5).toString('base64').replace(/=+$/u, '');
    const unsignedDevice = {
      user_id: ownerMxid,
      device_id: deviceId,
      algorithms: ['m.megolm.v1.aes-sha2'],
      keys: {
        [`ed25519:${deviceId}`]: ed25519,
        [`curve25519:${deviceId}`]: curve25519,
      },
    };
    const selfSignature = sign(
      null,
      Buffer.from(canonicalJsonLibrary.stringify(unsignedDevice)),
      pair.privateKey,
    ).toString('base64');
    const device = {
      ...unsignedDevice,
      signatures: { [ownerMxid]: { [`ed25519:${deviceId}`]: selfSignature } },
      unsigned: { device_display_name: 'Owner laptop' },
    };
    expect(verifyMatrixDeviceSelfSignature({ device, ownerMxid, deviceId, curve25519Key: curve25519 }))
      .toEqual({ deviceId, ed25519, curve25519 });
    expect(verifyMatrixDeviceSelfSignature({ device, ownerMxid, deviceId, curve25519Key: 'wrong' })).toBeNull();
    expect(verifyMatrixDeviceSelfSignature({ device: { ...device, user_id: '@other:example.org' }, ownerMxid, deviceId, curve25519Key: curve25519 })).toBeNull();
  });
});
