import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';

const BASELINE = 'security/audit-baseline.json';

describe('dependency advisory ratchet', () => {
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf-8'));

  test('baseline is well formed', () => {
    expect(Array.isArray(baseline.advisories)).toBe(true);
    expect(baseline.advisories.length).toBeGreaterThan(0);
    for (const entry of baseline.advisories) {
      expect(entry.id, JSON.stringify(entry)).toMatch(/^GHSA-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      expect(entry.severity).toMatch(/^(critical|high|moderate|low|info|unknown)$/);
      expect(typeof entry.package).toBe('string');
    }
  });

  test('advisory ids are unique', () => {
    const ids = baseline.advisories.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('baseline explains that it records debt rather than approving it', () => {
    // The distinction from KNOWN_UNFIXABLE_GHSAS is load-bearing; if this text
    // is lost, the next reader may treat the file as a safety judgement.
    const comment = JSON.stringify(baseline.$comment || '');
    expect(comment).toMatch(/not approval|NOT yet triaged|ratchet/i);
  });

  test('the ratchet is wired into CI as a blocking step', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf-8');
    expect(ci).toContain('npm run audit:baseline');
    // continue-on-error would make it non-blocking and pointless.
    expect(ci).not.toMatch(/audit:baseline[\s\S]{0,200}continue-on-error/);
  });

  test('audit scripts are exposed via npm', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    expect(pkg.scripts['audit:baseline']).toBe('node scripts/audit-baseline.mjs');
    expect(pkg.scripts['audit:baseline:update']).toBe('node scripts/audit-baseline.mjs --update');
    // The stricter gate still exists and is still separate.
    expect(pkg.scripts['audit:deps']).toBeTruthy();
  });

  test('unfixable-allowlist and baseline remain distinct mechanisms', () => {
    const script = readFileSync('scripts/audit-deps.sh', 'utf-8');
    const allowlisted = [...script.matchAll(/"(GHSA-[0-9A-Z-]+)"/g)].map((m) => m[1].toUpperCase());
    // Small, hand-reviewed list. If someone bulk-pastes the baseline into it,
    // the "reviewed and unfixable" claim silently becomes false.
    expect(allowlisted.length).toBeLessThan(10);
    expect(allowlisted.length).toBeLessThan(baseline.advisories.length);
  });

  test('dependabot watches the ecosystems that produce this debt', () => {
    const dependabot = readFileSync('.github/dependabot.yml', 'utf-8');
    expect(dependabot).toContain('package-ecosystem: npm');
    expect(dependabot).toContain('package-ecosystem: github-actions');
    // Majors must not be auto-grouped: they can break the MCP tool surface.
    expect(dependabot).toMatch(/update-types:\s*\["minor",\s*"patch"\]/);
  });
});
