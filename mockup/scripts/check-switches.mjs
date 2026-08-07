#!/usr/bin/env node
/**
 * Drive the real switches in a real browser.
 *
 * check-invariants.mjs reads server-rendered HTML, which is always English and
 * always light — it cannot see whether the switches work at all. Everything the
 * language and theme features actually do happens after hydration, so it has to be
 * exercised in a browser or it is untested.
 *
 * Uses the system Chrome via puppeteer-core; no browser download.
 */

import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const CHROME = process.env.CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

/*
 * Each block gets its own browser context, so it gets its own localStorage.
 *
 * The first version reused one context and every later block inherited the previous
 * block's saved choices — the "starts light" baseline was already dark, and the
 * "system follows the OS" check read a data-theme left behind two blocks earlier.
 * Persistence is the feature under test, so it cannot also be the test's ambient
 * state.
 */
const contexts = [];

/*
 * Wait for hydration, not just for the network.
 *
 * `networkidle0` says the bytes arrived, not that React attached its handlers. A click
 * that lands before that does nothing — silently — and every assertion after it reads the
 * pre-click state. Against `npm start` the bundle was fast enough to hide this; against
 * `npm run dev` the language switch failed on every run. The signal is the same one block
 * 8 uses to tell a live button from a dead one: React's props object on the element.
 */
const hydrated = (page) => page.waitForFunction(() => {
  const el = document.querySelector('.prefs-row .seg');
  return Boolean(el && Object.keys(el).some((k) => k.startsWith('__reactProps$')));
});

async function fresh({ colorScheme = 'light', path = '/org' } = {}) {
  const ctx = await browser.createBrowserContext();
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: colorScheme }]);
  await page.goto(BASE + path, { waitUntil: 'networkidle0' });
  await hydrated(page);
  return page;
}

/*
 * Click by POSITION, not by label. The first attempt used the English label and
 * every step after the language switch silently clicked nothing — the buttons read
 * 深色 / 浅色 / 跟随系统 by then. When the labels are the thing under test, they
 * cannot also be the selector.
 *   row 0 = language: [English, 中文]
 *   row 1 = theme:    [Light, Dark, System]
 */
const seg = (page, row, index) => page.$$eval('.prefs-row', (rows, r, i) => {
  const btns = [...rows[r].querySelectorAll('.seg')];
  if (!btns[i]) return false;
  btns[i].click();
  return true;
}, row, index);

const LOCALE = { en: [0, 0], zh: [0, 1] };
const THEME = { light: [1, 0], dark: [1, 1], system: [1, 2] };
const pick = (page, map, name) => seg(page, ...map[name]);

const state = (page) => page.evaluate(() => ({
  lang: document.documentElement.getAttribute('lang'),
  theme: document.documentElement.getAttribute('data-theme'),
  bg: getComputedStyle(document.body).backgroundColor,
  ink: getComputedStyle(document.body).color,
  railHeading: document.querySelector('.rail-sec')?.textContent.trim(),
  navFirst: document.querySelector('.fleet-row .grow')?.textContent.trim(),
  h1: document.querySelector('h1')?.textContent.trim(),
  title: document.title,
  // Position, not label — the labels are translated, so asserting on them would
  // pass in English and fail in Chinese for no real reason.
  pressed: [...document.querySelectorAll('.prefs-row')].map((row) =>
    [...row.querySelectorAll('.seg')].findIndex((b) => b.getAttribute('aria-pressed') === 'true')),
  pressedText: [...document.querySelectorAll('.seg[aria-pressed="true"]')].map((e) => e.textContent.trim()),
  fontFamily: getComputedStyle(document.body).fontFamily,
}));

