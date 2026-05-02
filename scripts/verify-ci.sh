#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "== syntax =="
npm run check:syntax

echo "== cli contract =="
npm run check:cli-contract

echo "== remote package =="
npm run build:remote:check
npm run check:remote-sync
npm run check:remote-package-smoke

echo "== dependency boundary =="
npm run check:dep-isolation

echo "== kernel and cli smoke tests =="
npm run test:kernel

echo "CI verification passed."
