/*
 * Live UX validation against a REAL backend, in a real browser.
 *
 * Distinct from the other two suites, and the distinction is the point:
 *
 *   check-invariants.mjs  — server-rendered HTML, fixture data. Cannot see
 *                           anything produced by an effect.
 *   check-switches.mjs    — a browser, fixture data. Sees generated content and
 *                           computed styles.
 *   live-ux.mjs (this)    — a browser against a running backend. The only suite
 *                           that can catch a real payload the UI mishandles.
 *
 * WHY THAT THIRD SUITE HAD TO EXIST. Twice in this project an assertion passed
 * while the defect it named was live, because the check could not observe the
 * thing it claimed to check. A fixture cannot expose a field the backend omits —
 * so `presets` having no `ceiling` upstream, which crashes every ceiling cell, is
 * invisible to both suites above by construction.
 *
 * Every check here therefore asserts against the DOM after the data layer has
 * settled, and several assert the ABSENCE of a wrong rendering ("0", "NaN",
 * "undefined") rather than only the presence of a right one — a page that throws
 * during render produces an empty container that a presence-only check reads as
 * "nothing to see".
 *
 * Run:  node scripts/live-ux.mjs
 *       BASE=http://127.0.0.1:3100 BACKEND=http://127.0.0.1:8090 node scripts/live-ux.mjs
 */

import { chromium } from 'playwright-core';
import * as fixture from '../lib/mock-data.js';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const BACKEND = process.env.BACKEND ?? 'http://127.0.0.1:8090';
const TOKEN = process.env.API_TOKEN ?? 'devtoken';
const CHROME = process.env.CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;

let failed = 0;
let ran = 0;
let skipped = 0;
const check = (name, ok, detail = '') => {
  ran += 1;
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/*
 * A check that could not run, reported as such.
 *
 * Distinct from both `ok` and `FAIL`, and counted in the summary, because the one
 * outcome a suite must never produce is a skip that reads like a pass. Used only
 * where the precondition is genuinely outside the suite's control — alerts are
 * raised internally by the liveness sweep and there is no ingest endpoint, so a
 * store whose alerts have all reached a terminal state cannot be replenished from
 * here. Fabricating one would be testing the fabrication.
 */
const skip = (name, why) => {
  skipped += 1;
  console.log(`  SKIP  ${name}  — ${why}`);
};

/** Backend truth, fetched directly so the assertion compares UI against source. */
async function api(path) {
  const res = await fetch(`${BACKEND}/api/${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

/** A write straight to the backend, for setting up state the browser then acts on. */
async function post(path, body) {
  const res = await fetch(`${BACKEND}/api/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}

/*
 * Navigate and wait for the DATA LAYER, not just the network.
 *
 * `networkidle` is not enough: the provider fetches in an effect, so the document
 * can be idle while the page still shows fixture rows. The provenance banner is
 * rendered by the same provider, so waiting for it to stop reporting `loading` is
 * the one signal that means "the live data is in the DOM".
 */
async function open(page, path) {
  const errors = [];
  page.removeAllListeners('pageerror');
  page.removeAllListeners('console');
  page.removeAllListeners('response');
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message ?? e}`));
  // The URL, not just "Failed to load resource" — a bare console message names
  // neither what failed nor whether it mattered, which is how a broken bundle
  // reads the same as a missing favicon.
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const u = r.url();
    if (/favicon|\.ico$|\.png$|\.svg$/.test(u)) return;
    errors.push(`HTTP ${r.status()} ${u.replace(BASE, '')}`);
  });
  page.on('console', (m) => {
    const txt = m.text();
    // Already covered, with the URL, by the response listener above.
    if (m.type() !== 'error' || /Failed to load resource/.test(txt)) return;
    errors.push(`console: ${txt}`);
  });
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="provenance"]:not(.loading)', { timeout: 15000 })
    .catch(() => {});
  await page.waitForTimeout(250);
  return errors;
}

const text = (page, sel) => page.$eval(sel, (el) => el.innerText).catch(() => null);
const all = (page, sel) => page.$$eval(sel, (els) => els.map((e) => e.innerText));

/*
 * THE ANTI-TAUTOLOGY GUARD, and the reason it is a named helper rather than an
 * afterthought.
 *
 * The first run of this suite reported "every live agent name appears" as PASSING
 * while the provenance banner was absent and the page was showing pure fixture
 * data. It passed because the backend had been seeded with the fixture's own
 * names, so the assertion could not tell the two sources apart — the exact
 * shared-oracle failure that let two earlier assertions in this project pass over
 * live defects.
 *
 * The fix is structural, not a stronger assertion: the backend is seeded with
 * names and models that appear NOWHERE in the fixture, and every page-level suite
 * additionally asserts that no fixture-only value is on screen. A fixture
 * fallback now fails loudly instead of masquerading as success.
 */
function assertNotFixture(body, label) {
  const fixtureOnly = [
    ...fixture.agents.map((a) => a.name),
    ...fixture.presets.map((p) => p.name),
  ];
  const leaked = fixtureOnly.filter((v) => body.includes(v));
  check(`${label}: no fixture-only value on screen`, leaked.length === 0, leaked.slice(0, 3).join(' | '));
}

/*
 * THE RAIL, asserted separately because it is on every page and nothing checked it.
 *
 * Two defects hid here at once, and both were invisible against a fixture:
 *
 *  - the roster was a module-level import, so it kept showing the fixture's five
 *    names next to a live table — the same screen disagreeing with itself;
 *  - it filtered on `alive !== false`, which excludes nothing in a fixture where
 *    every agent is alive, and excluded EVERYTHING against a real backend whose
 *    agents are registered but not running. The rail read "AGENTS · 0" beside a
 *    five-row table.
 *
 * So the check is: the rail names exactly the backend's agents, and its count
 * matches. Anything that navigates to content must agree with the content.
 */
async function assertRail(page, agents, label) {
  const rail = await text(page, '.rail');
  if (rail === null) return check(`${label}: rail renders`, false, 'no .rail element');
  const missing = agents.map((a) => a.name).filter((n) => !rail.includes(n));
  check(`${label}: the rail names every live agent`, missing.length === 0, missing.join(' '));
  const head = rail.match(/AGENTS · (\d+)|AGENT · (\d+)/);
  const shown = Number(head?.[1] ?? head?.[2] ?? NaN);
  check(`${label}: the rail's agent count matches the backend`,
    shown === agents.length, `rail=${shown} api=${agents.length}`);
  const fixtureNames = fixture.agents.map((a) => a.name).filter((n) => rail.includes(n));
  check(`${label}: no fixture agent in the rail`, fixtureNames.length === 0, fixtureNames.join(' '));
}

const suites = {};