// ── 1. language switch actually changes the words ────────────────────────
{
  const page = await fresh();
  const before = await state(page);
  // navFirst is the rail's FIRST destination, which is now Projects: the rail leads
  // with the solid line and the H1 belongs to /org, the dotted-line landing page.
  check('starts in English', before.navFirst === 'Projects' && before.lang === 'en', before.navFirst);
  check('tab title follows the H1', before.title === 'Organization — HAFleet', before.title);

  check('中文 button exists', await pick(page, LOCALE, 'zh'));
  await page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'zh-CN');
  const after = await state(page);

  check('lang becomes zh-CN', after.lang === 'zh-CN', after.lang);
  check('nav text is translated', after.navFirst === '项目', after.navFirst);
  check('the H1 is translated', after.h1 === '组织', after.h1);
  check('the tab title is translated', after.title.startsWith('组织'), after.title);
  check('the rail heading is translated', /代理/.test(after.railHeading), after.railHeading);
  check('the pressed state moved to 中文', after.pressed[0] === 1, after.pressedText.join(','));
  check('no raw key is visible',
    !/\b(rail|nav|wf|as|pf|kn|col|al)\.[a-zA-Z]/.test(await page.evaluate(() => document.body.innerText)));
  await page.close();
}

// ── 2. the choice survives a reload, with no English flash ───────────────
{
  const page = await fresh();
  await pick(page, LOCALE, 'zh');
  await page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'zh-CN');
  await pick(page, THEME, 'dark');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');

  // Read the attributes as the very first thing after navigation commits, before
  // React has hydrated. If the inline script is missing, this is 'en'/null.
  // Same context as `page` on purpose: shared localStorage is the mechanism being
  // asserted. Every other block gets a fresh one.
  const page2 = await page.browserContext().newPage();
  await page2.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page2.goto(`${BASE}/alerts`, { waitUntil: 'domcontentloaded' });
  const early = await page2.evaluate(() => ({
    lang: document.documentElement.getAttribute('lang'),
    theme: document.documentElement.getAttribute('data-theme'),
  }));
  check('theme is set before hydration finishes', early.theme === 'dark', String(early.theme));
  check('lang is set before hydration finishes', early.lang === 'zh-CN', String(early.lang));

  await page2.waitForNetworkIdle();
  const late = await state(page2);
  check('a second route keeps both choices',
    late.lang === 'zh-CN' && late.theme === 'dark', `${late.lang}/${late.theme}`);
  check('the second route is translated too', late.h1 === '告警', late.h1);
  await page.close(); await page2.close();
}

// ── 3. dark theme actually repaints ──────────────────────────────────────
{
  const page = await fresh();
  const light = await state(page);
  await pick(page, THEME, 'dark');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
  const dark = await state(page);

  check('data-theme becomes dark', dark.theme === 'dark', String(dark.theme));
  check('the page background actually changes', dark.bg !== light.bg, `${light.bg} → ${dark.bg}`);
  check('the text colour actually changes', dark.ink !== light.ink, `${light.ink} → ${dark.ink}`);

  const lum = (rgb) => {
    const [r, g, b] = rgb.match(/\d+/g).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  check('dark really is darker', lum(dark.bg) < lum(light.bg), `${Math.round(lum(light.bg))} → ${Math.round(lum(dark.bg))}`);
  check('dark keeps text/background contrast',
    Math.abs(lum(dark.ink) - lum(dark.bg)) > 120,
    `Δ${Math.round(Math.abs(lum(dark.ink) - lum(dark.bg)))}`);

  // Every panel and badge has to move too — a token miss shows up as one element
  // still painted for the other theme.
  const stragglers = await page.$$eval('.panel, .card, .badge, .btn, .notice, table.tbl th',
    (els) => els.filter((e) => {
      const bg = getComputedStyle(e).backgroundColor.match(/\d+/g);
      if (!bg) return false;
      const [r, g, b] = bg.map(Number);
      const a = bg[3] === undefined ? 1 : Number(bg[3]);
      return a > 0.5 && 0.2126 * r + 0.7152 * g + 0.0722 * b > 200;
    }).map((e) => `${e.tagName.toLowerCase()}.${e.className}`.slice(0, 40)));
  check('no element stays painted light', stragglers.length === 0, stragglers.slice(0, 4).join(' | '));
  await page.close();
}

// ── 4. system follows the OS, and an explicit choice overrides it ─────────
{
  const page = await fresh({ colorScheme: 'dark' });
  const sys = await state(page);
  check('system default follows a dark OS', sys.theme === null && sys.bg === 'rgb(16, 21, 27)',
    `${sys.theme}/${sys.bg}`);
  check('nothing was stored until a choice was made',
    (await page.evaluate(() => localStorage.getItem('hafleet.theme'))) === 'system');

  await pick(page, THEME, 'light');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light');
  const forced = await state(page);
  check('an explicit Light beats a dark OS', forced.bg === 'rgb(255, 255, 255)', forced.bg);
  check('the pressed state moved to Light', forced.pressed[1] === 0, forced.pressedText.join(','));

  await pick(page, THEME, 'system');
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-theme'));
  const back = await state(page);
  check('System hands control back to the OS', back.bg === 'rgb(16, 21, 27)', back.bg);
  await page.close();
}

// ── 5. the CJK face is actually reached ──────────────────────────────────
{
  const page = await fresh();
  await pick(page, LOCALE, 'zh');
  await page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'zh-CN');
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].map((f) => f.family.replace(/"/g, ''));
  });
  check('a CJK face is loaded for Chinese text',
    fonts.some((f) => /Noto Sans SC/i.test(f)), [...new Set(fonts)].join(', ').slice(0, 80));
  await page.close();
}

