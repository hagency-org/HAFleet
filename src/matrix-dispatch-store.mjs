import {
  chmodSync,
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
    if (written <= 0) throw new Error('short write to Matrix dispatch journal');
    offset += written;
  }
}

function parseRecord(line, journalPath, lineNumber) {
  let record;
  try {
    record = JSON.parse(line);
  } catch (error) {
    throw new Error(`invalid Matrix dispatch journal ${journalPath} at line ${lineNumber}: ${error.message}`);
  }
  try {
    if (!['reserved', 'accepted', 'committed'].includes(record?.status)) {
      throw new Error('status must be reserved, accepted, or committed');
    }
    const status = record.status;
    if (!record?.message || typeof record.message !== 'object' || Array.isArray(record.message)) {
      throw new Error('message must be an object');
    }
    const eventId = normalizeId(record.eventId, 'eventId');
    const messageId = normalizeId(record.messageId, 'messageId');
    if (record.message.id !== messageId) throw new Error('message.id does not match messageId');
    if (record.message.sourceEventId !== eventId) throw new Error('message.sourceEventId does not match eventId');
    return {
      eventId,
      messageId,
      status,
      message: record.message,
      dispatch: record.dispatch && typeof record.dispatch === 'object' ? record.dispatch : {},
      response: record.response && typeof record.response === 'object' ? record.response : null,
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
    };
  } catch (error) {
    throw new Error(`invalid Matrix dispatch journal ${journalPath} at line ${lineNumber}: ${error.message}`);
  }
}

export class MatrixDispatchStore {
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
        throw new Error(`invalid Matrix dispatch journal ${this.journalPath} at line ${index + 1}: blank record`);
      }
      const record = parseRecord(lines[index], this.journalPath, index + 1);
      const previous = this.records.get(record.eventId);
      if (previous && previous.messageId !== record.messageId) {
        throw new Error(`invalid Matrix dispatch journal ${this.journalPath} at line ${index + 1}: messageId changed`);
      }
      if (previous && JSON.stringify(previous.message) !== JSON.stringify(record.message)) {
        throw new Error(`invalid Matrix dispatch journal ${this.journalPath} at line ${index + 1}: message changed`);
      }
      const ranks = { reserved: 0, accepted: 1, committed: 2 };
      if (previous && ranks[record.status] < ranks[previous.status]) {
        throw new Error(`invalid Matrix dispatch journal ${this.journalPath} at line ${index + 1}: status rollback`);
      }
      this.records.set(record.eventId, record);
    }
  }

  get(eventId) {
    const normalized = typeof eventId === 'string' ? eventId.trim() : '';
    return normalized ? (this.records.get(normalized) || null) : null;
  }

  reserve({ eventId, messageId, message, dispatch = {}, response = null }) {
    const normalizedEventId = normalizeId(eventId, 'eventId');
    const existing = this.records.get(normalizedEventId);
    if (existing) return existing;
    const record = {
      eventId: normalizedEventId,
      messageId: normalizeId(messageId, 'messageId'),
      status: 'reserved',
      message,
      dispatch,
      response,
      updatedAt: new Date().toISOString(),
    };
    this._append(record);
    return record;
  }

  commit(eventId, response) {
    const normalizedEventId = normalizeId(eventId, 'eventId');
    const existing = this.records.get(normalizedEventId);
    if (!existing) throw new Error(`Matrix dispatch event is not reserved: ${normalizedEventId}`);
    if (existing.status === 'committed') return existing;
    if (existing.status !== 'accepted') {
      throw new Error(`Matrix dispatch event is not accepted: ${normalizedEventId}`);
    }
    const record = {
      ...existing,
      status: 'committed',
      response: response && typeof response === 'object' ? response : existing.response,
      updatedAt: new Date().toISOString(),
    };
    this._append(record);
    return record;
  }

  accept(eventId, response) {
    const normalizedEventId = normalizeId(eventId, 'eventId');
    const existing = this.records.get(normalizedEventId);
    if (!existing) throw new Error(`Matrix dispatch event is not reserved: ${normalizedEventId}`);
    if (existing.status !== 'reserved') return existing;
    const record = {
      ...existing,
      status: 'accepted',
      response: response && typeof response === 'object' ? response : existing.response,
      updatedAt: new Date().toISOString(),
    };
    this._append(record);
    return record;
  }

  _append(record) {
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
    this.records.set(record.eventId, record);
  }
}
