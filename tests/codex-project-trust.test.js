import { describe, expect, test } from 'vitest';
import { ensureCodexProjectTrustText } from '../lib/codex-project-trust.js';

const cwd = '/tmp/agent_wf_codex/workdir';
const header = `[projects."${cwd}"]`;

describe('Codex project trust preparation', () => {
  test('keeps one trusted section unchanged', () => {
    /*
     * REQ-OWNER-UI-APPROVAL-PROJECT-TRUST: "repeated managed Codex startup MUST leave exactly
     * one parseable trust table". This is the repeat case — the section already exists, and the
     * content comes back byte-identical with status `already`, so restarting a managed agent
     * cannot append a second `[projects."..."]` header that would make the file unparseable.
     */
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
    /*
     * REQ-OWNER-UI-APPROVAL-PROJECT-TRUST, the repair clause: an older IDENTICAL duplicate may
     * be collapsed, and the result asserted here is exactly one section left. Identical is what
     * makes it safe — no trust decision changes, only the duplicate header that a strict TOML
     * parser rejects.
     */
    const duplicate = `${header}\ntrust_level = "trusted"\n\n${header}\ntrust_level = "trusted"\n`;
    expect(ensureCodexProjectTrustText(duplicate, cwd)).toEqual({
      content: `${header}\ntrust_level = "trusted"\n\n`,
      status: 'deduplicated',
    });
  });

  test('refuses to merge conflicting duplicate sections', () => {
    /*
     * REQ-OWNER-UI-APPROVAL-PROJECT-TRUST: "conflicting duplicate content MUST abort startup".
     * Duplicates that disagree mean somebody or something else has an opinion about this
     * project's trust, and the throw refuses to pick a winner. Note the direction of the risk:
     * the losing section here says `untrusted`, so a "last one wins" merge would silently
     * promote a project someone had deliberately distrusted.
     *
     * Scope: this asserts the text transform that the launcher's abort depends on. The
     * file-level `ensureCodexProjectTrustFile` — backup then atomic rename — has no test.
     */
    const conflict = `${header}\ntrust_level = "trusted"\n\n${header}\ntrust_level = "untrusted"\n`;
    expect(() => ensureCodexProjectTrustText(conflict, cwd))
      .toThrow('conflicting duplicate Codex project trust sections');
  });
});