// ── 6. keyboard reach ────────────────────────────────────────────────────
{
  const page = await fresh();
  const reachable = await page.$$eval('.seg', (els) => els.every((e) => e.tabIndex >= 0));
  check('every switch is keyboard reachable', reachable);
  const grouped = await page.$$eval('.prefs-row', (els) =>
    els.every((e) => e.getAttribute('role') === 'group' && e.hasAttribute('aria-label')));
  check('each switch is a labelled group', grouped);
  await page.close();
}

// ── raw {placeholder} leaks, on the views only a browser renders ─────────
{
  /*
   * Every ?view=assigned surface is client-rendered, so none of it reaches the static
   * pass — which is exactly where both real leaks were: `{role}` on a queued
   * assignment's blocked reason, and `{a}`/`{b}` on a flagged performance row. Both
   * were found by reading a screenshot, and a static assertion over the same URLs
   * passed with the bugs in.
   */
  const PROJECTED = ['/org', '/projects', '/org/coding', '/org/system-engineer',
    '/org/documentation', '/projects/api-service', '/projects/docs-portal', '/assignments',
    '/agents/octos-agent', '/agents/claude-agent'];
  const leaked = [];
  for (const route of PROJECTED) {
    const page = await fresh({ path: `${route}?view=assigned` });
    const hit = await page.evaluate(() => {
      const m = document.body.innerText.match(/\{[a-zA-Z][a-zA-Z0-9]{0,10}\}/);
      return m ? m[0] : null;
    });
    if (hit) leaked.push(`${route}:${hit}`);
  }
  check(`no projected view renders a raw {placeholder} (${PROJECTED.length} routes)`,
    leaked.length === 0, leaked.slice(0, 4).join(' '));
}

// ── the doubled em dash, which only a browser can see ────────────────────
{
  /*
   * `.why-inline::before` draws "— ", so a <Blank> that ALSO emits a `.mk-dash` span
   * renders "— — reason". None of it is visible to a markup check: generated content
   * is not in the HTML, and `innerText` does not include it either. So the invariant is
   * asserted structurally — a `.why-inline` never follows a `.mk-dash` — plus a read of
   * the computed content to confirm the pseudo-element is still the thing drawing it.
   */
  const page = await fresh({ path: '/org' });
  const dash = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.why-inline')];
    return {
      n: rows.length,
      before: rows.length ? getComputedStyle(rows[0], '::before').content : null,
      doubled: rows.filter((el) => el.previousElementSibling?.classList.contains('mk-dash')).length,
    };
  });
  check('the reason spans render', dash.n > 0, `${dash.n} found`);
  check('the dash comes from ::before', /—/.test(dash.before ?? ''), String(dash.before));
  check('no blank draws the dash twice', dash.doubled === 0, `${dash.doubled} doubled`);
}

