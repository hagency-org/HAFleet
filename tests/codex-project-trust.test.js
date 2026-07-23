import { describe, expect, test } from 'vitest';
import { ensureCodexProjectTrustText } from '../lib/codex-project-trust.js';

const cwd = '/tmp/agent_wf_codex/workdir';
const header = `[projects."${cwd}"]`;

describe('Codex project trust preparation', () => {
  test('keeps one trusted section unchanged', () => {
    const input = `${header}\ntrust_level = "trusted"\n`;
    expect(ensureCodexProjectTrustText(input, cwd)).toEqual({
      content: input,
      status: 'already',
    });
  });

  test('adds or updates the exact project section', () => {
    expect(ensureCodexProjectTrustText('', cwd)).toEqual({
      content: `${header}\ntrust_level = "trusted"\n`,
      status: 'updated',
    });
    expect(ensureCodexProjectTrustText(`${header}\ntrust_level = "untrusted"\n`, cwd)).toEqual({
      content: `${header}\ntrust_level = "trusted"\n`,
      status: 'updated',
    });
  });

  test('repairs identical duplicate sections before Codex parses the file', () => {
    const duplicate = `${header}\ntrust_level = "trusted"\n\n${header}\ntrust_level = "trusted"\n`;
    expect(ensureCodexProjectTrustText(duplicate, cwd)).toEqual({
      content: `${header}\ntrust_level = "trusted"\n\n`,
      status: 'deduplicated',
    });
  });

  test('refuses to merge conflicting duplicate sections', () => {
    const conflict = `${header}\ntrust_level = "trusted"\n\n${header}\ntrust_level = "untrusted"\n`;
    expect(() => ensureCodexProjectTrustText(conflict, cwd))
      .toThrow('conflicting duplicate Codex project trust sections');
  });
});
