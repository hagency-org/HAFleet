import { randomBytes } from 'crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import path from 'path';

const STORE_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 100;

function requiredText(value, field, max = 255) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max) {
    throw new Error(`${field} must be 1..${max} characters`);
  }
  return normalized;
}

function normalizeRecord(value) {
  const event = value?.event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('event must be an object');
  }
  const eventId = requiredText(event.event_id ?? value.eventId, 'event_id');
  const roomId = requiredText(value.roomId, 'room_id');
  if (event.type !== 'm.room.encrypted') {
    throw new Error('only encrypted room events can be queued');
  }
  return {
    eventId,
    roomId,
    event: { ...event, event_id: eventId },
    receivedAt: Number.isFinite(value.receivedAt) ? Math.floor(value.receivedAt) : Date.now(),
  };
}

export class PendingEncryptedEventStore {
  constructor(filePath, options = {}) {
    this.filePath = path.resolve(filePath);
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0
      ? Math.floor(options.maxAgeMs)
      : DEFAULT_MAX_AGE_MS;
    this.maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0
      ? Math.floor(options.maxEntries)
      : DEFAULT_MAX_ENTRIES;
    this.records = this._load();
  }

  _load() {
    if (!existsSync(this.filePath)) return new Map();
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    const records = new Map();
    for (const value of Array.isArray(parsed?.records) ? parsed.records : []) {
      const record = normalizeRecord(value);
      records.set(record.eventId, record);
    }
    return records;
  }

  _save() {
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    let fd = null;
    try {
      writeFileSync(temporary, `${JSON.stringify({
        version: STORE_VERSION,
        records: [...this.records.values()],
      }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      fd = openSync(temporary, 'r');
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temporary, this.filePath);
      chmodSync(this.filePath, 0o600);
      fd = openSync(directory, 'r');
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
    } catch (error) {
      if (fd !== null) {
        try { closeSync(fd); } catch {}
      }
      try { unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  put(input) {
    const record = normalizeRecord({ ...input, receivedAt: input?.receivedAt ?? this.now() });
    if (this.records.has(record.eventId)) return this.records.get(record.eventId);
    this.prune({ persist: false });
    if (this.records.size >= this.maxEntries) {
      throw new Error(`pending encrypted event capacity exceeded (${this.maxEntries})`);
    }
    this.records.set(record.eventId, record);
    this._save();
    return record;
  }

  list() {
    return [...this.records.values()].sort((left, right) => left.receivedAt - right.receivedAt);
  }

  remove(eventId) {
    const normalized = typeof eventId === 'string' ? eventId.trim() : '';
    if (!normalized || !this.records.delete(normalized)) return false;
    this._save();
    return true;
  }

  prune({ persist = true } = {}) {
    const cutoff = this.now() - this.maxAgeMs;
    const removed = [];
    for (const record of this.records.values()) {
      if (record.receivedAt > cutoff) continue;
      this.records.delete(record.eventId);
      removed.push(record);
    }
    if (persist && removed.length > 0) this._save();
    return removed;
  }
}
