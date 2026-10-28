// Team-Dashboard: Fokus der Woche (Admin), Map-Pool-Blatt (Status, Strats, Win-Rate aus den eigenen Demos), offene Vorschläge,
// neue Strats, rechts „dein Lern-Status“ und das Team
import { useState } from 'react'
import type { MapStatus } from '../../shared/team'
import { TypeIcon } from '../utility/ui'
import { mapColor, mapName, radarUrl } from '../utility/maps'
import { team } from '.'
import { ago, inBook, isAdmin, isOpen, learnSummary, progressOf, roleLabel, winRates } from './logic'
import { StratRow } from './Stratbook'
import { AdminBadge, Avatar, LearnDot, STATUS_LABEL, Section, TI, VoteBox, nameOf, poolOf, useTeam } from './tui'

export function Dashboard() {
  const { s, go, run, matches, setMap } = useTeam()
  const admin = isAdmin(s)
  const [focus, setFocus] = useState<string>()
  const book = s.strats.filter(inBook)
  const open = s.strats.filter(isOpen).sort((a, b) => b.updatedAt - a.updatedAt)
  const fresh = [...book].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)
  const rates = winRates(matches, s.members.map(m => m.steamid ?? ''))
  const me = learnSummary(s, s.me!.id)
  const todo = [
    ...book.map(st => ({ id: st.id, kind: 'strat' as const, title: st.title, sub: mapName(st.map), status: progressOf(s.progress, s.me?.id, { strat: st.id }) })),
    ...s.lineups.filter(l => !l.deleted).map(l => ({ id: l.id, kind: 'lineup' as const, title: l.title, sub: mapName(l.map), type: l.type, status: progressOf(s.progress, s.me?.id, { lineup: l.id }) })),
  ].filter(x => x.status !== 'ready').sort((a, b) => (a.status === 'unsure' ? -1 : 0) - (b.status === 'unsure' ? -1 : 0))
  const setStatus = (map: string, status: MapStatus) => {
    const pool = poolOf(s).map(p => (p.map === map ? { ...p, status } : p))
    run(team.saveTeam({ ...s.team!, mapPool: pool }), `${mapName(map)}: ${STATUS_LABEL[status]}`)
  }

  return (
    <div className="tm-dash">
      <div className="tm-dash-main">
        <div className="tm-focus">
          <span className="tm-focus-ico"><TI name="flag" size={22} /></span>
          <div className="tm-focus-body">
            <span className="tm-focus-label">Focus this week</span>
            {focus != null
              ? <form onSubmit={e => { e.preventDefault(); run(team.saveTeam({ ...s.team!, focus: focus.trim() || undefined }), 'Focus saved').then(ok => ok && setFocus(undefined)) }}>
                  <textarea className="ut-book-notes" autoFocus value={focus} onChange={e => setFocus(e.target.value)} maxLength={200} rows={2} />
                  <div className="tm-row-end"><button type="button" className="ut-btn ghost small" onClick={() => setFocus(undefined)}>Cancel</button><button className="ut-btn primary small">Save</button></div>
                </form>
              : <p>{s.team?.focus || (admin ? 'Nothing set. What should the team work on this week?' : 'Your IGL has not set a focus yet.')}</p>}
          </div>
          {admin && focus == null && <button className="ut-icon-btn" onClick={() => setFocus(s.team?.focus ?? '')} title="Edit focus"><TI name="pen" size={17} /></button>}
        </div>

        <Section icon="book" title="Map pool">
          <div className="tm-pool">
            {poolOf(s).filter(p => p.status !== 'off' || admin).map(p => {
              const n = book.filter(x => x.map === p.map).length, r = rates[p.map]
              return (
                <div key={p.map} className={`tm-pooltile ${p.status}`} style={{ '--m': mapColor(p.map) } as React.CSSProperties} role="button" tabIndex={0}
                  onClick={() => { setMap(p.map); go({ page: 'strats', map: p.map }) }} onKeyDown={e => e.key === 'Enter' && go({ page: 'strats', map: p.map })}>
                  <img src={radarUrl(p.map)} alt="" decoding="async" />
                  <span className="tm-pool-status">{admin
                    ? <select value={p.status} onClick={e => e.stopPropagation()} onChange={e => setStatus(p.map, e.target.value as MapStatus)} aria-label={`Status of ${mapName(p.map)}`}>
                        {(Object.keys(STATUS_LABEL) as MapStatus[]).map(k => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
                      </select>
                    : STATUS_LABEL[p.status]}</span>
                  <span className="ut-tile-name">{mapName(p.map)}</span>
                  {p.note && <span className="tm-pool-note">{p.note}</span>}
                  <span className="tm-pool-stats">
                    <span><b>{n}</b> strat{n === 1 ? '' : 's'}</span>
                    <span title={r ? `${r.won} of ${r.played} imported demos won` : 'No imported demo with a team member (set your SteamID in the roster)'}>
                      {r ? <><b>{Math.round((r.won / r.played) * 100)}%</b> won ({r.played})</> : <span className="muted">no demos</span>}
                    </span>
                  </span>
                </div>
              )
            })}
          </div>
        </Section>

        <Section icon="vote" title="Open proposals" extra={open.length > 0 && <button className="ut-link small" onClick={() => go({ page: 'proposals' })}>All proposals</button>}>
          {open.length ? (
            <div className="tm-dash-props">
              {open.slice(0, 4).map(st => (
                <div key={st.id} className="tm-dash-prop" role="button" tabIndex={0} onClick={() => go({ page: 'strat', id: st.id })}>
                  <span className="tm-mapdot" style={{ backgroundImage: `url(${radarUrl(st.map)})` }} />
                  <span className="tm-srow-main"><b>{st.title}</b><span className="muted small">{st.baseId ? 'Change' : 'New'}, {mapName(st.map)} {st.side}, by {nameOf(s, st.author)}, {ago(st.createdAt)}</span></span>
                  <VoteBox strat={st} compact />
                </div>
              ))}
            </div>
          ) : <div className="ut-empty small">No open proposals. Open a strat and press “Suggest change”.</div>}
        </Section>

        <Section icon="plus" title="New in the stratbook">
          {fresh.length ? <div className="tm-used">{fresh.map(st => <StratRow key={st.id} st={st} showMap />)}</div> : <div className="ut-empty small">The stratbook is empty. Start with your best default.</div>}
        </Section>
      </div>

      <aside className="tm-dash-side">
        <div className="tm-card tm-mylearn">
          <h4>Your learning status</h4>
          <div className="tm-mylearn-big"><b>{me.ready}</b><span>of {me.total} ready</span></div>
          <span className="tm-bar big">
            {(['ready', 'unsure', 'learning'] as const).map(k => <i key={k} className={k} style={{ width: `${(me[k] / Math.max(1, me.total)) * 100}%` }} />)}
          </span>
          <div className="tm-legend"><span><LearnDot status="ready" />{me.ready} ready</span><span><LearnDot status="unsure" />{me.unsure} unsure</span><span><LearnDot status="learning" />{me.learning} learning</span><span><LearnDot />{me.none} new</span></div>
          {todo.length > 0 && <h5>Still to learn</h5>}
          <div className="tm-todo">
            {todo.slice(0, 7).map(x => (
              <button key={x.kind + x.id} onClick={() => go(x.kind === 'strat' ? { page: 'strat', id: x.id } : { page: 'lineup', id: x.id })}>
                {'type' in x && x.type ? <TypeIcon type={x.type} size={20} /> : <span className="tm-todo-ico"><TI name="book" size={13} /></span>}
                <span>{x.title}<small>{x.sub}</small></span><LearnDot status={x.status} />
              </button>
            ))}
            {todo.length > 7 && <span className="muted small">+{todo.length - 7} more</span>}
            {!todo.length && me.total > 0 && <span className="tm-allready">You know every strat and lineup.</span>}
          </div>
        </div>
        <div className="tm-card tm-teamlist">
          <h4>Team <button className="ut-link small" onClick={() => go({ page: 'roster' })}>Roster</button></h4>
          {s.members.map(m => (
            <div key={m.id} className="tm-teamlist-row"><Avatar m={m} size={28} /><span><b>{m.name}</b><small>{m.roles.map(roleLabel).join(', ') || 'No role'}</small></span>{m.perm === 'admin' && <AdminBadge />}</div>
          ))}
        </div>
      </aside>
    </div>
  )
}
