import { Roboto, Noto_Sans_SC } from 'next/font/google';
import './globals.css';
import Rail from '@/components/Rail';
import { PrefsProvider } from '@/components/Prefs';
import { DataProvider } from '@/components/Data';

/*
 * Typography: Roboto for Latin, Noto Sans SC for Simplified Chinese.
 *
 * The requirement said "Open Sans SC". That font does not exist — Google ships
 * `Open Sans` (Latin, no CJK) and `Noto Sans SC` (the real Simplified Chinese
 * face, formerly Source Han Sans). Noto Sans SC is the correct counterpart and
 * pairs cleanly with Roboto, so it is used here. Substitution noted rather than
 * silently made.
 *
 * next/font downloads and self-hosts both at build time, so nothing is fetched
 * from a CDN at runtime — the dashboard has to render on hosts with no outbound
 * network. `display: swap` keeps text visible while faces load, and the CJK face
 * is only pulled for the glyphs that need it.
 *
 * CJK is not hypothetical here: pool-page.js carries the comment
 * "按能力调度" — dispatch by capability — so the real product already renders it.
 */
const roboto = Roboto({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-roboto',
});

const notoSansSC = Noto_Sans_SC({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-opensans-sc',
});

/*
 * No `title` here on purpose. PageHead renders the <title> so it can follow the
 * language switch; a metadata title would compete with it and win during hydration.
 */
export const metadata = {
  description: 'Clickable mockup of the left-rail relayout. Mock data only; no backend.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${roboto.variable} ${notoSansSC.variable}`}>
      <head>
        {/* Applied before first paint. Without this the page renders light, then
            flips to dark once React hydrates — the flash is worse than no dark mode.
            suppressHydrationWarning on <html> is not needed because this only sets
            attributes, and the provider reads them back rather than overwriting. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{
              var t=localStorage.getItem('hafleet.theme');
              if(t&&t!=='system')document.documentElement.setAttribute('data-theme',t);
              var l=localStorage.getItem('hafleet.locale');
              if(l==='zh')document.documentElement.setAttribute('lang','zh-CN');
            }catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <PrefsProvider>
          {/* Inside PrefsProvider: the provenance banner and every empty state it
              produces are translated, so the data layer needs `t` available. */}
          <DataProvider>
            <div className="app">
              <Rail />
              <main className="main">{children}</main>
            </div>
          </DataProvider>
        </PrefsProvider>
      </body>
    </html>
  );
}