// ── /resources ──────────────────────────────────────────────────────────────
suites.resources = async (page) => {
  const errors = await open(page, '/resources');
  const agents = await api('agents');
  const presets = await api('framework-presets');

  check('/resources renders with no page error', errors.length === 0, errors.slice(0, 2).join(' | '));

  const banner = await text(page, '[data-testid="provenance"]');
  /*
   * REQ-CONTRIBUTION-CONSOLE-PROVENANCE — provenance is reported PER SLICE, and one slice
   * never implies another. Checked against the live backend rather than a fixture, which is
   * the only way the distinction can be observed: with everything fixture, a per-slice
   * banner and a global one look identical.
   */
  check('provenance names agents and presets as live',
    /live/i.test(banner ?? '') && /agent/i.test(banner ?? '') && /preset|预设/i.test(banner ?? ''),
    banner);
  /*
   * The banner must not claim a source a slice does not have — in either
   * direction, and whichever slices happen to be live today.
   *
   * This assertion has now been wrong twice for the same reason, which is why it is
   * finally written against state rather than against copy. It began as "provenance
   * names ceilings as a contract" with a bare /contract/ regex, and kept passing
   * after ceilings went live because `engagements` was also on the banner and also a
   * contract. Rewritten to name engagements, it then broke when engagements got an
   * endpoint — correctly, but it had to be edited again. A check pinned to which
   * slices are currently unimplemented needs editing every time that changes, so it
   * is pinned to the invariant instead: a contract span appears exactly when some
   * slice on this page has no endpoint.
   */
  const contractSpan = await text(page, '[data-testid="prov-contract"]');
  const liveSlices = ['agents', 'presets', 'seats'];
  const anyContract = (await Promise.all(liveSlices.map(async (s) => {
    try { await api(s === 'presets' ? 'framework-presets' : s); return false; } catch { return true; }
  }))).some(Boolean);
  check('a contract span appears only when a named slice has no endpoint',
    Boolean(contractSpan) === anyContract, `span=${Boolean(contractSpan)} anyMissing=${anyContract}`);

  /*
   * The ROSTER's rows, counted exactly.
   *
   * This selected `table.tbl tbody tr` across the whole page and accepted
   * `>= agents.length`, so the seats and presets tables padded the count and a
   * missing roster row could not fail it. Scoped to the first table — the roster —
   * and compared for equality.
   */
  const rosterRows = await page.$$eval('table.tbl',
    (tables) => (tables[0] ? tables[0].querySelectorAll('tbody tr').length : -1));
  check('the roster has exactly one row per live agent',
    rosterRows === agents.length, `roster=${rosterRows} api=${agents.length}`);

  // Every agent name the backend reports must appear.
  const body = await text(page, 'main');
  const missing = agents.map((a) => a.name).filter((n) => !body.includes(n));
  check('every live agent name appears on the page', missing.length === 0, missing.join(' '));

  // Every resolved model the backend reports must appear. This is the assertion
  // that would have caught a runtimeProfile the UI silently ignored.
  const models = [...new Set(agents
    .map((a) => a.runtimeProfile?.primary?.model)
    .filter(Boolean))];
  const missingModels = models.filter((m) => !body.includes(m));
  check('every resolved model from runtimeProfile is rendered',
    missingModels.length === 0, missingModels.join(' '));

  // The absence assertions. A live preset carries no ceiling, so the ceiling
  // cells must be reasoned blanks — never 0, and never a crash artefact.
  assertNotFixture(body, '/resources');
  await assertRail(page, agents, '/resources');
  check('no NaN anywhere on the page', !/NaN/.test(body));
  check('no literal "null" on /resources', !/\\bnull\\b/.test(body));
  check('no literal "undefined" anywhere on the page', !/undefined/.test(body));
  /*
   * The ceiling, both ways round.
   *
   * This assertion was originally "a preset with no upstream ceiling renders a
   * reason, not 0", written when POST /api/framework-presets dropped the field. It
   * now round-trips, so a one-directional check would silently stop testing
   * anything — the `noCeiling > 0` branch simply never runs. Asserting BOTH states
   * against what the backend actually holds keeps it load-bearing whichever way
   * the field goes.
   */
  const withCeiling = presets.filter((p) => p.ceiling);
  const withoutCeiling = presets.filter((p) => !p.ceiling);
  if (withCeiling.length > 0) {
    // 5000000 renders as "5.0M", so compare on the formatted form the page uses.
    const shown = withCeiling.map((p) => `${(p.ceiling.tokens / 1_000_000).toFixed(1)}M`);
    check('a stored ceiling is rendered as a number',
      shown.some((v) => body.includes(v)), shown.join(' '));
    check('and it is labelled unenforced, since nothing meters',
      /not enforced|未强制/i.test(body));
  }
  if (withoutCeiling.length > 0) {
    check('a preset with no ceiling renders a reason, not 0',
      /no ceiling field upstream|上游没有额度字段/.test(body));
  }
  // Provenance must agree with what the backend actually holds — claiming live for
  // a field no preset carries is the same defect as claiming a contract for one
  // that round-trips, just in the other direction.
  const claimsLiveCeilings = /live[^\n]*ceiling|实时[^\n]*额度/i.test(banner ?? '');
  check('ceilings provenance matches whether any preset carries one',
    claimsLiveCeilings === (withCeiling.length > 0),
    `banner=${claimsLiveCeilings} backend=${withCeiling.length > 0}`);

  /*
   * SEATS — the arithmetic the roster above cannot show.
   *
   * A seat is derived from how agents were launched, so the page must report the
   * SAME grouping the backend derives. And the number that matters is the one the
   * roster hides: what has been promised out of a shared quota. Asserted against
   * GET /api/seats rather than against a figure typed in here.
   */
  const seatPayload = await api('seats');
  const seats = seatPayload.seats ?? [];
  check('every derived seat appears on the page',
    seats.every((s) => body.includes(s.seatId)),
    seats.filter((s) => !body.includes(s.seatId)).map((s) => s.seatId).join(' '));

  const shared = seats.filter((s) => s.members.length > 1);
  if (shared.length > 0) {
    // Two agents, one credential home, two ceilings. The whole point of the seat.
    const s = shared[0];
    check('a shared seat shows the total promised out of it',
      body.includes(`${(s.declaredTokens / 1_000_000).toFixed(1)}M`),
      `${s.members.length} agents declaring ${s.declaredTokens}`);
  } else {
    check('no shared seat in this deployment (vacuous)', true, `${seats.length} seats, all single-agent`);
  }

  const over = seats.filter((s) => s.overSubscribed === true);
  if (over.length > 0) {
    check('an over-subscribed seat says so', /over-subscribed|超配/i.test(body),
      over.map((s) => s.seatId).join(' '));
  }
  const undeclared = seats.filter((s) => s.quotaTokens === null);
  if (undeclared.length > 0) {
    // Unknown, not unlimited, and not zero.
    check('a seat with no declared quota renders a reason',
      /quota not declared|配额未声明/.test(body), `${undeclared.length} undeclared`);
  }
  if (seatPayload.keyed === false) {
    check('an unkeyed seat digest is disclosed as unkeyed',
      /unkeyed|未加密钥/i.test(body));
  }
};

// ── /config ─────────────────────────────────────────────────────────────────
suites.config = async (page) => {
  const errors = await open(page, '/config');
  const presets = await api('framework-presets');
  check('/config renders with no page error', errors.length === 0, errors.slice(0, 2).join(' | '));
  const body = await text(page, 'main');
  const missing = presets.map((p) => p.name).filter((n) => !body.includes(n));
  check('every live preset name appears', missing.length === 0, missing.join(' '));
  assertNotFixture(body, '/config');
  check('no NaN on /config', !/NaN/.test(body));
  check('no literal "null" on /config', !/\\bnull\\b/.test(body));
};

// ── /alerts ─────────────────────────────────────────────────────────────────
suites.alerts = async (page) => {
  /*
   * Snapshot the backend BEFORE navigating.
   *
   * The liveness sweep raises alerts continuously — an offline agent produces one
   * every few sweeps — so fetching after the render compares the page against a
   * list that grew since it loaded, and the suite fails for an alert the page could
   * not have known about. The page is only accountable for what existed when it
   * asked.
   */
  const alerts = await api('alerts?limit=200');
  const errors = await open(page, '/alerts');
  check('/alerts renders with no page error', errors.length === 0, errors.slice(0, 2).join(' | '));
  const body = await text(page, 'main');

  /*
   * The page opens filtered to `open`, so requiring every alert to be on screen
   * asserts something the page never promised — it failed as soon as the write
   * suite acknowledged one. Assert the contract the page actually offers: every
   * OPEN alert is listed, and the count of everything else is reachable.
   */
  const openAlerts = alerts.filter((a) => a.status === 'open');
  const missing = openAlerts.map((a) => a.summary).filter((x) => x && !body.includes(x));
  check('every OPEN alert summary appears under the default filter',
    missing.length === 0, missing.slice(0, 2).join(' | '));
  check('and the status strip counts all five lifecycle states',
    ['open', 'acknowledged', 'assigned', 'resolved', 'suppressed'].every((st) => body.includes(st)));

  /*
   * The downgrade. lib/alert-store.js:125-128 turns a warning/critical with
   * missing actionable fields into `info` and records what was missing. A console
   * that renders only `severity` shows `info` and hides that the system meant
   * something louder — so if any live alert was downgraded, the page must say so.
   */
  const downgraded = openAlerts.filter((a) => a.originalSeverity);
  if (downgraded.length > 0) {
    check('a downgraded alert discloses its original severity',
      new RegExp(downgraded[0].originalSeverity, 'i').test(body),
      `${downgraded.length} downgraded, original=${downgraded[0].originalSeverity}`);
    const field = downgraded[0].missingActionableFields?.[0];
    if (field) {
      /*
       * SELECT the downgraded alert before asking whether the page names what was
       * missing.
       *
       * This asserted against the page as it loads, and passed for two runs by
       * coincidence: the field list lives in the DETAIL panel, which shows the
       * selected alert, and the selection defaults to the highest-severity row. That
       * happened to be a downgraded `agent_offline` until the metering work raised a
       * genuine `warning` that now sorts above it — at which point the assertion
       * failed while the page was doing exactly what the requirement asks. The
       * requirement is "the page names the missing field", not "it names it without
       * being asked", so the check now performs the interaction its subject needs.
       */
      await page.evaluate((summary) => {
        const row = [...document.querySelectorAll('table.tbl tbody tr')]
          .find((tr) => tr.innerText.includes(summary));
        row?.click();
      }, downgraded[0].summary);
      await page.waitForTimeout(150);
      const detail = await text(page, 'main');
      check('and names a field whose absence caused the downgrade',
        detail.includes(field), field);
    }
  } else {
    check('no downgraded alerts to disclose (vacuous)', true, 'none present');
  }
  assertNotFixture(body, '/alerts');
  await assertRail(page, await api('agents'), '/alerts');
  check('no NaN on /alerts', !/NaN/.test(body));
  check('no literal "null" on /alerts', !/\\bnull\\b/.test(body));
};

