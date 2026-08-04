'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import PageHead from '@/components/PageHead';
import { Toast, useToast } from '@/components/Toast';
import TaskList from '@/components/TaskList';
import { tasks as ALL, isOpenTask, agents } from '@/lib/mock-data';
import { useT } from '@/components/Prefs';

/*
 * Fleet task list.
 *
 * Round 3: "a task system cannot be judged from an empty-state mockup." This is
 * the populated view — blocked first, then priority, with waiting reason and
 * heartbeat staleness visible in the row rather than hidden in a detail panel.
 *
 * The list and detail are TaskList, shared verbatim with the agent Work tab, which
 * passes a locked assignee scope. Two renderers for one record is how fleet Tasks
 * and agent Work drift apart, and the naming complaint from round 2 — Work being a
 * third name for the same objects — is answered by making Work a scope, not a fork.
 */

export default function TasksPage() {
  const t = useT();
  const [assignee, setAssignee] = useState('all');
  const [status, setStatus] = useState('open');
  const [priority, setPriority] = useState('all');
  const [q, setQ] = useState('');
  const [toast, say] = useToast();

  const openCount = ALL.filter(isOpenTask).length;
  const names = useMemo(() => [...new Set(ALL.map((t) => t.assignee).filter(Boolean))], []);

  return (
    <>
      <PageHead title={t('tk.title')} sub={t('tk.count', { open: openCount, total: ALL.length })}>
        <button className="btn primary" onClick={() => say('ok', t('tk.newTaskForm'))}>
          {t('tk.new')}
        </button>
      </PageHead>

      <div className="btn-row" style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
          {t('col.assignee')}{' '}
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="all">{t('common.all')}</option>
            <option value="__none">{t('tk.unassigned')}</option>
            {names.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
          {/* Status VALUES stay in English: they are the API's values and appear
              in curl output and logs. Only the label and "all" are translated. */}
          {t('col.status')}{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">open</option>
            <option value="all">{t('common.all')}</option>
            <option value="blocked">blocked</option>
            <option value="in_progress">in progress</option>
            <option value="accepted">accepted</option>
            <option value="created">created</option>
            <option value="done">done</option>
          </select>
        </label>
        <label style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
          {t('col.priority')}{' '}
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="all">{t('common.all')}</option>
            {['P0', 'P1', 'P2', 'P3'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <input
          type="search"
          placeholder={t('tk.search')}
          aria-label={t('tk.searchAria')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{
            font: '400 12px var(--sans)', padding: '5px 10px',
            border: '1px solid var(--line)', borderRadius: 5,
          }}
        />
      </div>

      <p className="dim" style={{ fontSize: 12, marginTop: -4 }}>
        {t('tk.openMeans')}
      </p>

      <TaskList
        tasks={ALL}
        scope={{ assignee, status, priority, q }}
        onSay={say}
        agentNames={agents.map((a) => a.name)}
      />

      <Toast toast={toast} />
    </>
  );
}
