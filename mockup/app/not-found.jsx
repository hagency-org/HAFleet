'use client';

import Link from 'next/link';
import { useT } from '@/components/Prefs';

export default function NotFound() {
  const t = useT();
  return (
    <div className="empty">
      <div className="big">{t('nf.title')}</div>
      <p className="small">{t('nf.body')}</p>
      {/*
        * `/` RATHER THAN `/overview`, which does not exist. The overview page was removed and this link
        * was not, so the 404 page's own escape hatch answered 404 — a reader who mistyped a URL clicked
        * "back" and landed on the same screen they were trying to leave. Found by walking the console as a
        * new operator would; `/` renders 我的资源 and is the console's real front door.
        */}
      <Link className="btn primary" href="/">{t('nf.back')}</Link>
    </div>
  );
}
