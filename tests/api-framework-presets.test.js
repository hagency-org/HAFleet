import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'fs';
import path from 'path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function presetsPath(runtimeDir) {
  return path.join(runtimeDir, 'data', 'framework-presets.json');
}

function makePreset(overrides = {}) {
  return {
    id: 'preset_existing',
    name: 'Existing preset',
    framework: 'codex',
    provider: 'openai',
    model: 'gpt-5.2',
    reasoning: 'medium',
    extraArgs: null,
    apiBaseUrl: null,
    apiKey: 'existing-secret',
    ...overrides,
  };
}

describe('framework presets api', () => {
  let context = null;

  afterEach(() => {
    context?.cleanup();
    context = null;
  });

  test('creates, updates, and deletes presets durably', async () => {
    context = await createBackendTestContext('api-framework-presets-test-', {
      frameworkPresets: [],
    });

    const create = await request(context.app)
      .post('/api/framework-presets')
      .send({
        name: 'Codex high',
        framework: 'codex',
        provider: 'openai',
        model: 'gpt-5.2',
        reasoning: 'high',
        apiKey: 'secret',
      });

    expect(create.status).toBe(200);
    expect(create.body.ok).toBe(true);
    expect(create.body.preset.name).toBe('Codex high');
    expect(create.body.preset.apiKey).toBe(true);
    const id = create.body.preset.id;
    let stored = readJson(presetsPath(context.runtimeDir));
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('Codex high');
    expect(stored[0].apiKey).toBe('secret');

    const update = await request(context.app)
      .put(`/api/framework-presets/${id}`)
      .send({
        name: 'Codex medium',
        framework: 'codex',
        provider: 'openai',
        model: 'gpt-5.2',
        reasoning: 'medium',
      });

    expect(update.status).toBe(200);
    expect(update.body.preset.name).toBe('Codex medium');
    expect(update.body.preset.apiKey).toBe(true);
    stored = readJson(presetsPath(context.runtimeDir));
    expect(stored[0].name).toBe('Codex medium');
    expect(stored[0].apiKey).toBe('secret');

    const remove = await request(context.app).delete(`/api/framework-presets/${id}`);
    expect(remove.status).toBe(200);
    expect(remove.body.preset.name).toBe('Codex medium');
    expect(readJson(presetsPath(context.runtimeDir))).toEqual([]);
  });

  test('creation returns 503 and leaves no visible preset when preset persistence fails', async () => {
    context = await createBackendTestContext('api-framework-presets-test-', {
      frameworkPresets: [],
    });
    context.internals.setJsonSaveFailureForTest('framework-presets.json', true);

    const response = await request(context.app)
      .post('/api/framework-presets')
      .send({ name: 'Non durable preset', framework: 'codex' });
    const list = await request(context.app).get('/api/framework-presets');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'framework preset persistence failed' });
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
    expect(readJson(presetsPath(context.runtimeDir))).toEqual([]);
  });

  test('update returns 503 and restores visible preset when preset persistence fails', async () => {
    const original = makePreset();
    context = await createBackendTestContext('api-framework-presets-test-', {
      frameworkPresets: [original],
    });
    context.internals.setJsonSaveFailureForTest('framework-presets.json', true);

    const response = await request(context.app)
      .put('/api/framework-presets/preset_existing')
      .send({
        name: 'Volatile preset',
        framework: 'codex',
        provider: 'openai',
        model: 'gpt-5.4',
        reasoning: 'high',
        apiKey: 'volatile-secret',
      });
    const list = await request(context.app).get('/api/framework-presets');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'framework preset persistence failed' });
    expect(list.body).toEqual([{ ...original, apiKey: true }]);
    expect(readJson(presetsPath(context.runtimeDir))).toEqual([original]);
  });

  test('delete returns 503 and restores visible preset when preset persistence fails', async () => {
    const original = makePreset();
    context = await createBackendTestContext('api-framework-presets-test-', {
      frameworkPresets: [original],
    });
    context.internals.setJsonSaveFailureForTest('framework-presets.json', true);

    const response = await request(context.app).delete('/api/framework-presets/preset_existing');
    const list = await request(context.app).get('/api/framework-presets');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'framework preset persistence failed' });
    expect(list.body).toEqual([{ ...original, apiKey: true }]);
    expect(readJson(presetsPath(context.runtimeDir))).toEqual([original]);
  });
});
