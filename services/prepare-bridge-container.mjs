#!/usr/bin/env node

import os from 'node:os';

import { prepareBridgeContainerOwnership } from '../src/bridge-container-owner.mjs';

const runtimeRoot = process.env.AGENT_CHAT_RUNTIME_DIR || '/var/lib/agent-chat';
prepareBridgeContainerOwnership({ runtimeRoot, hostname: os.hostname() });