// ── 7. no horizontal overflow at any specified width ─────────────────────
{
  /*
   * The design specified breakpoints and never tested them. /projects overflowed by
   * 28px at 375px because an inline grid-template-columns beat the media query that
   * collapses .split to one column — a cascade collision an inline style sets up and
   * a stylesheet cannot undo. Column ratios are modifier classes now.
   */
  // `/capacity?view=assigned` is listed because the populated grid is the WIDE one — six
  // role columns of agent chips — and while the view lived in component state no
  // URL-driven pass could reach it. This sweep was measuring the empty view twice.
  const ROUTES_R = ['/workforce', '/assignments', '/alerts', '/queue', '/tasks', '/projects', '/capacity',
    '/capacity?view=assigned', '/performance', '/knowledge', '/onboard', '/config', '/agents/octos-agent'];
  const WIDTHS = [375, 640, 900, 1440];
  const over = [];
  const ctx = await browser.createBrowserContext();
  contexts.push(ctx);
  const page = await ctx.newPage();
  for (const w of WIDTHS) {
    await page.setViewport({ width: w, height: 900 });
    for (const r of ROUTES_R) {
      await page.goto(BASE + r, { waitUntil: 'networkidle0' });
      const m = await page.evaluate(() => {
        const d = document.documentElement;
        return {
          scrolls: d.scrollWidth > d.clientWidth + 1,
          by: d.scrollWidth - d.clientWidth,
          // Wide content is allowed to overflow INSIDE its own scroller; only an
          // ancestor-less overflow makes the page itself scroll sideways.
          culprits: [...document.querySelectorAll('body *')].filter((e) => {
            if (e.scrollWidth <= d.clientWidth + 1) return false;
            for (let n = e.parentElement; n && n !== document.body; n = n.parentElement) {
              const ox = getComputedStyle(n).overflowX;
              if (ox === 'auto' || ox === 'scroll') return false;
            }
            return true;
          }).slice(0, 2).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 20)}`),
        };
      });
      if (m.scrolls) over.push(`${w}px ${r} +${m.by}px ${m.culprits.join(' ')}`);
    }
  }
  check(`no page scrolls sideways at ${WIDTHS.join('/')}px`, over.length === 0, over.slice(0, 3).join(' | '));

  // The rail is the whole navigation model, so it must survive the narrowest width.
  await page.setViewport({ width: 375, height: 900 });
  await page.goto(`${BASE}/workforce`, { waitUntil: 'networkidle0' });
  const rail = await page.evaluate(() => {
    const r = document.querySelector('.rail');
    return { w: r?.offsetWidth ?? 0, rows: document.querySelectorAll('.fleet-row').length };
  });
  // Six, down from nine: four of the old destinations became sections under Org.
  check('the rail survives 375px', rail.w > 0 && rail.rows === 6, `${rail.w}px, ${rail.rows} destinations`);
  await page.close();
}

// ── 8. no control looks live and does nothing ────────────────────────────
{
  /*
   * Three buttons shipped with no handler — projects Refresh, and the agent header's
   * cadence and Pause. A dead control is worse than an absent one: it teaches the
   * operator to distrust every other control on the page.
   */
  const page = await fresh();
  const dead = [];
  for (const r of ['/workforce', '/assignments', '/alerts', '/queue', '/tasks', '/projects', '/capacity',
    '/performance', '/knowledge', '/onboard', '/config', '/agents/octos-agent']) {
    await page.goto(BASE + r, { waitUntil: 'networkidle0' });
    await hydrated(page); // or every button reads as dead, which is the same false positive
    const found = await page.$$eval('button', (els) => els
      // React attaches listeners at the root, so the DOM cannot be asked directly.
      // A live button is one React gave an onClick prop to, which shows up on the
      // element's internal props object.
      .filter((e) => {
        const key = Object.keys(e).find((k) => k.startsWith('__reactProps$'));
        const props = key ? e[key] : null;
        return !(props && typeof props.onClick === 'function');
      })
      .map((e) => e.textContent.trim().slice(0, 26)));
    for (const label of found) dead.push(`${r}:${label}`);
  }
  check('every button has a handler', dead.length === 0, dead.slice(0, 5).join(' | '));
  await page.close();
}

// ── 9. the capacity view round-trips through the URL ─────────────────────
{
  /*
   * The populated grid is the page's hypothetical view, and it used to be reachable only
   * by clicking: not linkable, lost on reload, and invisible to every check here. Which
   * meant the assertion that matters most about it — that a lease table full of rows says
   * on screen that it is illustrative — could not be written at all.
   */
  const page = await fresh();
  await page.goto(`${BASE}/capacity?view=assigned`, { waitUntil: 'networkidle0' });
  await hydrated(page); // the URL is read in an effect, so the view exists only after this
  // The rail footer's language and theme switches are `.prefs-row` too, and they come
  // first in the document — the first version of these three assertions clicked 中文 and
  // then reported that the URL had not changed. The view row is the one outside the rail.
  const VIEW_ROW = '.prefs-row:not(.rail .prefs-row)';
  /*
   * Count GRID chips, not every `.agent-chip` on the page. The empty view lists the five
   * unassigned agents as chips too, so a bare `.agent-chip` count is 5 in both views and
   * proves nothing — it read as "the view never changes" while the view was changing
   * correctly. Only a chip in a cell carries idle/busy.
   */
  const GRID_CHIPS = '.agent-chip.idle, .agent-chip.busy';
  const assigned = await page.evaluate((sel) => ({
    chips: document.querySelectorAll('.agent-chip.idle, .agent-chip.busy').length,
    pressed: document.querySelector(`${sel} button[aria-pressed="true"]`)?.textContent.trim(),
    labelled: [...document.querySelectorAll('.notice.warn')].some((n) => /[Hh]ypothetical|假设/.test(n.textContent)),
    leases: document.querySelectorAll('.tbl tbody tr').length,
    // Same rule as the static pass, on the view the static pass cannot see —
    // and the same refinement: a mark alone fails, a self-describing number
    // like `74%` in the seat table does not.
    wordless: [...document.querySelectorAll('td')]
      .filter((td) => !/[A-Za-z0-9一-鿿]/.test(td.textContent.trim())).length,
  }), VIEW_ROW);
  check('?view=assigned selects the populated grid', assigned.chips > 0, `${assigned.chips} chips`);
  check('the pressed segment agrees with the URL', assigned.pressed === 'With roles assigned', assigned.pressed);
  check('the populated view says on screen that it is hypothetical', assigned.labelled);
  check('no cell in the populated view is a mark alone', assigned.wordless === 0, `${assigned.wordless} wordless`);

  // Reload keeps it, and Back returns to the honest default.
  await page.reload({ waitUntil: 'networkidle0' });
  await hydrated(page);
  const kept = await page.$$eval(GRID_CHIPS, (e) => e.length);
  check('a reload keeps the view', kept > 0, `${kept} chips in cells`);
  await page.goto(`${BASE}/capacity`, { waitUntil: 'networkidle0' });
  await hydrated(page);
  const clicked = await page.evaluate((sel) => {
    const b = [...document.querySelectorAll(`${sel} button`)]
      .find((x) => x.getAttribute('aria-pressed') === 'false');
    b?.click();
    return b?.textContent.trim() ?? null;
  }, VIEW_ROW);
  check('the unpressed segment is the other view', clicked === 'With roles assigned', String(clicked));
  const url = await page.evaluate(() => location.search);
  await page.goBack({ waitUntil: 'networkidle0' });
  await hydrated(page);
  // popstate → setState → render is asynchronous, so reading the DOM in the same tick
  // measures the frame before the update. Wait for it, but swallow the timeout: if the
  // view never resets, the assertion below should say so rather than the run crashing.
  await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 0,
    { timeout: 5000 }, GRID_CHIPS).catch(() => {});
  const back = await page.evaluate((sel) => ({
    search: location.search,
    chips: document.querySelectorAll(sel).length,
  }), GRID_CHIPS);
  check('choosing a view writes the URL', url === '?view=assigned', url || '(empty)');
  check('Back returns to the default view', back.search === '' && back.chips === 0,
    `${back.search || '(empty)'}, ${back.chips} chips in cells`);
  await page.close();
}

/*
 * Teardown, with a deadline.
 *
 * browser.close() reliably hung here after every check had passed, so the run looked
 * like a hanging test when it was a hanging teardown — and each abandoned run left a
 * headless Chrome behind until 30 of them were contending, which then really did make
 * the next run slow. So: report the result FIRST, then try to close politely, then
 * SIGKILL the process group and exit regardless.
 */
console.log(`\n${failed === 0 ? 'Switches verified in-browser.' : `${failed} FAILED.`}\n`);

const pid = browser.process()?.pid;
await Promise.race([
  (async () => {
    for (const c of contexts) await c.close().catch(() => {});
    await browser.close().catch(() => {});
  })(),
  new Promise((r) => setTimeout(r, 3000)),
]);
if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }
process.exit(failed === 0 ? 0 : 1);