// ── /capability ─────────────────────────────────────────────────────────────
suites.capability = async (page) => {
  const errors = await open(page, '/capability');
  const agents = await api('agents');
  check('/capability renders with no page error', errors.length === 0, errors.slice(0, 2).join(' | '));
  const body = await text(page, 'main');
  assertNotFixture(body, '/capability');
  check('no NaN on /capability', !/NaN/.test(body));
  /*
   * `null` on screen, alongside NaN and undefined.
   *
   * An offer published through the toggle carries none of its three terms — nothing
   * asks for them yet — and the card printed "offering null, up to null each,
   * null/day". The fixture's offers always had all three, so the branch had never
   * rendered without them. Checked on every page for the same reason NaN is.
   */
  check('no literal "null" on /capability', !/\bnull\b/.test(body));

  /*
   * Role eligibility must follow the resolved model, not the agent name. An agent
   * whose runtimeProfile is absent qualifies for nothing however it is named, and
   * the page has to show that rather than inferring a role from the string.
   */
  const bare = agents.filter((a) => !a.runtimeProfile?.primary?.model);
  if (bare.length > 0) {
    /*
     * The requirement, not a string. An agent with no resolved model qualifies
     * for no role, so the outward-facing catalogue has to NAME it — a reader who
     * counts five agents in the rail and sees four in every role list is left to
     * work out the fifth's status themselves, and "not listed" reads as an
     * oversight rather than a state.
     *
     * Asserted by name rather than by copy so a reworded notice does not silently
     * stop testing this.
     */
    const unnamed = bare.map((a) => a.name).filter((n) => !body.includes(n));
    check('every agent with no resolved model is named on the catalogue',
      unnamed.length === 0, unnamed.join(' '));
    check('and the catalogue states it qualifies for no role',
      /qualify for no role|不符合任何角色/.test(body));
  } else {
    check('no unconfigured agent to report (vacuous)', true);
  }
};

// ── /resources/new — the wizard ─────────────────────────────────────────────
suites.wizard = async (page) => {
  const errors = await open(page, '/resources/new');
  const frameworks = await api('frameworks');
  check('/resources/new renders with no page error', errors.length === 0, errors.slice(0, 2).join(' | '));
  const body = await text(page, 'main');

  const missing = frameworks.map((f) => f.id).filter((id) => !body.includes(id));
  check('every framework from GET /api/frameworks is offered', missing.length === 0, missing.join(' '));

  /*
   * WHAT THE WIZARD MUST WARN ABOUT, and what it must not.
   *
   * The first version of this check asserted that a `launchable: false` manifest was
   * disclosed as unable to launch — which is the defect, not the requirement. Every
   * ACP manifest carries that flag and every reason says "start it with
   * `hafleet acp-up` instead": a different command, not an inability. Warning on it
   * told a contributor their installed, working Octos could not run.
   *
   * The fact worth warning about is what the HOST PROBE knows: not installed here.
   */
  const probe = await api('frameworks/detect');
  const absent = probe.frameworks.filter((f) => f.state === 'absent');
  const installedAcp = probe.frameworks.filter((f) => f.state === 'ready' && f.startWith.includes('acp-up'));

  if (absent.length > 0) {
    check('a framework the probe cannot find is disclosed as not installed',
      /not installed|未安装/i.test(body), absent.map((f) => f.id).join(' '));
  }
  if (installedAcp.length > 0) {
    // The regression this replaces: an installed ACP adapter must NOT be described
    // as unable to launch.
    check('an installed ACP framework is not described as unlaunchable',
      !/cannot launch|not launchable|无法启动/i.test(body),
      installedAcp.map((f) => f.id).join(' '));
  }
  check('no NaN in the wizard', !/NaN/.test(body));
};

// ── /onboard ────────────────────────────────────────────────────────────────
suites.onboard = async (page) => {
  const errors = await open(page, '/onboard');
  const probe = await api('frameworks/detect');
  check('/onboard renders with no page error', errors.length === 0, errors.slice(0, 2).join(' | '));
  const body = await text(page, 'main');
  check('no NaN on /onboard', !/NaN/.test(body));
  check('no literal "null" on /onboard', !/\\bnull\\b/.test(body));

  /*
   * The page must show the HOST PROBE, not the manifest list and not the fixture.
   *
   * Two bugs hid here simultaneously and neither was visible from the markup: the
   * page called `onboardable()` bare, which defaults to the fixture's list, and its
   * sort memo had an empty dependency array, so it captured the fixture default and
   * never recomputed when the probe arrived. The provenance banner said LIVE while
   * the table listed octos 2.0.2 and hermes 0.9.4 — neither of which is installed
   * on this host at all.
   *
   * Asserted on the VERSIONS, because they are the values a fixture cannot guess.
   */
  const versions = probe.frameworks.map((f) => f.version).filter(Boolean);
  const missingV = versions.filter((v) => !body.includes(v));
  check('every probed version string is on the page', missingV.length === 0, missingV.join(' | '));

  const absent = probe.frameworks.filter((f) => !f.onPath);
  if (absent.length > 0) {
    check('a framework that is not on PATH is reported as such, not as ready',
      /not installed|not on PATH|未安装|不在 PATH/i.test(body),
      absent.map((f) => f.id).join(' '));
    // The specific failure this replaces: the fixture asserted octos and hermes
    // were ready with versions. If the page shows a version for something absent,
    // it is reading the fixture again.
    const fixtureOnlyVersions = fixture.detected
      .filter((f) => absent.some((a) => a.id === f.id) && f.version)
      .map((f) => f.version);
    const leaked = fixtureOnlyVersions.filter((v) => body.includes(v));
    check('and carries no fixture version for it', leaked.length === 0, leaked.join(' '));
  }

  // The probe cannot know whether a login is valid, only that a directory exists.
  // Saying otherwise would tell a contributor they are ready when auth will fail.
  check('the credential caveat is disclosed',
    /directory exists|不代表|目录存在/i.test(body) || Boolean(probe.caveat));
};

// ── /usage ──────────────────────────────────────────────────────────────────
suites.usage = async (page) => {
  const errors = await open(page, '/usage');
  check('/usage renders with no page error', errors.length === 0, errors.slice(0, 2).join(' | '));
  const body = await text(page, 'main');
  assertNotFixture(body, '/usage');
  check('no NaN on /usage', !/NaN/.test(body));
  check('no literal "null" on /usage', !/\\bnull\\b/.test(body));
  // The rule the whole page exists to keep.
  check('consumption is a reason, not a zero',
    /not measured|系统未计量/.test(body));

  /*
   * THE PARTITION, asserted against the backend's own declaration.
   *
   * GET /api/usage returns a `metering` block naming each signal's availability.
   * The page has to agree with it in BOTH directions: claiming a measurement the
   * backend does not have is fabrication, and hiding one it does have wastes the
   * only real numbers on the page. Asserted from the payload rather than from
   * strings typed here, so adding a signal cannot silently go unrendered.
   */
  const usage = await api('usage');
  const m = usage.metering ?? {};
  /*
   * TOKENS ARE NOW MEASURED WHERE THE FRAMEWORK RECORDS THEM.
   *
   * This asserted `m.tokens.available === false` — the truth when nothing metered. It is
   * now false only when no agent could be attributed, so asserting it unconditionally
   * would pin the product to a limitation it no longer has. What is invariant is the
   * PARTITION, not the answer: availability is stated per framework, and a figure is
   * either measured or absent with a reason.
   */
  check('token availability is stated per framework, not once for the fleet',
    Array.isArray(m.tokens?.frameworks) && m.tokens.frameworks.every(
      (f) => typeof f.available === 'boolean' && (f.available || typeof f.reason === 'string'),
    ),
    JSON.stringify(m.tokens?.frameworks ?? null).slice(0, 110));
  check('a framework that records no usage says why, rather than reporting a bare false',
    (m.tokens?.frameworks ?? []).filter((f) => !f.available).every((f) => f.reason && f.reason.length > 20),
    (m.tokens?.frameworks ?? []).filter((f) => !f.available).map((f) => f.framework).join(' '));
  /*
   * Never a zero, whichever way availability landed. An unmeasured agent carries null and
   * a reason; a measured one carries a real figure. `0` in that column would be a claim
   * that the agent consumed nothing.
   */
  check('no agent reports a zero token figure',
    (usage.agents ?? []).every((r) => r.tokensUsed === null || r.tokensUsed > 0),
    (usage.agents ?? []).filter((r) => r.tokensUsed === 0).map((r) => r.agent).join(' '));
  check('every unmeasured agent carries a reason',
    (usage.agents ?? []).filter((r) => r.tokensUsed === null).every((r) => typeof r.tokensReason === 'string' && r.tokensReason.length > 20));
  check('a measured agent reports its kinds apart, not one summed figure',
    (usage.agents ?? []).filter((r) => r.tokensUsed !== null)
      .every((r) => r.tokensByKind && typeof r.tokensByKind.cacheRead === 'number'),
    'cache reads run orders of magnitude above fresh input; one figure hides that');
  check('tasks and busy time are declared measured',
    m.tasks?.available === true && m.busyTime?.available === true);
  check('and the page marks them measured, not merely omits the token column',
    /measured|有测量/i.test(body));
  /*
   * A bounded scan understates consumption, so if a bound bit, the payload must say so.
   * Vacuous when the scan was complete, and labelled that way rather than left to imply
   * the bound was tested.
   */
  if (m.tokens?.boundsReason) {
    check('a bounded scan discloses that it understates', /understates/.test(m.tokens.boundsReason));
  } else {
    check('the scan was complete this run (vacuous)', true, 'no bound bit');
  }
  // Every agent the backend measured must have a row.
  const missingRows = (usage.agents ?? []).map((r) => r.agent).filter((n) => !body.includes(n));
  check('every measured agent has a usage row', missingRows.length === 0, missingRows.join(' '));
};

