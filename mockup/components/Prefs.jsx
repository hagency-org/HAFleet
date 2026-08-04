'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { LOCALES, translate } from '@/lib/i18n';

/*
 * Language and theme, both persisted, both applied to <html>.
 *
 * `lang` matters beyond politeness: the CSS font stack puts Roboto before
 * Noto Sans SC, and the browser picks the face per glyph. Setting lang="zh-CN"
 * also fixes line-breaking and quotation rules that differ from English.
 *
 * Theme is a token swap on [data-theme], with "system" meaning "follow
 * prefers-color-scheme". Three states, not two: a hard light choice on a dark OS is
 * a legitimate preference, and so is deferring to the OS.
 */

/*
 * The default value matters: Next renders app/not-found.jsx and any error boundary
 * through the root layout, but a component that ends up outside the provider would
 * otherwise fall back to `t: (k) => k` and paint raw dictionary keys on screen.
 * Translating against English instead degrades to readable.
 */
const PrefsContext = createContext({
  locale: 'en',
  theme: 'system',
  t: (key, vars) => translate('en', key, vars),
});

export function usePrefs() {
  return useContext(PrefsContext);
}

/** Convenience: `const t = useT()` then `t('nav.alerts')`. */
export function useT() {
  return useContext(PrefsContext).t;
}

export function PrefsProvider({ children }) {
  const [locale, setLocale] = useState('en');
  const [theme, setTheme] = useState('system');
  const [ready, setReady] = useState(false);

  // Read what the pre-paint script already applied, so state matches the DOM
  // rather than fighting it.
  useEffect(() => {
    try {
      setLocale(localStorage.getItem('hafleet.locale') || 'en');
      setTheme(localStorage.getItem('hafleet.theme') || 'system');
    } catch { /* private mode: defaults are fine */ }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const html = document.documentElement;
    const l = LOCALES.find((x) => x.code === locale) ?? LOCALES[0];
    html.setAttribute('lang', l.htmlLang);
    try { localStorage.setItem('hafleet.locale', locale); } catch {}
  }, [locale, ready]);

  useEffect(() => {
    if (!ready) return;
    const html = document.documentElement;
    if (theme === 'system') html.removeAttribute('data-theme');
    else html.setAttribute('data-theme', theme);
    try { localStorage.setItem('hafleet.theme', theme); } catch {}
  }, [theme, ready]);

  const value = {
    locale, setLocale, theme, setTheme,
    t: (key, vars) => translate(locale, key, vars),
  };

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

/** The switches themselves, rendered in the rail footer. */
export function PrefsSwitch() {
  const { locale, setLocale, theme, setTheme, t } = usePrefs();

  return (
    <div className="prefs">
      <div className="prefs-row" role="group" aria-label={t('prefs.language')}>
        {LOCALES.map((l) => (
          <button
            key={l.code}
            className="seg"
            aria-pressed={locale === l.code}
            onClick={() => setLocale(l.code)}
            /* The Chinese label is itself Chinese, so the switch is legible to the
               person who needs it without already reading English. */
            lang={l.htmlLang}
          >
            {l.label}
          </button>
        ))}
      </div>
      <div className="prefs-row" role="group" aria-label={t('prefs.theme')}>
        {[['light', t('prefs.light')], ['dark', t('prefs.dark')], ['system', t('prefs.system')]].map(
          ([code, label]) => (
            <button key={code} className="seg" aria-pressed={theme === code} onClick={() => setTheme(code)}>
              {label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
