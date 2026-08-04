'use client';

import Link from 'next/link';
import { useT } from '@/components/Prefs';

export default function NotFound() {
  const t = useT();
  return (
    <div className="empty">
      <div className="big">{t('nf.title')}</div>
      <p className="small">{t('nf.body')}</p>
      <Link className="btn primary" href="/overview">{t('nf.back')}</Link>
    </div>
  );
}
