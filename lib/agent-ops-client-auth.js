import canonicalJsonLibrary from 'another-json';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const AGENT_OPS_CLIENT_SCHEMA = 'com.hafleet.agent_ops.v1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]']);
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
    return output;
  }
  return value;
}

export function canonicalAgentOpsJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function agentOpsBodyDigest(value) {
  return createHash('sha256').update(canonicalAgentOpsJson(value ?? null)).digest('hex');
}

function strictBase64Url(value, field, max = 8192) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error(`${field} must be unpadded base64url`);
  }
  return normalized;
}

export function normalizeEd25519PublicJwk(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('client_public_jwk must be an object');
  }
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'crv,kty,x') throw new Error('client_public_jwk must contain exactly crv, kty and x');
  if (value.kty !== 'OKP' || value.crv !== 'Ed25519') throw new Error('client_public_jwk must use Ed25519');
  const x = strictBase64Url(value.x, 'client_public_jwk.x', 128);
  if (Buffer.from(x, 'base64url').length !== 32) throw new Error('client_public_jwk.x must encode 32 bytes');
  const jwk = { kty: 'OKP', crv: 'Ed25519', x };
  createPublicKey({ key: jwk, format: 'jwk' });
  return jwk;
}

export function verifyAgentOpsProof(publicJwk, signatureValue, material) {
  try {
    const jwk = normalizeEd25519PublicJwk(publicJwk);
    const signature = Buffer.from(strictBase64Url(signatureValue, 'proof', 512), 'base64url');
    if (signature.length !== 64) return false;
    return verify(
      null,
      Buffer.from(canonicalAgentOpsJson(material)),
      createPublicKey({ key: jwk, format: 'jwk' }),
      signature,
    );
  } catch {
    return false;
  }
}

export function agentOpsGrantProofMaterial({
  grantJti,
  clientNonce,
  serverChallenge,
  proofNonce,
  method,
  requestPath,
  body,
  audience,
}) {
  return {
    schema: AGENT_OPS_CLIENT_SCHEMA,
    kind: 'grant_exchange',
    grant_jti: grantJti,
    client_nonce: clientNonce,
    server_challenge: serverChallenge,
    proof_nonce: proofNonce,
    http_method: String(method || '').toUpperCase(),
    request_path: requestPath,
    body_sha256: agentOpsBodyDigest(body),
    audience,
  };
}

export function agentOpsSessionProofMaterial({
  clientSessionId,
  proofNonce,
  method,
  requestPath,
  body,
  audience,
}) {
  return {
    schema: AGENT_OPS_CLIENT_SCHEMA,
    kind: 'session_request',
    client_session_id: clientSessionId,
    proof_nonce: proofNonce,
    http_method: String(method || '').toUpperCase(),
    request_path: requestPath,
    body_sha256: agentOpsBodyDigest(body),
    audience,
  };
}

export function parseAgentOpsSessionAuthorization(header) {
  const raw = typeof header === 'string' ? header.trim() : '';
  const match = /^AgentOps\s+([A-Za-z0-9_-]{32,1024})$/.exec(raw);
  return match ? match[1] : null;
}

export function normalizeAgentOpsLoopbackOrigin(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('HAFLEET_AGENT_OPS_LOOPBACK_ORIGIN must be an absolute loopback URL');
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || !url.port || url.username || url.password) {
    throw new Error('HAFLEET_AGENT_OPS_LOOPBACK_ORIGIN must be http on explicit 127.0.0.1 or [::1] port');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('HAFLEET_AGENT_OPS_LOOPBACK_ORIGIN must not contain path, query, or fragment');
  }
  return url.origin;
}

function normalizedPeer(address) {
  const value = typeof address === 'string' ? address.trim().toLowerCase() : '';
  if (value.startsWith('::ffff:127.')) return value.slice('::ffff:'.length);
  return value;
}

