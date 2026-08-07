#!/usr/bin/env node
/**
 * Regenerate `docs/design/shots/` by driving the running app.
 *
 * The README claims these renders cannot drift from the prototype the way a
 * hand-drawn mockup does — which was only true by convention until this script
 * existed. Every shot is produced by navigating a real URL, so a view that is
 * not addressable cannot be captured, and that is deliberate.
 *
 * Usage: npm start, then `node scripts/shots.mjs`.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const CHROME = process.env.CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = '../docs/design/shots';

/*
 * Both lenses, both levels, in both states.
 *
 * The honest and projected states are both captured for every scope that has them,
 * because the difference between the two IS the design: the default is what a real
 * fleet returns, and a reviewer who only ever sees the populated render will
 * conclude that a fresh install produces a staffed org chart. It does not.
 */
const SHOTS = [
  // the dotted line — PDU
  ['org-live-en-light', '/org', 'en', 'light'],
  ['org-allocated-en-light', '/org?view=assigned', 'en', 'light'],
  ['org-allocated-zh-dark', '/org?view=assigned', 'zh', 'dark'],
  ['role-coding-en-light', '/org/coding?view=assigned', 'en', 'light'],
  ['role-integration-en-light', '/org/integration?view=assigned', 'en', 'light'],
  // the solid line — PDT
  ['projects-live-en-light', '/projects', 'en', 'light'],
  ['projects-portfolio-en-light', '/projects?view=assigned', 'en', 'light'],
  ['project-api-service-en-light', '/projects/api-service?view=assigned', 'en', 'light'],
  ['project-api-service-zh-dark', '/projects/api-service?view=assigned', 'zh', 'dark'],
  // where the two lines meet
  ['agent-en-dark', '/agents/octos-agent?view=assigned', 'en', 'dark'],
  // the demoted routes, still reachable
  ['workforce-en-light', '/workforce', 'en', 'light'],
  ['assignments-en-light', '/assignments', 'en', 'light'],
  ['capacity-empty-en-light', '/capacity', 'en', 'light'],
  ['capacity-assigned-en-light', '/capacity?view=assigned', 'en', 'light'],
  ['performance-en-light', '/performance', 'en', 'light'],
  ['knowledge-en-light', '/knowledge', 'en', 'light'],
  ['knowledge-zh-dark', '/knowledge', 'zh', 'dark'],
  ['onboard-en-light', '/onboard', 'en', 'light'],
];

mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

for (const [name, path, locale, theme] of SHOTS) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });
  // Seed the preference before first paint, the same way the app's own inline
  // script reads it — clicking the switches afterwards would capture a flash.
  await page.evaluateOnNewDocument((l, th) => {
    localStorage.setItem('hafleet.locale', l);
    localStorage.setItem('hafleet.theme', th);
    // The stored value is the LOCALES *code* ('zh'), not the html lang tag
    // ('zh-CN'). Seeding the tag silently fell back to English and produced a
    // shot labelled zh that was entirely in English — which is the failure mode
    // a generated screenshot is supposed to remove, so it is asserted below.
  }, locale, theme);
  await page.goto(BASE + path, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => {
    const el = document.querySelector('.prefs-row .seg');
    return Boolean(el && Object.keys(el).some((k) => k.startsWith('__reactProps$')));
  });
  // A shot that claims a locale and theme must actually be in them, or the
  // renders drift from the app exactly the way hand-drawn mockups do.
  const got = await page.evaluate(() => ({
    lang: document.documentElement.getAttribute('lang'),
    theme: document.documentElement.getAttribute('data-theme'),
  }));
  const wantLang = locale === 'zh' ? 'zh-CN' : 'en';
  if (got.lang !== wantLang || got.theme !== theme) {
    throw new Error(`${name}: asked for ${wantLang}/${theme}, page is ${got.lang}/${got.theme}`);
  }

  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`  ${name}.png  ${path}  ${got.lang}/${got.theme}`);
  await ctx.close();
}

console.log(`\n${SHOTS.length} shots written to ${OUT}\n`);
browser.process()?.kill('SIGKILL');
process.exit(0);
