#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { AGENT_OPS_CONTRACT, AGENT_OPS_ERROR_CODES, AGENT_OPS_LIMITS } from '../router/dist/index.js';
import { agentOpsGrantProofMaterial, agentOpsSessionProofMaterial } from '../lib/agent-ops-client-auth.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(repoRoot, 'specs', 'fixtures', 'agent-ops-client-v1');
const manifestPath = path.join(fixtureRoot, 'manifest.json');
const writeManifest = process.argv.includes('--write-development-manifest');

function json(name) {
  return JSON.parse(readFileSync(path.join(fixtureRoot, name), 'utf8'));
}

function digest(name) {
  return createHash('sha256').update(readFileSync(path.join(fixtureRoot, name))).digest('hex');
}

function fail(message) {
  console.error(`[agent-ops-contract] ${message}`);
  process.exitCode = 1;
}

const names = readdirSync(fixtureRoot)
  .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
  .sort();

const schema = json('contract.schema.json');
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
for (const name of names) {
  if (['contract.schema.json', 'stable-errors.json', 'protocol-limits.json'].includes(name)) continue;
  const valid = validate(json(name));
  if (name.startsWith('invalid-')) {
    if (valid) fail(`${name} is a negative fixture but matches the canonical schema`);
  } else if (!valid) {
    fail(`${name} does not match the canonical schema: ${JSON.stringify(validate.errors)}`);
  }
}

const errors = json('stable-errors.json');
if (errors.schema !== AGENT_OPS_CONTRACT
    || JSON.stringify(errors.codes) !== JSON.stringify(AGENT_OPS_ERROR_CODES)) {
  fail('stable-errors.json does not match the Router AgentOpsService error vocabulary');
}
const limits = json('protocol-limits.json');
if (limits.schema !== AGENT_OPS_CONTRACT
    || JSON.stringify(limits.limits) !== JSON.stringify(AGENT_OPS_LIMITS)) {
  fail('protocol-limits.json does not match the Router AgentOpsService limits');
}
const exchange = json('grant-exchange-request.json');
const expectedGrantProof = agentOpsGrantProofMaterial({
  grantJti: exchange.grant_jti,
  clientNonce: exchange.client_nonce,
  serverChallenge: exchange.server_challenge,
  proofNonce: 'grant-proof-nonce-fixture-1',
  method: 'POST',
  requestPath: '/api/agent-ops/v1/session/exchange',
  body: exchange,
  audience: exchange.audience,
});
if (JSON.stringify(json('grant-proof-material.json')) !== JSON.stringify(expectedGrantProof)) {
  fail('grant-proof-material.json does not match the canonical signing algorithm');
}
const expectedSessionProof = agentOpsSessionProofMaterial({
  clientSessionId: 'client-session-fixture-1',
  proofNonce: 'session-proof-nonce-fixture-1',
  method: 'GET',
  requestPath: '/api/agent-ops/v1/snapshot',
  body: null,
  audience: exchange.audience,
});
if (JSON.stringify(json('session-proof-material.json')) !== JSON.stringify(expectedSessionProof)) {
  fail('session-proof-material.json does not match the canonical signing algorithm');
}

if (writeManifest) {
  const manifest = {
    contract: AGENT_OPS_CONTRACT,
    release_status: 'development',
    source_commit: null,
    artifacts: names.map((name) => ({ path: name, sha256: digest(name) })),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  fail(`manifest.json is missing or invalid: ${error.message}`);
  process.exit();
}

if (manifest.contract !== AGENT_OPS_CONTRACT) fail('manifest contract id is wrong');
if (!['development', 'released'].includes(manifest.release_status)) fail('manifest release_status is invalid');
if (manifest.release_status === 'development' && manifest.source_commit !== null) {
  fail('development manifest source_commit must be null');
}
if (manifest.release_status === 'released'
    && (typeof manifest.source_commit !== 'string' || !/^[a-f0-9]{40,64}$/.test(manifest.source_commit))) {
  fail('released manifest must bind an immutable source commit');
}
const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
if (JSON.stringify(artifacts.map((item) => item.path)) !== JSON.stringify(names)) {
  fail('manifest artifact list does not exactly match the canonical fixture directory');
}
for (const item of artifacts) {
  if (item.sha256 !== digest(item.path)) fail(`artifact digest mismatch: ${item.path}`);
}

if (!process.exitCode) {
  console.log(`[agent-ops-contract] PASS (${artifacts.length} artifacts, ${manifest.release_status})`);
}
