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
async function fresh({ colorScheme = 'light', path = '/overview' } = {}) {
  const ctx = await browser.createBrowserContext();
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: colorScheme }]);
  await page.goto(BASE + path, { waitUntil: 'networkidle0' });
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
  check('starts in English', before.navFirst === 'Overview' && before.lang === 'en', before.navFirst);
  check('tab title follows the H1', before.title === 'Fleet overview — HAFleet', before.title);

  check('中文 button exists', await pick(page, LOCALE, 'zh'));
  await page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'zh-CN');
  const after = await state(page);

  check('lang becomes zh-CN', after.lang === 'zh-CN', after.lang);
  check('nav text is translated', after.navFirst === '总览', after.navFirst);
  check('the H1 is translated', after.h1 === '集群总览', after.h1);
  check('the tab title is translated', after.title.startsWith('集群总览'), after.title);
  check('the rail heading is translated', /代理/.test(after.railHeading), after.railHeading);
  check('the pressed state moved to 中文', after.pressed[0] === 1, after.pressedText.join(','));
  check('no raw key is visible',
    !/\b(rail|nav|ov|col|al)\.[a-zA-Z]/.test(await page.evaluate(() => document.body.innerText)));
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

// ── 7. no horizontal overflow at any specified width ─────────────────────
{
  /*
   * The design specified breakpoints and never tested them. /projects overflowed by
   * 28px at 375px because an inline grid-template-columns beat the media query that
   * collapses .split to one column — a cascade collision an inline style sets up and
   * a stylesheet cannot undo. Column ratios are modifier classes now.
   */
  const ROUTES_R = ['/overview', '/alerts', '/queue', '/tasks', '/projects', '/capacity',
    '/onboard', '/config', '/agents/octos-agent'];
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
  await page.goto(`${BASE}/overview`, { waitUntil: 'networkidle0' });
  const rail = await page.evaluate(() => {
    const r = document.querySelector('.rail');
    return { w: r?.offsetWidth ?? 0, rows: document.querySelectorAll('.fleet-row').length };
  });
  check('the rail survives 375px', rail.w > 0 && rail.rows === 8, `${rail.w}px, ${rail.rows} destinations`);
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
  for (const r of ['/overview', '/alerts', '/queue', '/tasks', '/projects', '/capacity',
    '/onboard', '/config', '/agents/octos-agent', '/agents/codex-agent']) {
    await page.goto(BASE + r, { waitUntil: 'networkidle0' });
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
