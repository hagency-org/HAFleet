import PageHead from '@/components/PageHead';
import { pool } from '@/lib/mock-data';

/*
 * Capacity — renamed from POOL, which named a data structure rather than a question.
 *
 * Round 1 claimed the page's purpose "is not evident from the label or the file".
 * Half wrong: pool-page.js states it in its own first lines — "the live role ×
 * capability grid — who's idle/busy per cell", 按能力调度 at a glance. The label was
 * the problem; the file was fine. (That comment is also why the CJK face is loaded.)
 *
 * The real open question is whether anything dispatches from this view. If nothing
 * does, retire it rather than redesign it — so the page says so out loud.
 */
export const metadata = { title: 'Capacity — HAFleet' };

function Cell({ pair }) {
  if (!pair) return <td className="dim" title="No agent in this role has this capability">–</td>;
  const [idle, total] = pair;
  const cls = idle > 0 ? 'cap-free' : total > 1 ? 'cap-tight' : 'cap-busy';
  const barCls = idle > 0 ? '' : total > 1 ? 'tight' : 'busy';
  return (
    <td>
      <div className={`cap-cell ${barCls}`}>
        <span className={cls}>{idle}/{total}</span>
        <span className="bar"><i style={{ width: `${(idle / total) * 100}%` }} /></span>
      </div>
    </td>
  );
}

export default function CapacityPage() {
  return (
    <>
      <PageHead title="Capacity" sub="role × capability · updated 8s ago" />

      <p className="dim" style={{ fontSize: 12.5, maxWidth: '76ch' }}>
        Which roles have an idle agent available for dispatch. A cell shows <strong>idle / total</strong>{' '}
        for that role and capability. A dash means no agent in that role has the capability at all —
        which is different from all of them being busy.
      </p>

      <div className="tbl-wrap" style={{ marginTop: 14 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Role</th>
              {pool.capabilities.map((c) => <th key={c}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {pool.roles.map((r) => (
              <tr key={r.role}>
                <td>{r.role}</td>
                {pool.capabilities.map((c) => <Cell key={c} pair={r.cells[c]} />)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="legend">
        <span><i style={{ background: 'var(--ok)' }} />idle available</span>
        <span><i style={{ background: 'var(--warn)' }} />all busy, more than one agent</span>
        <span><i style={{ background: 'var(--line-strong)' }} />all busy, single agent</span>
        <span><i style={{ background: 'transparent', border: '1px solid var(--line-strong)' }} />– not supported</span>
      </div>

      <div className="notice" style={{ marginTop: 22 }}>
        <strong>Open question, not a design gap.</strong> Nothing in HAFleet currently dispatches work
        from this view — the grid is read by people, not by a scheduler. If that stays true, retire
        the page; if something starts dispatching from it, the grid is already the right shape and
        only the name needed fixing. The Chinese comment in <code>pool-page.js</code> —
        <span lang="zh-CN"> 按能力调度</span> — states the original intent.
      </div>
    </>
  );
}
