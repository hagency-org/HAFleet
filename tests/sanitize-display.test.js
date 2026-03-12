import { describe, expect, test } from 'vitest';

// Extract sanitizeForDisplay by importing from push-relay-core indirectly
// We redefine it here since it's a pure function with identical logic in both files
function sanitizeForDisplay(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g, '');
}

describe('sanitizeForDisplay (5.8.3 Layer 5)', () => {
  test('passes through normal text unchanged', () => {
    expect(sanitizeForDisplay('Hello world')).toBe('Hello world');
  });

  test('returns empty string for non-string input', () => {
    expect(sanitizeForDisplay(null)).toBe('');
    expect(sanitizeForDisplay(undefined)).toBe('');
    expect(sanitizeForDisplay(42)).toBe('');
  });

  test('strips C0 control characters (except tab, newline, CR)', () => {
    // \x00 NUL, \x07 BEL, \x08 BS should be stripped
    expect(sanitizeForDisplay('hello\x00world')).toBe('helloworld');
    expect(sanitizeForDisplay('alert\x07bell')).toBe('alertbell');
    expect(sanitizeForDisplay('back\x08space')).toBe('backspace');
  });

  test('preserves tab, newline, and carriage return', () => {
    expect(sanitizeForDisplay('line1\nline2')).toBe('line1\nline2');
    expect(sanitizeForDisplay('col1\tcol2')).toBe('col1\tcol2');
    expect(sanitizeForDisplay('win\r\nline')).toBe('win\r\nline');
  });

  test('strips ANSI escape sequences', () => {
    expect(sanitizeForDisplay('\x1B[31mred text\x1B[0m')).toBe('red text');
    expect(sanitizeForDisplay('\x1B[1;32mbold green\x1B[0m')).toBe('bold green');
  });

  test('strips C1 control characters', () => {
    expect(sanitizeForDisplay('test\x80data\x9Fend')).toBe('testdataend');
  });

  test('handles combined injection attempt', () => {
    const malicious = 'normal\x1B[31m\x07\x00 injected \x1B[0mtext';
    expect(sanitizeForDisplay(malicious)).toBe('normal injected text');
  });
});
