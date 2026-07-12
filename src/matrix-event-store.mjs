import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

function normalizeId(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 255) throw new Error(`${field} must be 1..255 characters`);
  return text;
}

function parseRecord(value, journalPath, lineNumber) {
  let record;
  try {
    record = JSON.parse(value);
  } catch (error) {
    throw new Error(`invalid Matrix event journal ${journalPath} at line ${lineNumber}: ${error.message}`);
  }
  try {
    return {
      eventId: normalizeId(record?.eventId, 'eventId'),
      messageId: normalizeId(record?.messageId, 'messageId'),
      processedAt: typeof record?.processedAt === 'string' && record.processedAt
        ? record.processedAt
        : new Date(0).toISOString(),
    };
  } catch (error) {
    throw new Error(`invalid Matrix event journal ${journalPath} at line ${lineNumber}: ${error.message}`);
  }
}

export class MatrixEventStore {
  constructor({ journalPath }) {
    this.journalPath = path.resolve(journalPath);
    this.records = new Map();
    this._load();
  }

  _load() {
    if (!existsSync(this.journalPath)) return;
    const bytes = readFileSync(this.journalPath);
    let completeLength = bytes.length;
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
      completeLength = bytes.lastIndexOf(0x0a) + 1;
      truncateSync(this.journalPath, completeLength);
    }
    if (completeLength === 0) return;
    const lines = bytes.subarray(0, completeLength).toString('utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index]) continue;
      const record = parseRecord(lines[index], this.journalPath, index + 1);
      if (!this.records.has(record.eventId)) this.records.set(record.eventId, record);
    }
  }

  has(eventId) {
    const normalized = typeof eventId === 'string' ? eventId.trim() : '';
    return Boolean(normalized) && this.records.has(normalized);
  }

  get(eventId) {
    const normalized = typeof eventId === 'string' ? eventId.trim() : '';
    return normalized ? (this.records.get(normalized) || null) : null;
  }

  recordProcessed({ eventId, messageId }) {
    const normalizedEventId = normalizeId(eventId, 'eventId');
    const existing = this.records.get(normalizedEventId);
    if (existing) return existing;
    const record = {
      eventId: normalizedEventId,
      messageId: normalizeId(messageId, 'messageId'),
      processedAt: new Date().toISOString(),
    };
    mkdirSync(path.dirname(this.journalPath), { recursive: true, mode: 0o700 });
    const fd = openSync(this.journalPath, 'a', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`, null, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.records.set(normalizedEventId, record);
    return record;
  }
}
