import { Roboto, Noto_Sans_SC } from 'next/font/google';
import './globals.css';
import Rail from '@/components/Rail';

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

export const metadata = {
  title: 'HAFleet — dashboard relayout prototype',
  description: 'Clickable mockup of the left-rail relayout. Mock data only; no backend.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${roboto.variable} ${notoSansSC.variable}`}>
      <body>
        <div className="app">
          <Rail />
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
