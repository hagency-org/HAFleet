#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function run(cmd, args = []) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function resolvePackage(pkg) {
  try {
    return require.resolve(`${pkg}/package.json`);
  } catch {
    return null;
  }
}

function listMatrixNativePackages() {
  const scopeDir = path.join(process.cwd(), 'node_modules', '@matrix-org');
  if (!existsSync(scopeDir)) return [];
  try {
    return readdirSync(scopeDir)
      .filter((name) => name.startsWith('matrix-sdk-crypto-nodejs'))
      .sort();
  } catch {
    return [];
  }
}

function detectInstallMode() {
  if (process.env.AGENTCHAT_INSTALL_MODE) return process.env.AGENTCHAT_INSTALL_MODE;
  const ignoreScripts = process.env.npm_config_ignore_scripts;
  if (ignoreScripts === 'true') return 'npm ci --ignore-scripts';
  if (ignoreScripts === 'false') return 'npm ci';
  return 'unknown';
}

function tryRequire(pkg) {
  try {
    require(pkg);
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error).split('\n')[0],
    };
  }
}

const commit = run('git', ['rev-parse', '--short', 'HEAD']) || 'unknown';
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown';
const dirty = run('git', ['status', '--porcelain']) ? 'yes' : 'no';
const npmVersion = run('npm', ['--version']) || 'unknown';
const matrixBotSdk = resolvePackage('matrix-bot-sdk');
const matrixNativePackages = listMatrixNativePackages();
const matrixNativeLoad = tryRequire('@matrix-org/matrix-sdk-crypto-nodejs');

console.log('== ci environment ==');
console.log(`git: ${branch}@${commit} dirty=${dirty}`);
console.log(`platform: ${os.platform()} ${os.release()} ${os.arch()}`);
console.log(`node: ${process.version}`);
console.log(`npm: ${npmVersion}`);
console.log(`install_mode: ${detectInstallMode()}`);
console.log(`agentchat_install_mode: ${process.env.AGENTCHAT_INSTALL_MODE || 'unset'}`);
console.log(`npm_config_ignore_scripts: ${process.env.npm_config_ignore_scripts || 'unset'}`);
console.log(`matrix_bot_sdk: ${matrixBotSdk ? 'present' : 'missing'}`);
console.log(`matrix_native_optional: ${matrixNativePackages.length ? matrixNativePackages.join(',') : 'none'}`);
console.log(`matrix_native_loadable: ${matrixNativeLoad.ok ? 'yes' : `no (${matrixNativeLoad.error})`}`);
