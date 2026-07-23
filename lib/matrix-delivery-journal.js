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
    if (written <= 0) throw new Error('short write to Matrix delivery journal');
    offset += written;
  }
}

function normalizeId(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 255) throw new Error(`${field} must be 1..255 characters`);
  return text;
}

function normalizeOptionalId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeId(value, field);
}

function parseRecord(line, journalPath, lineNumber) {
  let value;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`invalid Matrix delivery journal ${journalPath} at line ${lineNumber}: ${error.message}`);
  }
  try {
    const state = value?.state === 'committed' ? 'committed' : value?.state === 'pending' ? 'pending' : null;
    if (!state) throw new Error('state must be pending or committed');
    return {
      messageId: normalizeId(value?.messageId, 'messageId'),
      roomId: normalizeId(value?.roomId, 'roomId'),
      primaryEventId: normalizeId(value?.primaryEventId, 'primaryEventId'),
      threadRootEventId: normalizeOptionalId(value?.threadRootEventId, 'threadRootEventId'),
      state,
      updatedAt: typeof value?.updatedAt === 'string' && value.updatedAt
        ? value.updatedAt
        : new Date(0).toISOString(),
    };
  } catch (error) {
    throw new Error(`invalid Matrix delivery journal ${journalPath} at line ${lineNumber}: ${error.message}`);
  }
}

function sameDelivery(left, right) {
  return left.messageId === right.messageId
    && left.roomId === right.roomId
    && left.primaryEventId === right.primaryEventId
    && left.threadRootEventId === right.threadRootEventId;
}

export class MatrixDeliveryJournal {
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
        throw new Error(`invalid Matrix delivery journal ${this.journalPath} at line ${index + 1}: blank record`);
      }
      const record = parseRecord(lines[index], this.journalPath, index + 1);
      const previous = this.records.get(record.messageId);
      if (previous && !sameDelivery(previous, record)) {
        throw new Error(`invalid Matrix delivery journal ${this.journalPath} at line ${index + 1}: primary delivery changed`);
      }
      if (previous?.state === 'committed' && record.state !== 'committed') {
        throw new Error(`invalid Matrix delivery journal ${this.journalPath} at line ${index + 1}: committed delivery regressed`);
      }
      this.records.set(record.messageId, record);
    }
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
    this.records.set(record.messageId, record);
    return record;
  }

  get(messageId) {
    const normalized = typeof messageId === 'string' ? messageId.trim() : '';
    return normalized ? (this.records.get(normalized) || null) : null;
  }

  pending() {
    return [...this.records.values()].filter((record) => record.state === 'pending');
  }

  recordPending({ messageId, roomId, primaryEventId, threadRootEventId = null }) {
    const candidate = {
      messageId: normalizeId(messageId, 'messageId'),
      roomId: normalizeId(roomId, 'roomId'),
      primaryEventId: normalizeId(primaryEventId, 'primaryEventId'),
      threadRootEventId: normalizeOptionalId(threadRootEventId, 'threadRootEventId'),
      state: 'pending',
      updatedAt: new Date().toISOString(),
    };
    const existing = this.records.get(candidate.messageId);
    if (existing) {
      if (!sameDelivery(existing, candidate)) {
        throw new Error(`primary Matrix delivery already recorded for ${candidate.messageId}`);
      }
      return existing;
    }
    return this._append(candidate);
  }

  markCommitted(messageId) {
    const normalized = normalizeId(messageId, 'messageId');
    const existing = this.records.get(normalized);
    if (!existing) throw new Error(`pending Matrix delivery not found for ${normalized}`);
    if (existing.state === 'committed') return existing;
    return this._append({
      ...existing,
      state: 'committed',
      updatedAt: new Date().toISOString(),
    });
  }
}
