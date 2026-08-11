#!/usr/bin/env node
/**
 * Assertions that need a real browser.
 *
 * The static pass reads server-rendered HTML, which is always English, always
 * light, and never reflects computed CSS. This file covers what only a browser
 * can see. Two of its checks exist because an earlier version of them lived in
 * the static pass, passed, and went on passing while the bug was in:
 *
 *   - a DOUBLED EM DASH: `.why-inline::before` draws one, so a component that
 *     also emits a `.mk-dash` renders "— — reason". Generated content is not in
 *     the HTML and `innerText` does not include it either.
 *   - a WELDED CELL: "claude-agent1.1M left" and "5.0Mnot enforced" are two
 *     inline spans with no separator. The markup is identical whether they read
 *     correctly or not; only the computed `display` tells them apart.
 *
 * It drives the system Chrome through puppeteer-core and downloads nothing.
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

/** A fresh context so localStorage from one case cannot leak into the next. */
async function fresh({ colorScheme = 'light', path = '/resources', locale = null } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: colorScheme }]);
  if (locale) {
    await page.evaluateOnNewDocument((l) => localStorage.setItem('hafleet.locale', l), locale);
  }
  // Fixture mode explicitly. This suite's subject is the fixture's own rendering —
  // contract slices are empty against a live backend, so its cell-layout checks
  // would inspect zero cells and pass or fail for reasons unrelated to layout.
  await page.goto(`${BASE}${path}${path.includes('?') ? '&' : '?'}data=fixture`, { waitUntil: 'networkidle0' });
  // `networkidle0` only says the bytes arrived. A click before React attaches its
  // handlers does nothing, silently, and every assertion after it reads the
  // pre-click state — which passed against `npm start` and failed against
  // `npm run dev`, the wrong way round for a check.
  await page.waitForFunction(() => {
    const el = document.querySelector('.prefs-row .seg');
    return Boolean(el && Object.keys(el).some((k) => k.startsWith('__reactProps$')));
  });
  return page;
}

const state = (page) => page.evaluate(() => ({
  lang: document.documentElement.getAttribute('lang'),
  theme: document.documentElement.getAttribute('data-theme'),
  navFirst: document.querySelector('.fleet-row .grow')?.textContent.trim(),
  h1: document.querySelector('h1')?.textContent.trim(),
  title: document.title,
  bg: getComputedStyle(document.body).backgroundColor,
  pressed: [...document.querySelectorAll('.prefs-row')].map((row) =>
    [...row.querySelectorAll('.seg')].findIndex((b) => b.getAttribute('aria-pressed') === 'true')),
}));

console.log(`\nBrowser-only invariants against ${BASE}\n`);

// ── 1. the doubled em dash, which no markup check can see ──────────────────
{
  const page = await fresh({ path: '/resources' });
  const dash = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.why-inline')];
    return {
      n: rows.length,
      before: rows.length ? getComputedStyle(rows[0], '::before').content : null,
      doubled: rows.filter((el) => el.previousElementSibling?.classList.contains('mk-dash')).length,
    };
  });
  check('reason spans render', dash.n > 0, `${dash.n} found`);
  check('the dash comes from ::before', /—/.test(dash.before ?? ''), String(dash.before));
  check('no blank draws the dash twice', dash.doubled === 0, `${dash.doubled} doubled`);
}

// ── 2. welded cells: a secondary line is a LINE ────────────────────────────
{
  for (const path of ['/resources', '/engagements', '/usage', '/workforce']) {
    const page = await fresh({ path });
    const bad = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('.tbl td > span.dim')];
      return {
        n: spans.length,
        inline: spans.filter((e) => getComputedStyle(e).display !== 'block').length,
      };
    });
    check(`${path}: every secondary cell line is a block`,
      bad.n > 0 && bad.inline === 0, `${bad.n} spans, ${bad.inline} still inline`);
  }
}

// ── 3. a qualifier beside a heading has air ────────────────────────────────
{
  /*
   * `.note` had its margin scoped to `h2.sec .note`, so every `h3.sub` note
   * welded to its heading — `Ceiling used, per agentcommitted, not consumed`.
   * Same class as the welded table cell, and equally invisible to markup: the
   * HTML is identical either way.
   */
  const page = await fresh({ path: '/usage' });
  const notes = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.note')];
    return { n: els.length, flush: els.filter((e) => parseFloat(getComputedStyle(e).marginLeft) < 4).length };
  });
  check('notes render', notes.n > 0, `${notes.n} found`);
  check('every qualifier is spaced from its heading', notes.flush === 0, `${notes.flush} flush`);
}

// ── 4. the language switch actually changes the words ──────────────────────
{
  const page = await fresh({ path: '/resources' });
  const before = await state(page);
  check('starts in English', before.navFirst === 'My resources' && before.lang === 'en', before.navFirst);
  check('tab title follows the H1', before.title === 'My resources — HAFleet', before.title);

  const zh = await fresh({ path: '/resources', locale: 'zh' });
  const after = await state(zh);
  check('lang becomes zh-CN', after.lang === 'zh-CN', after.lang);
  check('nav text is translated', after.navFirst === '我的资源', after.navFirst);
  check('the H1 is translated', after.h1 === '我的资源', after.h1);
  check('the pressed locale moved', after.pressed[0] === 1, after.pressed.join(','));
}