// ── /engagements ────────────────────────────────────────────────────────────
suites.engagements = async (page) => {
  const errors = await open(page, '/engagements');
  check('/engagements renders with no page error', errors.length === 0, errors.slice(0, 2).join(' | '));
  const body = await text(page, 'main');
  assertNotFixture(body, '/engagements');
  check('no NaN on /engagements', !/NaN/.test(body));
  check('no literal "null" on /engagements', !/\\bnull\\b/.test(body));

  /*
   * THE ROUTING, on screen, against the live queue.
   *
   * Three branches, and the one that matters most is `overOffer` / `overCeiling`:
   * a whitelisted project asking for more than is available FALLS BACK to approval
   * rather than being rejected, because it has not misbehaved. That distinction is
   * invisible in a UI that renders both as "declined", so it is asserted on the
   * rendered page and not only in the store's unit tests.
   */
  const { engagements } = await api('engagements');
  const { whitelist } = await api('whitelist');

  const missing = engagements.map((e) => e.project).filter((p, i, a) => a.indexOf(p) === i)
    .filter((p) => !body.includes(p));
  check('every project in the live queue appears', missing.length === 0, missing.join(' '));

  const pending = engagements.filter((e) => e.state === 'pending');
  if (pending.length > 0) {
    // A pending request must state WHY it needs the owner. "Waiting" without a
    // reason gives the operator nothing to decide on.
    check('a pending request states why it needs a decision',
      /not whitelisted|over|未列入白名单|超出/i.test(body),
      pending.map((e) => e.route).join(' '));
    // And it must name the agent whose ceiling would be spent, BEFORE the decision.
    const named = pending.filter((e) => e.agent).every((e) => body.includes(e.agent));
    check('and names the agent that would serve it', named,
      pending.map((e) => e.agent).join(' '));
  }

  const auto = engagements.filter((e) => e.autoJoined);
  if (auto.length > 0) {
    // Listed, not hidden: an auto-approval the owner cannot see afterwards is
    // indistinguishable from a compromise.
    check('auto-joined engagements are listed, not hidden',
      auto.every((e) => body.includes(e.project)), auto.map((e) => e.id).join(' '));
  }

  if (whitelist.length > 0) {
    check('the whitelist is keyed on the room id, shown as such',
      whitelist.every((w) => body.includes(w.projectRoomId)),
      whitelist.map((w) => w.projectRoomId).join(' '));
  }

  const banner = await text(page, '[data-testid="provenance"]');
  check('engagements are labelled live now that the endpoint exists',
    /live|实时/i.test(banner ?? ''), banner);
};

// ── /workforce — the roster ─────────────────────────────────────────────────
/*
 * The roster is a JOIN of six payloads, so it is the page where a wrong join is
 * most likely and least visible: every cell can look plausible while belonging to
 * the wrong agent. Each check below therefore compares one cell against the
 * endpoint that owns it, and the two structural ones assert the join itself —
 * a row per agent, and the borrower set matching the engagement store.
 */
suites.workforce = async (page) => {
  const errors = await open(page, '/workforce');
  const agents = await api('agents');
  check('/workforce renders with no page error', errors.length === 0, errors.slice(0, 2).join(' | '));

  const body = await text(page, 'main');
  assertNotFixture(body, '/workforce');
  await assertRail(page, agents, '/workforce');
  check('no NaN on /workforce', !/NaN/.test(body));
  check('no literal "null" on /workforce', !/\bnull\b/.test(body));
  check('no literal "undefined" on /workforce', !/undefined/.test(body));

  /*
   * One row per agent, counted exactly against the first table on the page.
   *
   * `>=` would let the five-question table below pad the count, and a missing agent
   * would pass. Equality against the roster alone is the assertion — the same fix
   * the /resources roster needed.
   */
  const rosterRows = await page.$$eval('table.tbl',
    (tables) => (tables[0] ? tables[0].querySelectorAll('tbody tr').length : -1));
  check('the roster has exactly one row per live agent',
    rosterRows === agents.length, `roster=${rosterRows} api=${agents.length}`);
  const missing = agents.map((a) => a.name).filter((n) => !body.includes(n));
  check('every live agent name appears', missing.length === 0, missing.join(' '));

  /*
   * WHAT A BORROWER MAY ASK FOR, against GET /api/capability rather than against
   * role names typed here. The server owns this judgement, so the roster showing a
   * role the server does not grant — or omitting one it does — is drift.
   */
  const cap = await api('capability');
  const rolesOf = (name) => (cap.roles ?? [])
    .filter((r) => r.able.some((x) => x.agent === name))
    .map((r) => r.displayName);
  const wrongRoles = agents
    .map((a) => ({ name: a.name, want: rolesOf(a.name) }))
    .filter(({ want }) => want.length > 0)
    .filter(({ want }) => want.some((d) => !body.includes(d)));
  check('every role the server grants is named on the roster',
    wrongRoles.length === 0, wrongRoles.map((w) => w.name).join(' '));
  /*
   * And the inverse, which is the one that catches an inferred-from-the-name
   * eligibility: an agent the server grants nothing must be shown as qualifying
   * for nothing, with the reason. Asserted on the reason rather than on the
   * absence of role names, because absence is what a crashed cell also looks like.
   */
  const barren = agents.filter((a) => rolesOf(a.name).length === 0);
  if (barren.length > 0) {
    check('an agent the server grants no role says why',
      /no model chosen|qualifies for nothing|below every role|没有选定模型|不符合任何|低于所有角色/.test(body),
      barren.map((a) => a.name).join(' '));
  } else {
    check('every agent qualifies for something (vacuous)', true, `${agents.length} agents`);
  }

  /*
   * THE BORROWER SET, against the engagement store.
   *
   * An active engagement's project must appear; an agent with none must be stated
   * as unborrowed rather than left blank. Both directions, because "no rows" is
   * also what a failed join renders.
   */
  const { engagements } = await api('engagements');
  const active = engagements.filter((e) => e.state === 'active');
  const missingProjects = [...new Set(active.map((e) => e.project))].filter((p) => !body.includes(p));
  check('every active engagement’s project is on the roster',
    missingProjects.length === 0, missingProjects.join(' '));
  const lentNames = new Set(active.map((e) => e.agent));
  if (agents.some((a) => !lentNames.has(a.name))) {
    check('an agent nobody is borrowing says so, rather than showing an empty cell',
      /nobody is borrowing|当前没有人借用/.test(body));
  } else {
    check('every agent is borrowed (vacuous)', true, `${active.length} active`);
  }

  /*
   * THE ACCESS RECORD, which is why this page reads a sixth endpoint.
   *
   * GET /api/contributions is the binding that actually lets a project reach an
   * agent; an engagement is only the allocation. The roster reconciles them, so the
   * check is that the reconciliation reports the state the two payloads actually
   * describe — including agreement, since a column that only speaks up on failure
   * is indistinguishable from one that is broken.
   */
  const { contributions } = await api('contributions');
  const bindings = (contributions ?? []).filter((c) => c.active !== false);
  check('the access record is read, not inferred from the engagement',
    /access record|可达记录/i.test(await text(page, '[data-testid="provenance"]') ?? ''));
  /*
   * Standing reachability that outlived its engagement is the finding this column
   * exists for, so it must be NAMED rather than silently counted.
   *
   * Reported as vacuous when no such binding exists, rather than skipped inside a
   * loop that prints nothing: a check that quietly does not run is the one outcome
   * this suite refuses, because it reads exactly like a pass.
   */
  const standing = agents.flatMap((a) => {
    const rooms = new Set(active.filter((e) => e.agent === a.name).map((e) => e.projectRoomId));
    return bindings.filter((b) => b.agent === a.name && !rooms.has(b.projectRoomId));
  });
  if (standing.length > 0) {
    check('a binding with no active engagement is flagged, not merely counted',
      /no active engagement|没有对应的进行中接洽/.test(body),
      standing.map((b) => `${b.agent}:${b.project}`).join(' '));
  } else {
    check('no binding outlives its engagement on this backend (vacuous)', true,
      `${bindings.length} bindings, every one with an active engagement behind it`);
  }
  if (bindings.length > 0 && agents.some((a) => bindings.some((b) => b.agent === a.name))) {
    check('an agent with bindings reports how many rooms can reach it',
      /reachable from \d+ rooms|\d+ 个房间可达/.test(body), `${bindings.length} bindings`);
  } else {
    check('no binding on this backend (vacuous)', true, '0 active bindings');
  }
  const unbound = agents.filter((a) => !bindings.some((b) => b.agent === a.name)
    && !active.some((e) => e.agent === a.name));
  if (unbound.length > 0) {
    check('an unreachable agent says that, rather than rendering an empty cell',
      /no project can reach it|没有项目能连上它/.test(body), `${unbound.length} agents`);
  } else {
    check('every agent is reachable by someone (vacuous)', true, '');
  }

  /*
   * CONSUMPTION — the rule the whole console rests on, asserted per agent.
   *
   * Not "the page says something about metering somewhere": the per-agent reason is
   * fetched from the payload and looked for on screen. That is what catches a page
   * which renders one generic footnote and drops the specific reason, which for this
   * backend differs by framework — a missing workspace is a different problem from
   * an adapter whose transcripts nobody has located.
   */
  const usage = await api('usage');
  const rows = usage.agents ?? [];
  const unmeasured = rows.filter((r) => r.tokensUsed === null);
  const lostReasons = unmeasured.filter((r) => !body.includes(r.tokensReason));
  check('every unmeasured agent carries its OWN reason on screen',
    lostReasons.length === 0, lostReasons.map((r) => r.agent).join(' '));
  check('and none of them renders as a zero',
    rows.every((r) => r.tokensUsed === null || r.tokensUsed > 0),
    rows.filter((r) => r.tokensUsed === 0).map((r) => r.agent).join(' '));
  const measured = rows.filter((r) => r.tokensUsed !== null);
  if (measured.length > 0) {
    const shown = measured.filter((r) => {
      const m = r.tokensUsed >= 1_000_000 ? `${(r.tokensUsed / 1_000_000).toFixed(1)}M`
        : r.tokensUsed >= 1_000 ? `${Math.round(r.tokensUsed / 1_000)}k`
          : String(r.tokensUsed);
      return !body.includes(m);
    });
    check('a measured agent shows its figure', shown.length === 0, shown.map((r) => r.agent).join(' '));
    // Cache reads run orders of magnitude above fresh input, so one summed figure
    // hides the only number that distinguishes two agents.
    check('and the kinds are shown apart, not as one total',
      /cache read|缓存读取/i.test(body));
  } else {
    check('nothing is attributable on this host (vacuous)', true,
      `${unmeasured.length} agents, all with a reason — the measured branch is unexercised here`);
  }

  /*
   * THE SEAT under the ceiling. A per-agent ceiling is a sub-allocation of a shared
   * credential home, so the roster naming a ceiling without naming the seat would
   * repeat the arithmetic the seats table exists to correct.
   */
  const { seats } = await api('seats');
  const shared = (seats ?? []).filter((s) => s.members.length > 1);
  if (shared.length > 0) {
    check('an agent on a shared seat says how many share it',
      /shared with \d+ more|与另外 \d+ 个共用/.test(body),
      `${shared.length} shared seats`);
  } else {
    check('no shared seat in this deployment (vacuous)', true, `${(seats ?? []).length} seats`);
  }

  /*
   * WHAT THE ROSTER MUST NOT BECOME. ADR-013 §1 withdrew dispatch, so a page that
   * grew an assignment, a queue or a lease column would be building the thing the
   * decision removed — and it would look like a feature. Asserted as an absence,
   * with the withdrawal stated on the page rather than merely implied by omission.
   */
  check('the roster states whose decision the work is',
    /decided on the project side|由项目一侧决定/.test(body));
  check('and names the withdrawal rather than leaving a silent gap',
    /withdrawn|撤回/i.test(body));
  check('and it carries no assignment, queue or lease column',
    !/\b(assignment|work item|lease|queue)\b/i.test(
      await page.$eval('table.tbl thead', (el) => el.innerText).catch(() => ''),
    ));
  /*
   * Currency, in either direction. ADR-013's 2026-08-10 amendment makes the token
   * the unit of account, and a `$` on a roster of lent capacity would be the
   * withdrawn pricing model reappearing as a formatting choice.
   */
  check('no currency anywhere on the roster', !/[$€£¥]|\bUSD\b|\bCNY\b/.test(body));
};

