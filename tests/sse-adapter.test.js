import { describe, expect, test, vi } from 'vitest';
import { createSseAdapter } from '../lib/backend/sse-adapter.js';

describe('backend SSE adapter', () => {
  test('broadcast drops throwing clients and continues to healthy clients', () => {
    const adapter = createSseAdapter();
    const frames = [];
    const badClient = { write: () => { throw new Error('closed'); } };
    const goodClient = { write: (frame) => frames.push(frame) };
    adapter.clients.add(badClient);
    adapter.clients.add(goodClient);

    expect(() => adapter.broadcast('message', { ok: true })).not.toThrow();

    expect(adapter.clients.has(badClient)).toBe(false);
    expect(adapter.clients.has(goodClient)).toBe(true);
    expect(frames).toEqual([
      'event: message\ndata: {"ok":true}\n\n',
    ]);
  });

  test('keepalive drops throwing clients without stopping the interval callback', () => {
    const adapter = createSseAdapter({ keepaliveMs: 1000 });
    const frames = [];
    const interval = vi.fn((callback) => {
      callback();
      return 'interval-id';
    });
    const badClient = { write: () => { throw new Error('closed'); } };
    const goodClient = { write: (frame) => frames.push(frame) };
    adapter.clients.add(badClient);
    adapter.clients.add(goodClient);

    expect(adapter.startKeepalive(interval)).toBe('interval-id');

    expect(interval).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(adapter.clients.has(badClient)).toBe(false);
    expect(adapter.clients.has(goodClient)).toBe(true);
    expect(frames).toEqual([':\n\n']);
  });
});