export function checkAgentOpsLoopbackRequest(req, configuredOrigin) {
  const origin = normalizeAgentOpsLoopbackOrigin(configuredOrigin);
  const expected = new URL(origin);
  const peer = normalizedPeer(req?.socket?.remoteAddress);
  if (!(peer === '::1' || /^127(?:\.\d{1,3}){3}$/.test(peer))) {
    return { ok: false, code: 'loopback_required', message: 'Agent Operations V1 is available only from loopback' };
  }
  const host = typeof req?.headers?.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
  if (host !== expected.host.toLowerCase()) {
    return { ok: false, code: 'host_mismatch', message: 'Agent Operations Host does not match the configured audience' };
  }
  if (req?.headers?.origin !== undefined) {
    return { ok: false, code: 'browser_origin_forbidden', message: 'Browser Origin requests are not accepted by Agent Operations V1' };
  }
  return { ok: true, audience: origin };
}

function atomicWritePrivateJson(filePath, value) {
  const resolved = path.resolve(filePath);
  const directory = path.dirname(resolved);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  let fd = null;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    fd = openSync(temporary, 'r');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, resolved);
    chmodSync(resolved, 0o600);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    throw error;
  }
}

function publicKeyFingerprint(jwk) {
  return `sha256:${createHash('sha256').update(canonicalAgentOpsJson(jwk)).digest('base64url')}`;
}

export function loadAgentOpsServerIdentity(filePath) {
  const resolved = path.resolve(filePath);
  let stored = null;
  if (existsSync(resolved)) {
    const mode = statSync(resolved).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error('Agent Operations server identity file must not be accessible by group or other users');
    }
    stored = JSON.parse(readFileSync(resolved, 'utf8'));
  } else {
    const pair = generateKeyPairSync('ed25519');
    const publicJwk = pair.publicKey.export({ format: 'jwk' });
    const privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' });
    stored = {
      version: 1,
      algorithm: 'Ed25519',
      public_jwk: publicJwk,
      private_key_pkcs8_pem: String(privatePem),
    };
    atomicWritePrivateJson(resolved, stored);
  }
  if (stored?.version !== 1 || stored?.algorithm !== 'Ed25519' || typeof stored?.private_key_pkcs8_pem !== 'string') {
    throw new Error('Agent Operations server identity file is invalid');
  }
  const publicJwk = normalizeEd25519PublicJwk(stored.public_jwk);
  const privateKey = createPrivateKey(stored.private_key_pkcs8_pem);
  const derived = normalizeEd25519PublicJwk(createPublicKey(privateKey).export({ format: 'jwk' }));
  if (canonicalAgentOpsJson(derived) !== canonicalAgentOpsJson(publicJwk)) {
    throw new Error('Agent Operations server identity public and private keys do not match');
  }
  const fingerprint = publicKeyFingerprint(publicJwk);
  return Object.freeze({
    publicJwk,
    fingerprint,
    sign(material) {
      return sign(null, Buffer.from(canonicalAgentOpsJson(material)), privateKey).toString('base64url');
    },
  });
}

function matrixCanonicalJson(value) {
  return canonicalJsonLibrary.stringify(value);
}

function matrixEd25519PublicKey(rawBase64) {
  const raw = Buffer.from(String(rawBase64 || ''), 'base64');
  if (raw.length !== 32) throw new Error('Matrix Ed25519 key must encode 32 bytes');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function verifyMatrixDeviceSelfSignature({ device, ownerMxid, deviceId, curve25519Key }) {
  try {
    if (!device || typeof device !== 'object' || device.user_id !== ownerMxid || device.device_id !== deviceId) return null;
    const ed25519 = device.keys?.[`ed25519:${deviceId}`];
    const curve25519 = device.keys?.[`curve25519:${deviceId}`];
    const signature = device.signatures?.[ownerMxid]?.[`ed25519:${deviceId}`];
    if (typeof ed25519 !== 'string' || typeof curve25519 !== 'string' || typeof signature !== 'string') return null;
    if (curve25519 !== curve25519Key) return null;
    const signed = JSON.parse(JSON.stringify(device));
    delete signed.signatures;
    delete signed.unsigned;
    const valid = verify(
      null,
      Buffer.from(matrixCanonicalJson(signed)),
      matrixEd25519PublicKey(ed25519),
      Buffer.from(signature, 'base64'),
    );
    return valid ? { deviceId, ed25519, curve25519 } : null;
  } catch {
    return null;
  }
}