// ── /agents/[name] ──────────────────────────────────────────────────────────
suites.agentDetail = async (page) => {
  const agents = await api('agents');
  const target = agents[0]?.name;
  if (!target) return check('no agent to inspect', false, 'backend has no agents');
  const errors = await open(page, `/agents/${target}`);
  check(`/agents/${target} renders with no page error`, errors.length === 0, errors.slice(0, 2).join(' | '));
  const body = await text(page, 'main');
  check('the agent name is on its own page', body.includes(target));
  check('no NaN on the agent page', !/NaN/.test(body));
};

// ── writes: the console actually mutating the backend ───────────────────────
/*
 * The only checks here that prove the integration is real rather than shaped.
 *
 * Every other assertion reads. A page can render a live payload perfectly and still
 * have buttons that only raise a toast — which is exactly what these controls did
 * before this round, and a read-only suite cannot tell the difference. So each of
 * these presses a control in the browser and then asks the BACKEND what changed.
 */
suites.writes = async (page) => {
  /*
   * Create what this suite consumes.
   *
   * It approves and rejects engagements and acknowledges an alert, so a second run
   * found nothing pending and failed on its own leftovers — a validation harness
   * that only works once is not one. Two fresh requests are posted here rather than
   * relying on the seed, which keeps the suite runnable in any order and any number
   * of times.
   */
  await post('engagements', {
    project: 'ux-write-check/alpha',
    projectRoomId: '!writeCheckA:hq.example',
    role: 'coding',
    requester: '@ux:hq.example',
    requestedTokens: 50_000,
    ratePerDay: 5_000,
  });
  await post('engagements', {
    project: 'ux-write-check/beta',
    projectRoomId: '!writeCheckB:hq.example',
    role: 'coding',
    requester: '@ux:hq.example',
    requestedTokens: 60_000,
    ratePerDay: 5_000,
  });

  // 1. Approve a pending engagement, and confirm the store moved.
  const before = (await api('engagements')).engagements;
  const pending = before.filter((e) => e.state === 'pending');
  if (pending.length === 0) {
    check('a pending engagement exists to approve', false, 'seed one first');
  } else {
    const target = pending[0];
    await open(page, '/engagements');
    // Find the row for this engagement and press its Approve button.
    const pressed = await page.evaluate((project) => {
      const rows = [...document.querySelectorAll('table.tbl tbody tr')];
      const row = rows.find((r) => r.innerText.includes(project));
      if (!row) return 'no row';
      const btn = [...row.querySelectorAll('button')].find((b) => /approve|批准/i.test(b.innerText));
      if (!btn) return 'no button';
      btn.click();
      return 'clicked';
    }, target.project);
    check('the Approve control is present and clickable', pressed === 'clicked', pressed);
    await page.waitForTimeout(1200);

    const after = (await api('engagements')).engagements.find((e) => e.id === target.id);
    // The assertion that cannot be satisfied by a toast.
    check('approving in the browser changed the engagement in the backend',
      after?.state === 'active', `${target.state} -> ${after?.state}`);
    check('and it recorded an allocation',
      Number(after?.allocatedTokens) > 0, String(after?.allocatedTokens));

    const audit = (await api('engagements/audit?limit=20')).audit;
    check('and the verdict is in the audit log',
      audit.some((a) => a.type === 'engagement.approved' && a.engagementId === target.id));
  }

  // 2. Reject, so the other verdict is exercised too.
  const stillPending = (await api('engagements')).engagements.filter((e) => e.state === 'pending');
  if (stillPending.length > 0) {
    const target = stillPending[0];
    await open(page, '/engagements');
    const pressed = await page.evaluate((project) => {
      const rows = [...document.querySelectorAll('table.tbl tbody tr')];
      const row = rows.find((r) => r.innerText.includes(project));
      const btn = row && [...row.querySelectorAll('button')].find((b) => /reject|拒绝/i.test(b.innerText));
      if (!btn) return 'no button';
      btn.click();
      return 'clicked';
    }, target.project);
    check('the Reject control is present and clickable', pressed === 'clicked', pressed);
    await page.waitForTimeout(1200);
    const after = (await api('engagements')).engagements.find((e) => e.id === target.id);
    check('rejecting in the browser ended the engagement in the backend',
      after?.state === 'ended', `${target.state} -> ${after?.state}`);
    // Rejection must not allocate. An allocation on a refused request would be
    // committed capacity nobody agreed to.
    check('and allocated nothing', after?.allocatedTokens === null, String(after?.allocatedTokens));
  } else {
    check('a second pending engagement exists to reject (vacuous)', true, 'none left');
  }

  /*
   * 2b. The four controls that were still only raising a toast.
   *
   * Every one of them looked finished: a button, a confirmation, a plausible
   * message. None of them sent anything. A read-only suite cannot tell that apart
   * from a working control, which is why each is now driven in the browser and
   * checked against the store rather than against the toast it produced.
   */

  // The wizard creates a preset — with its ceiling, the field that used to be dropped.
  const presetsBefore = await api('framework-presets');
  await open(page, '/resources/new');
  const wizard = await page.evaluate(() => {
    const clickText = (re) => {
      const b = [...document.querySelectorAll('button')].find((x) => re.test(x.innerText));
      if (b) b.click();
      return Boolean(b);
    };
    if (!clickText(/^claude$|Claude Code/i)) return 'no framework';
    return 'framework';
  });
  if (wizard !== 'framework') {
    check('the wizard offers a framework to pick', false, wizard);
  } else {
    /*
     * Step through model → reasoning → budget.
     *
     * `Choose` SETS the model and does not advance — a first version of this loop
     * kept finding it and clicked it forever, never reaching Create. So: choose
     * once, then advance with Next until Create appears. Driven by what the DOM
     * offers rather than by a fixed number of iterations, so adding a step to the
     * wizard does not silently stop this from reaching the end.
     */
    let chosen = false;
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const done = await page.evaluate((haveChosen) => {
        const btns = [...document.querySelectorAll('button')];
        if (btns.some((b) => /create|创建/i.test(b.innerText))) return 'create';
        if (!haveChosen) {
          const pick = btns.find((b) => /^(choose|pick|选择)$/i.test(b.innerText.trim()));
          if (pick) { pick.click(); return 'chose'; }
        }
        const next = btns.find((b) => /^(next|下一步)$/i.test(b.innerText.trim()));
        if (next && !next.disabled) { next.click(); return 'next'; }
        return 'stuck';
      }, chosen);
      if (done === 'chose') chosen = true;
      if (done === 'create' || done === 'stuck') break;
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(350);
    }
    await page.waitForTimeout(400);
    const created = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /create|创建/i.test(x.innerText));
      if (!b) return 'no create button';
      b.click();
      return 'clicked';
    });
    check('the wizard Create control is reachable', created === 'clicked', created);
    if (created === 'clicked') {
      await page.waitForTimeout(1200);
      const after = await api('framework-presets');
      check('creating in the wizard added a preset to the backend',
        after.length === presetsBefore.length + 1, `${presetsBefore.length} -> ${after.length}`);
      const fresh = after.find((p) => !presetsBefore.some((q) => q.id === p.id));
      // The ceiling is the point: the form used to omit it because the endpoint
      // dropped it, and shipping the form without it would have kept that gap.
      check('and the ceiling it collected was saved',
        Number(fresh?.ceiling?.tokens) > 0, JSON.stringify(fresh?.ceiling));
      check('and the saved ceiling is marked unenforced',
        fresh?.ceiling?.enforced === false, String(fresh?.ceiling?.enforced));
      // Clean up, so the suite leaves the store as it found it.
      if (fresh) {
        await fetch(`${BACKEND}/api/framework-presets/${fresh.id}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` },
        });
      }
    }
  }

  // Publishing a role is what makes the contributor discoverable.
  const offersBefore = (await api('offers')).offers;
  const toggling = offersBefore.find((o) => o.role === 'documentation') ?? offersBefore[0];
  await open(page, '/capability');
  const toggled = await page.evaluate((role) => {
    const cards = [...document.querySelectorAll('.rolecard')];
    const card = cards.find((c) => c.innerText.includes(role));
    if (!card) return `no card for ${role}`;
    const btn = [...card.querySelectorAll('button')].find((b) => /publish|withdraw|发布|撤回/i.test(b.innerText));
    if (!btn) return 'no publish control';
    btn.click();
    return 'clicked';
  }, toggling.role);
  check('the publish control is present and clickable', toggled === 'clicked', toggled);
  if (toggled === 'clicked') {
    await page.waitForTimeout(1200);
    const after = (await api('offers')).offers.find((o) => o.role === toggling.role);
    check('publishing a role in the browser changed the offer in the backend',
      after?.published === !toggling.published,
      `${toggling.published} -> ${after?.published}`);
    // Put it back.
    await fetch(`${BACKEND}/api/offers/${toggling.role}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...toggling, published: toggling.published }),
    });
  }

  // Adding to the whitelist — the direction that grants power, and the one the
  // page had no control for at all.
  const wlBefore = (await api('whitelist')).whitelist;
  const newRoom = '!uxWriteCheck:hq.example';
  await open(page, '/engagements');
  const added = await page.evaluate((room) => {
    const inputs = [...document.querySelectorAll('input.inp')];
    if (inputs.length < 1) return 'no whitelist form';
    const set = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(inputs[0], room);
    if (inputs[1]) set(inputs[1], 'ux write check');
    const btn = [...document.querySelectorAll('button')].find((b) => /add to whitelist|加入白名单/i.test(b.innerText));
    if (!btn) return 'no add button';
    btn.click();
    return 'clicked';
  }, newRoom);
  check('the whitelist add form is present and submittable', added === 'clicked', added);
  if (added === 'clicked') {
    await page.waitForTimeout(1200);
    const wlAfter = (await api('whitelist')).whitelist;
    check('adding in the browser wrote the whitelist entry',
      wlAfter.some((w) => w.projectRoomId === newRoom),
      `${wlBefore.length} -> ${wlAfter.length}`);
    const audit = (await api('engagements/audit?limit=20')).audit;
    // Both directions of a trust change are audited; this is the one that grants.
    check('and the addition is in the audit log',
      audit.some((a) => a.type === 'whitelist.added' && a.projectRoomId === newRoom));
    await fetch(`${BACKEND}/api/whitelist/${encodeURIComponent(newRoom)}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` },
    });
  }

  /*
   * 3. An alert transition — the other real write surface.
   *
   * Driven off the SAME legal-transition graph the page uses, rather than assuming
   * an alert is open. The store enforces the graph (an acknowledged alert cannot go
   * back to open, which is correct), so a check hardcoded to "acknowledge" fails on
   * its second run against its own leftovers. What matters is that a click in the
   * browser moves the record in the backend, not which particular edge it takes.
   */
  const NEXT = {
    open: ['acknowledged', 'assigned', 'resolved', 'suppressed'],
    acknowledged: ['assigned', 'resolved', 'suppressed'],
    assigned: ['resolved', 'suppressed'],
    resolved: [],
    suppressed: ['open'],
  };
  const LABEL = {
    acknowledged: /acknowledge|确认/i,
    assigned: /assign|指派/i,
    resolved: /resolve|解决/i,
    suppressed: /suppress|抑制/i,
    open: /reopen|重新打开/i,
  };
  /*
   * Use the one REVERSIBLE pair in the graph: open ⇄ suppressed.
   *
   * open → acknowledged → assigned → resolved is a one-way ladder, so a suite that
   * walked it exhausted its own supply — three runs in and every alert was
   * terminal, and there is no ingest endpoint to raise a fresh one (alerts are
   * raised internally by the liveness sweep, deliberately). Suppress-then-reopen is
   * legal in both directions, so this check can run any number of times and leaves
   * the store where it found it.
   */
  const alerts = await api('alerts?limit=50');
  const REVERSIBLE = { open: 'suppressed', suppressed: 'open' };
  const movable = alerts.find((a) => REVERSIBLE[a.status])
    ?? alerts.find((a) => (NEXT[a.status] ?? []).length > 0);
  if (!movable) {
    skip('an alert transition is driven from the browser',
      `every alert is terminal (${alerts.map((a) => a.status).join(',') || 'none'}); `
      + 'alerts are raised internally, so re-run scripts/seed-live.mjs --wipe-only to restore. '
      + 'The engagement writes above already prove the click-to-backend path.');
  } else {
    const target = REVERSIBLE[movable.status] ?? NEXT[movable.status][0];
    await open(page, '/alerts');
    /*
     * The page opens filtered to `open`, and the filter is component state rather
     * than a URL parameter, so it is driven the way a user would: pick "all" from
     * the status select, then find the row. Setting React state from the outside
     * needs a dispatched `change`, not just a value assignment.
     */
    await page.selectOption('select', 'all').catch(() => {});
    await page.waitForTimeout(400);
    /*
     * Two steps with a wait between them, and this is not defensive padding.
     *
     * Selecting a row and pressing a panel button inside ONE synchronous evaluate
     * queried the panel before React had re-rendered it, so the button belonged to
     * the PREVIOUS selection. It passed twice — the first row happened to be the
     * target — and failed on the third run when a different alert was picked. A
     * flake that depends on which row sorts first is a real bug in the check.
     */
    const selected = await page.evaluate((summary) => {
      const sel = document.querySelector('select');
      const rows = [...document.querySelectorAll('table.tbl tbody tr')];
      const row = rows.find((r) => r.innerText.includes(summary));
      if (!row) return `no row (filter=${sel?.value ?? '?'})`;
      row.click();
      return 'selected';
    }, movable.summary);
    if (selected !== 'selected') check('the alert row is selectable', false, selected);
    await page.waitForTimeout(500);

    const pressed = await page.evaluate(({ summary, pattern }) => {
      const re = new RegExp(pattern, 'i');
      const panel = document.querySelector('.panel');
      // Confirm the panel is describing the row that was clicked before pressing
      // anything in it — the stale-selection bug this design set out to prevent.
      if (!panel || !panel.innerText.includes(summary)) return 'panel shows another alert';
      const btn = [...panel.querySelectorAll('button')].find((b) => re.test(b.innerText));
      if (!btn) return `no button among: ${[...panel.querySelectorAll('button')].map((b) => b.innerText).join('/')}`;
      btn.click();
      return 'clicked';
    }, { summary: movable.summary, pattern: LABEL[target].source });
    check(`the ${target} control is present and clickable`, pressed === 'clicked',
      `${movable.status} -> ${target}: ${pressed}`);
    if (pressed === 'clicked') {
      await page.waitForTimeout(1400);
      const after = await api(`alerts/${movable.id}`);
      check('transitioning in the browser changed the alert in the backend',
        after?.status === target, `${movable.status} -> ${after?.status}`);
      // Put it back, so the next run starts from the same place this one did.
      if (after?.status === target && REVERSIBLE[target]) {
        await post(`alerts/${movable.id}/transition`, { status: movable.status, actor: 'ux-suite' });
      }
    }
  }
};

// ── the proxy's boundary ────────────────────────────────────────────────────
/*
 * A REGRESSION TEST FOR A CONFIRMED HOLE, not a hypothetical.
 *
 * The proxy attaches the backend's operator token to whatever it forwards. Its
 * allowlist used to be matched against the path Next had decoded ONCE, and the
 * outgoing URL was built by interpolating that same string — which `new URL()`
 * decodes and normalizes AGAIN. So the string checked was not the string requested:
 *
 *   DELETE /api/hafleet/whitelist/%252e%252e/agents/victim
 *     -> Next decodes to  whitelist/%2e%2e/agents/victim   (matches /^whitelist\/.+$/)
 *     -> fetch() resolves to  DELETE /api/agents/victim
 *
 * Verified against a running backend before the fix: it reached the agent-deletion
 * handler with the operator token. Only that handler's soft-delete default saved
 * the agent; `?force=true` would have removed it.
 *
 * Asserted on the OUTCOME — the agent still exists — as well as the status code,
 * because a 403 from the wrong layer would still be a 403.
 */
/*
 * REQ-CONTRIBUTION-CONSOLE-BROWSER-CREDENTIAL — every clause of it, as a live request the
 * proxy must refuse.
 *
 * The requirement names five things: the browser holds no operator credential, the proxy
 * enforces a default-deny path allowlist, it validates segments BEFORE any decoding and
 * rebuilds the outbound path from what it validated, it refuses a cross-site state-changing
 * request, and it does not follow a redirect. Each has a check below, and each was a real
 * defect first — the allowlist was matched against a path Next had already decoded once, so
 * a double-encoded segment reached the backend intact.
 *
 * Exercised through the browser and the running proxy rather than by unit-testing the route
 * handler, because four of the five are properties of the REQUEST as it actually arrives:
 * Sec-Fetch-Site, the forwarded-for chain, the redirect response, and the decoding Next does
 * before any handler code runs.
 */
suites.proxyBoundary = async () => {
  const before = (await api('agents')).map((a) => a.name).sort();

  /*
   * WHAT THIS CAN AND CANNOT PROVE — corrected after a false pass and then a false alarm.
   *
   * A single-encoded traversal (`%2e%2e`) is resolved by the FRAMEWORK before any handler
   * code runs: Next normalizes `whitelist/%2e%2e/agents/X` to `agents/X` and the route
   * receives two segments, no dot operator among them. So the property this suite can
   * assert is not "the proxy rejects traversal" — nothing in the proxy ever sees one — it is
   * "whatever the framework normalizes to, the allowlist decides".
   *
   * The distinction was invisible while every traversal happened to normalize onto a route
   * that was not allowlisted. `DELETE agents/:name` was then admitted so the Remove button
   * could do what it claimed, and this check began failing with HTTP 200 — not because a
   * boundary broke, but because the check had been measuring allowlist COVERAGE and calling
   * it traversal resistance. Sending `DELETE /api/hafleet/agents/X` directly gets the
   * identical response, so the encoded form buys an attacker nothing.
   *
   * Targets below are therefore chosen so the expectation is real: each normalizes onto a
   * route that is NOT in the allowlist, which is the only case where a refusal means
   * anything.
   */
  const victim = before[0];
  const attacks = [
    // Double/triple encoding survives Next's single decode as a literal `%`, which
    // canonicalSegments rejects outright — the vector the guard was written for.
    ['double-encoded dot segments', 'DELETE', 'whitelist/%252e%252e/agents/PLACEHOLDER'],
    ['triple-encoded dot segments', 'DELETE', 'whitelist/%25252e%25252e/agents/PLACEHOLDER'],
    ['encoded slash inside a segment', 'DELETE', 'whitelist/..%2fagents%2fPLACEHOLDER'],
    ['reaching a start endpoint', 'POST', 'whitelist/%252e%252e/agents/PLACEHOLDER/start'],
    /*
     * Single-encoded, aimed at routes the console never calls, so a refusal is evidence
     * rather than coincidence. Both are real backend endpoints deliberately absent from the
     * allowlist: `POST /api/agents` is agent SELF-registration (the console must never
     * register on an agent's behalf) and `DELETE /api/engagements/:id` would destroy a
     * decided engagement rather than revoke it.
     *
     * The first version of this probe used `DELETE /api/framework-presets/:id`, which IS
     * allowlisted — so it returned the backend's honest 404 and read as a bypass. Picking a
     * target without checking the allowlist is how a security check comes to assert the
     * opposite of what it measures, which is the mistake this whole section documents.
     */
    ['single-encoded dots onto agent self-registration', 'POST', 'whitelist/%2e%2e/agents'],
    ['single-encoded dots onto engagement deletion', 'DELETE', 'whitelist/%2e%2e/engagements/en_probe'],
  ];
  for (const [label, method, template] of attacks) {
    const url = `${BASE}/api/hafleet/${template.replace('PLACEHOLDER', victim ?? 'x')}`;
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(url, { method });
    check(`proxy refuses ${label}`, res.status === 400 || res.status === 403,
      `${method} -> HTTP ${res.status}`);
  }

  /*
   * And the counterpart, stated so nobody re-derives the wrong conclusion from a 200: a
   * traversal that normalizes onto an ALLOWLISTED route is indistinguishable from calling
   * that route directly. Both are checked, and they must agree — if they ever diverge, the
   * proxy is treating a decoded path differently from a plain one, which is the actual bug
   * this whole section is guarding against.
   */
  const ghost = 'no-such-agent-for-traversal-probe';
  const [viaDots, direct] = await Promise.all([
    fetch(`${BASE}/api/hafleet/whitelist/%2e%2e/agents/${ghost}`, { method: 'DELETE' }),
    fetch(`${BASE}/api/hafleet/agents/${ghost}`, { method: 'DELETE' }),
  ]);
  check('a traversal onto an allowlisted route is treated exactly as that route',
    viaDots.status === direct.status,
    `dots -> ${viaDots.status}, direct -> ${direct.status}`);

  const after = (await api('agents')).map((a) => a.name).sort();
  // The assertion that a status code cannot fake.
  check('no agent was touched by any traversal attempt',
    JSON.stringify(after) === JSON.stringify(before), `${before.join(',')} -> ${after.join(',')}`);

  /*
   * A REQUESTER TOKEN SUBMITS AND NOTHING ELSE.
   *
   * `POST /api/engagements` is the one project-facing write; every other engagement
   * route is the contributor deciding. They shared one credential, so a project
   * given the token it needs to ASK could approve its own request, whitelist itself
   * and widen the offer it was measured against. Checked against the backend
   * directly, since the proxy never carries this credential.
   */
  const reqTok = process.env.HAFLEET_REQUESTER_TOKEN ?? 'reqtoken';
  const asRequester = (path, method, body) => fetch(`${BACKEND}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${reqTok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const submitted = await asRequester('engagements', 'POST', {
    project: 'requester-scope-check', projectRoomId: '!requesterScope:hq.example',
    role: 'architect', requester: '@rs:hq.example', requestedTokens: 1000,
  });
  if (submitted.status === 401) {
    skip('a requester token submits but cannot decide',
      'HAFLEET_REQUESTER_TOKEN is not configured on this backend, so the split cannot be observed');
  } else {
    check('a requester token can submit a request', submitted.ok, `HTTP ${submitted.status}`);
    const created = submitted.ok ? (await submitted.json()).engagement : null;
    const escalations = [
      ['approve its own request', `engagements/${created?.id}/verdict`, 'POST', { approve: true, allocatedTokens: 1000 }],
      ['whitelist itself', 'whitelist', 'POST', { projectRoomId: '!requesterScope:hq.example' }],
      ['widen the offer it is measured against', 'offers/architect', 'PUT', { published: true, budgetCapPerEngagement: 999999999 }],
      ['delete a preset', 'framework-presets/anything', 'DELETE', undefined],
    ];
    for (const [label, path, method, body] of escalations) {
      // eslint-disable-next-line no-await-in-loop
      const r = await asRequester(path, method, body);
      check(`a requester token cannot ${label}`, r.status === 401 || r.status === 403, `HTTP ${r.status}`);
    }
    // Clean up: the operator decides it, so the queue is left as it was found.
    if (created) {
      await fetch(`${BACKEND}/api/engagements/${created.id}/verdict`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve: false, reason: 'requester-scope check' }),
      });
    }
  }

  /*
   * X-FORWARDED-FOR IS NOT THE CONTROL, and the comment that used to sit here said
   * it was: "each proxy appends the peer it actually saw, so the tail is the real
   * one". Next does not append — it sets the header only when absent (`??=`) — so a
   * caller that can reach the listener can put `127.0.0.1` in the tail and satisfy a
   * last-hop check. That is the Host-header mistake a second time.
   *
   * The bind is the control. What is asserted here is only the residual use: a
   * request carrying evidence that it was forwarded is refused. Both a non-loopback
   * tail and a spoofed-loopback tail behind a real hop must fail.
   */
  const remote = await fetch(`${BASE}/api/hafleet/agents`, { headers: { 'X-Forwarded-For': '10.1.1.5' } });
  check('proxy refuses a caller that says it was forwarded', remote.status === 403,
    `HTTP ${remote.status}`);
  const spoofed = await fetch(`${BASE}/api/hafleet/agents`, { headers: { 'X-Forwarded-For': '10.1.1.5, 127.0.0.1' } });
  check('and a loopback tail does not launder a remote hop in front of it',
    spoofed.status === 403, `HTTP ${spoofed.status}`);

  /*
   * LOOPBACK IS NOT A PRINCIPAL — a cross-site write must be refused.
   *
   * Binding to 127.0.0.1 keeps the network out and does nothing about the operator's
   * browser. A `text/plain` body is a CORS simple request, so any page they visit can
   * POST here with no preflight, and the proxy relabels it application/json and
   * attaches the operator token. One visited page could whitelist a room.
   */
  const crossSite = await fetch(`${BASE}/api/hafleet/whitelist`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' },
    body: JSON.stringify({ projectRoomId: '!csrf:hq.example', displayName: 'csrf' }),
  });
  check('proxy refuses a cross-site write', crossSite.status === 403, `HTTP ${crossSite.status}`);
  /*
   * Read the OUTCOME, and prove the read itself worked.
   *
   * The first version did `(await api('whitelist')).some?.(...)`, which returns
   * undefined when the read fails — so a 401 on the read made this pass while
   * proving nothing. Optional chaining on the assertion path turns any failure into
   * a green check. The list is asserted to be a list before it is searched.
   */
  const { whitelist: wl } = await api('whitelist');
  check('and the cross-site write reached nothing',
    Array.isArray(wl) && !wl.some((w) => w.projectRoomId === '!csrf:hq.example'),
    Array.isArray(wl) ? `${wl.length} entries, none of them the csrf room` : `whitelist unreadable: ${JSON.stringify(wl)}`);

  // The allowlist must permit the action it names and no more: a room id is ONE
  // segment, and `whitelist/.+` used to pre-authorise any nested DELETE added later.
  const nested = await fetch(`${BASE}/api/hafleet/whitelist/a/b`, { method: 'DELETE' });
  check('proxy refuses a nested whitelist delete', nested.status === 403, `HTTP ${nested.status}`);

  // And the writes it exists to permit still work, or the fix has broken the console.
  const room = '!proxyBoundaryCheck:hq.example';
  const add = await fetch(`${BASE}/api/hafleet/whitelist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectRoomId: room, displayName: 'boundary check' }),
  });
  check('a legitimate whitelist write still passes the proxy', add.ok, `HTTP ${add.status}`);
  const del = await fetch(`${BASE}/api/hafleet/whitelist/${encodeURIComponent(room)}`, { method: 'DELETE' });
  check('and so does its removal, room id and all', del.ok, `HTTP ${del.status}`);
};

const ORDER = ['resources', 'workforce', 'config', 'alerts', 'capability', 'wizard', 'onboard', 'usage', 'engagements', 'agentDetail', 'writes', 'proxyBoundary'];

/*
 * Two rules that are properties of the WHOLE console, not of any one page.
 *
 * REQ-CONTRIBUTION-CONSOLE-UNIT and REQ-CONTRIBUTION-CONSOLE-INWARD were each asserted on
 * exactly one route — currency on the roster, the absent scheduler columns on the roster's
 * table head. Both requirements are stated about the console: "the console MUST NOT convert
 * tokens to currency", "MUST NOT present a scheduler, lease, queue, or work-assignment
 * surface". A per-page check satisfies neither, and the page it happened to cover was the
 * newest one — so the seven older routes were never checked at all.
 *
 * Swept per route rather than folded into each suite, because the failure being guarded
 * against is a NEW page or a re-worded label reintroducing the withdrawn model somewhere
 * nobody thought to look. A rule that lives in one suite does not travel to the next page
 * somebody adds; this loop does.
 */
const CONSOLE_WIDE_ROUTES = [
  '/resources', '/resources/new', '/workforce', '/capability', '/projects', '/engagements', '/usage',
  '/alerts', '/config', '/onboard',
];

/*
 * A MONETARY FIGURE, not a currency character.
 *
 * The first version of this matched `[$€£¥]` anywhere in the body and failed on `/resources`
 * and `/onboard` — both because they explain that `$HOME` is never reassigned in the launch
 * path. A shell variable in prose is not a price, and widening the check until it passed
 * would have been the wrong repair; what the requirement forbids is CONVERTING TOKENS TO
 * CURRENCY, which on screen is a symbol against a number.
 *
 * So: a symbol or ISO code adjacent to a digit. `$HOME` does not match, `$1,234` and
 * `500 USD` do.
 */
const MONETARY = /[$€£¥]\s?\d|\d\s?(USD|CNY|EUR|GBP|JPY)\b|\b(USD|CNY|EUR|GBP|JPY)\s?\d/i;

/*
 * The withdrawn dispatcher vocabulary — checked against COLUMN HEADINGS, not prose.
 *
 * Same lesson from the same run: `/workforce` failed on the word "assignments" inside
 * `wf.notScheduler`, a string whose entire content is "A roster of my agents, NOT of
 * assignments… nothing here is a queue, a lease or a work item". Flagging a page for
 * disclaiming the thing it is required not to do is the check being wrong, not the page.
 *
 * The requirement forbids PRESENTING a scheduler, lease, queue, or work-assignment
 * SURFACE. A surface is a column, so table headings are where to look — which is also what
 * the roster's own narrower check already did before this loop generalised it.
 */
const DISPATCH_COLUMN = /\b(work item|lease|scheduler|assignment|queue)\b/i;

async function consoleWideRules(page) {
  console.log('— console-wide');
  for (const route of CONSOLE_WIDE_ROUTES) {
    await open(page, route);
    const body = await page.$eval('body', (el) => el.innerText).catch(() => '');
    check(`${route}: no monetary figure`, !MONETARY.test(body), (body.match(MONETARY) || [''])[0]);

    // Every table on the route, so a second table cannot be the one that regresses.
    const heads = await page.$$eval('thead', (els) => els.map((e) => e.innerText)).catch(() => []);
    const offending = heads.map((h) => (h.match(DISPATCH_COLUMN) || [''])[0]).filter(Boolean);
    check(`${route}: no dispatcher column`, offending.length === 0, offending.join(', '));
  }
}


/*
 * REMOVE WHAT THIS SUITE INVENTED.
 *
 * It posted engagements for `ux-write-check/alpha` and `/beta` against
 * `!writeCheckA:hq.example` and `!writeCheckB:hq.example`, whitelisted rooms, and left every
 * one of them behind. Run against a live backend — which is the whole point of this suite —
 * that means each run permanently added two fabricated PROJECTS to the operator's console,
 * on a domain (`hq.example`) that exists on no homeserver.
 *
 * An operator found them: the console showed their agent bound into three projects while
 * Robrix showed it joined to one, and two of the three could never have reached it. The
 * console presents access bindings as "the record that actually lets a project reach the
 * agent", so junk in that table is not cosmetic — it is the same fabrication this project has
 * been deleting everywhere else, produced by the very harness meant to catch it.
 *
 * Best effort by design: a teardown that throws would turn a passing run into a failure over
 * cleanup. What it CANNOT do is fail silently, so what it could not remove is reported.
 */
async function teardownWriteFixtures() {
  const rooms = ['!writeCheckA:hq.example', '!writeCheckB:hq.example'];
  const leftovers = [];

  // Engagements first: a binding is derived from them, so removing the room while an
  // engagement still points at it would leave the half this suite cares about behind.
  let engagements = [];
  try { engagements = (await api('engagements')).engagements ?? []; } catch { /* reported below */ }
  for (const e of engagements.filter((x) => rooms.includes(x.projectRoomId))) {
    try {
      // Revoke rather than delete: `revoke` is the modelled end of an engagement, and there
      // is deliberately no DELETE for one. An ended engagement stops projecting a binding.
      if (e.state === 'active' || e.state === 'pending') {
        // eslint-disable-next-line no-await-in-loop
        await post(`engagements/${e.id}/revoke`, { reason: 'live-ux fixture teardown' });
      }
    } catch { leftovers.push(`engagement ${e.id}`); }
  }

  for (const room of rooms) {
    try {
      // eslint-disable-next-line no-await-in-loop
      // Straight to the backend with the operator token, like `post` above. Going through
      // the console proxy would drag Sec-Fetch-Site and the allowlist into a teardown.
      const res = await fetch(`${BACKEND}/api/whitelist/${encodeURIComponent(room)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` },
      });
      if (!res.ok && res.status !== 404) leftovers.push(`whitelist ${room} (HTTP ${res.status})`);
    } catch { leftovers.push(`whitelist ${room}`); }
  }

  check('the suite removed the fixtures it created', leftovers.length === 0,
    leftovers.length ? `left behind: ${leftovers.join(', ')}` : 'nothing left in the operator\'s console');
}

(async () => {
  console.log(`\nLive UX — browser ${BASE} against backend ${BACKEND}\n`);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  for (const key of ORDER) {
    if (ONLY && !ONLY.has(key)) continue;
    console.log(`— ${key}`);
    try {
      await suites[key](page);
    } catch (e) {
      check(`${key} suite completed`, false, e.message);
    }
  }

  if (!ONLY) await consoleWideRules(page);

  /*
   * Always, even when suites failed — a failed run pollutes the console exactly as much as a
   * passing one, and a harness that only tidies up on success leaves its worst messes behind.
   */
  try {
    await teardownWriteFixtures();
  } catch (e) {
    check('teardown ran', false, e.message);
  }

  await browser.close();
  const tail = skipped > 0 ? ` ${skipped} skipped.` : '';
  console.log(`\n${failed === 0 ? `All ${ran} live UX checks pass.${tail}` : `${failed} of ${ran} FAILED.${tail}`}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
