import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

function fsyncPath(targetPath) {
  const fd = openSync(targetPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function secureDirectory(directory) {
  const missing = [];
  let current = path.resolve(directory);
  while (!existsSync(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const created of missing.reverse()) {
    chmodSync(created, 0o700);
    fsyncPath(created);
    fsyncPath(path.dirname(created));
  }
  chmodSync(directory, 0o700);
  fsyncPath(directory);
}

function writeAllSync(fd, value) {
  const bytes = Buffer.from(value, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('short write to Matrix event journal');
    offset += written;
  }
}

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
    secureDirectory(path.dirname(this.journalPath));
    chmodSync(this.journalPath, 0o600);
    fsyncPath(this.journalPath);
    const bytes = readFileSync(this.journalPath);
    let completeLength = bytes.length;
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
      completeLength = bytes.lastIndexOf(0x0a) + 1;
      truncateSync(this.journalPath, completeLength);
      fsyncPath(this.journalPath);
      fsyncPath(path.dirname(this.journalPath));
    }
    if (completeLength === 0) return;
    const lines = bytes.subarray(0, completeLength - 1).toString('utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index]) {
        throw new Error(`invalid Matrix event journal ${this.journalPath} at line ${index + 1}: blank record`);
      }
      const record = parseRecord(lines[index], this.journalPath, index + 1);
      const previous = this.records.get(record.eventId);
      if (previous && previous.messageId !== record.messageId) {
        throw new Error(`invalid Matrix event journal ${this.journalPath} at line ${index + 1}: messageId changed`);
      }
      if (!previous) this.records.set(record.eventId, record);
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
    const directory = path.dirname(this.journalPath);
    secureDirectory(directory);
    const created = !existsSync(this.journalPath);
    const fd = openSync(this.journalPath, 'a', 0o600);
    try {
      chmodSync(this.journalPath, 0o600);
      writeAllSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (created) fsyncPath(directory);
    this.records.set(normalizedEventId, record);
    return record;
  }
}
