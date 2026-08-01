#!/usr/bin/env node

import os from 'node:os';

import { prepareBridgeContainerOwnership } from '../src/bridge-container-owner.mjs';

const runtimeRoot = process.env.HAFLEET_RUNTIME_DIR || '/var/lib/hafleet';
prepareBridgeContainerOwnership({ runtimeRoot, hostname: os.hostname() });
