'use client';

import { useEffect, useState } from 'react';

/*
 * One outcome announcer for the whole prototype.
 *
 * Round 2's finding: queue and reminder actions removed their row optimistically
 * and, on failure, restored it and wrote to console.debug — so "sent",
 * "discarded" and "still queued" were indistinguishable. A failure lingers longer
 * than a success because it is the one that needs acting on.
 */
export function useToast() {
  const [toast, setToast] = useState(null);
  useEffect(() => {
    if (!toast) return undefined;
    const ms = toast.kind === 'ok' ? 2500 : 8000;
    const t = setTimeout(() => setToast(null), ms);
    return () => clearTimeout(t);
  }, [toast]);
  return [toast, (kind, text) => setToast({ kind, text, at: Date.now() })];
}

export function Toast({ toast }) {
  return (
    <div role="status" aria-live="polite">
      {toast && <div className={`toast${toast.kind === 'ok' ? '' : ' fail'}`}>{toast.text}</div>}
    </div>
  );
}