// ── 5. wire values survive translation ────────────────────────────────────
{
  /*
   * A translated model name is unsearchable and a translated tier would stop
   * matching the scheduler, so both must appear verbatim in Chinese too.
   */
  const zh = await fresh({ path: '/resources', locale: 'zh' });
  const text = await zh.evaluate(() => document.body.innerText);
  for (const wire of ['claude-opus-5', 'kimi-k3', 'gpt-5.6-sol', 'strong', 'medium']) {
    check(`\`${wire}\` is not translated`, text.includes(wire));
  }
}

// ── 6. dark actually repaints, and is measurably darker ────────────────────
{
  const light = await state(await fresh({ colorScheme: 'light' }));
  const dark = await state(await fresh({ colorScheme: 'dark' }));
  const lum = (rgb) => {
    const [r, g, b] = (rgb.match(/\d+/g) ?? [255, 255, 255]).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  check('dark is measurably darker than light', lum(dark.bg) < lum(light.bg) - 40,
    `${light.bg} -> ${dark.bg}`);
}

// ── 7. no page scrolls sideways ───────────────────────────────────────────
{
  /*
   * /workforce is checked beside /engagements because it is the widest table in the
   * console — eight columns, one of which carries a whole sentence from the backend
   * — so it is where a `.tbl-wrap` that failed to contain its own overflow would
   * show up first. A body that scrolls sideways loses the rail's right edge and the
   * last column at once.
   */
  for (const path of ['/engagements', '/workforce']) {
    for (const w of [375, 900, 1440]) {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.setViewport({ width: w, height: 900 });
      await page.goto(`${BASE}${path}?data=fixture`, { waitUntil: 'networkidle0' });
      const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      check(`${path} does not scroll sideways at ${w}px`, !over);
      await ctx.close();
    }
  }
}

// ── 8. the rail is seven destinations under four headings ─────────────────
{
  const page = await fresh();
  const rail = await page.evaluate(() => ({
    rows: document.querySelectorAll('.rail-fleet .fleet-row').length,
    heads: document.querySelectorAll('.rail-fleet .rail-sec').length,
    current: document.querySelectorAll('[aria-current="page"]').length,
  }));
  /*
   * Seven since /workforce landed, and the count stays an equality rather than a
   * floor: the rail's density is the thing being asserted, and `>= 6` would let a
   * page be added without anyone deciding where it belongs. FOUR headings is the
   * load-bearing half — they are the four layers of ADR-013, so a fifth heading
   * would be claiming a fifth layer. The roster joins the four rather than adding
   * one, which is why it sits under 资源 beside the resources it is a view of.
   */
  check('seven nav destinations — onboard moved onto the roster', rail.rows === 7, String(rail.rows));
  check('under four headings', rail.heads === 4, String(rail.heads));
  check('exactly one marked current', rail.current === 1, String(rail.current));
}

// ── 9. every button has a handler ─────────────────────────────────────────
{
  /*
   * A control that looks live and does nothing teaches the reader to distrust
   * every other control on the page.
   *
   * `onClick` is not the only legitimate way to handle a button. A `type="submit"`
   * inside a form with an `onSubmit` is handled — and handled better, since Enter
   * works too. The first version of this check counted the whitelist form's submit
   * as dead, which is a false positive: broadened to the two real forms of handling
   * rather than relaxed, so a genuinely inert button still fails.
   */
  for (const path of ['/resources', '/capability', '/engagements', '/resources/new']) {
    const page = await fresh({ path });
    const dead = await page.evaluate(() => {
      const props = (el) => {
        const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
        return key ? el[key] : null;
      };
      const btns = [...document.querySelectorAll('button:not([disabled])')];
      return btns.filter((b) => {
        if (props(b)?.onClick) return false;
        if (b.type === 'submit') {
          const form = b.closest('form');
          if (form && props(form)?.onSubmit) return false;
        }
        return true;
      }).map((b) => b.innerText.trim().slice(0, 24));
    });
    check(`${path}: no button shipped without a handler`, dead.length === 0,
      dead.length ? `${dead.length} dead: ${dead.join(' | ')}` : '0 dead');
  }
}

// ── 10. the wizard shows the consequence before the last step ──────────────
{
  /*
   * "Which roles does this let me offer" is the question the whole wizard
   * answers. Finding out only at the end is too late to change a decision
   * cheaply, so the outcome panel must appear as soon as a model is picked.
   */
  const page = await fresh({ path: '/resources/new' });
  await page.evaluate(() => [...document.querySelectorAll('.fw')].find((b) => b.textContent.includes('claude'))?.click());
  await page.evaluate(() => [...document.querySelectorAll('.btn')].find((b) => b.textContent.trim() === 'Next')?.click());
  await page.evaluate(() => [...document.querySelectorAll('.btn')].find((b) => b.textContent.trim() === 'Choose')?.click());
  const shown = await page.evaluate(() => Boolean(document.querySelector('.panel.outcome')));
  check('the outcome appears as soon as a model is chosen, not at the end', shown);
}

console.log(`\n${failed === 0 ? 'Switches verified in-browser.' : `${failed} FAILED.`}\n`);
browser.process()?.kill('SIGKILL');
process.exit(failed === 0 ? 0 : 1);
