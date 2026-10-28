// Vorschläge: neue Strats und Änderungen (baseId) mit Abstimmung, Unterschieden zum Original und Freigabe durch einen Admin
import type { Strat } from '../../shared/team'
import { Icon } from '../icons'
import { SideBadge } from '../utility/ui'
import { mapName } from '../utility/maps'
import { team } from '.'
import { ago, diffStrat, isAdmin, isOpen, kindLabel, tally } from './logic'
import { newStrat } from './StratPage'
import { Avatar, TI, VoteBox, nameOf, useTeam } from './tui'

/** Kopf eines Vorschlags: neu/Änderung, Unterschiede, Abstimmung, Freigeben/Ablehnen (Admin) */
export function ProposalInfo({ st, compact }: { st: Strat; compact?: boolean }) {
  const { s, run, go } = useTeam()
  const base = st.baseId ? s.strats.find(x => x.id === st.baseId) : undefined
  const diff = base ? diffStrat(base, st, id => nameOf(s, id)) : []
  const open = isOpen(st)
  return (
    <div className={`tm-card tm-proposal ${st.status}`}>
      <div className="tm-proposal-top">
        <span className={`tm-pill ${st.status}`}>{open ? (st.baseId ? 'Change proposal' : 'New strat proposal') : st.status === 'approved' ? 'Approved' : st.status === 'rejected' ? 'Rejected' : 'Archived'}</span>
        <span className="muted small"><Avatar m={s.members.find(m => m.id === st.author) ?? { id: st.author, name: '?' }} size={18} /> {nameOf(s, st.author)}, {ago(st.createdAt)}</span>
      </div>
      {st.baseId && (
        <div className="tm-diff">
          <span>Changes to {base ? <button className="ut-link" onClick={() => go({ page: 'strat', id: base.id })}>{base.title}</button> : 'a removed strat'}</span>
          {open && !diff.length && <span className="muted small">No changes yet</span>}
          {open && <ul>{diff.slice(0, compact ? 4 : 20).map((d, i) => <li key={i}>{d}</li>)}{compact && diff.length > 4 && <li className="muted">+{diff.length - 4} more</li>}</ul>}
        </div>
      )}
      <VoteBox strat={st} compact={compact} />
      {open && isAdmin(s) && (
        <div className="tm-decide">
          <button className="ut-btn primary" onClick={() => run(team.decide(st.id, true), st.baseId ? 'Approved: the strat is updated' : 'Approved: the strat is in the stratbook')}><Icon name="check" size={16} /> Approve</button>
          <button className="ut-btn danger" onClick={() => run(team.decide(st.id, false), 'Proposal rejected')}><Icon name="x" size={15} /> Reject</button>
        </div>
      )}
      {!open && st.decidedBy && <span className="muted small">{st.status === 'approved' ? 'Approved' : 'Rejected'} by {nameOf(s, st.decidedBy)}</span>}
    </div>
  )
}

export function ProposalsPage({ done }: { done?: boolean }) {
  const { s, go, map } = useTeam()
  const list = s.strats.filter(x => !x.deleted && (done ? x.status !== 'proposed' && (x.baseId || x.decidedBy) : x.status === 'proposed')).sort((a, b) => b.updatedAt - a.updatedAt)
  const openN = s.strats.filter(isOpen).length
  return (
    <div className="tm-page">
      <div className="tm-page-head">
        <h1>Proposals</h1>
        <div className="ut-seg">
          <button className={!done ? 'on' : ''} onClick={() => go({ page: 'proposals' })}>Open{openN > 0 && ` (${openN})`}</button>
          <button className={done ? 'on' : ''} onClick={() => go({ page: 'proposals', done: true })}>Decided</button>
        </div>
        <p className="muted">Everyone votes with a thumb up or down. {isAdmin(s) ? 'You approve or reject at the end.' : 'An admin approves or rejects at the end.'}</p>
        <button className="ut-btn primary tm-page-cta" onClick={() => go({ page: 'edit', draft: newStrat(s, map), isNew: true })}><TI name="plus" size={15} /> Suggest a strat</button>
      </div>
      {!list.length && <div className="ut-empty">{done ? 'No decided proposals yet.' : <><b>No open proposals.</b> Open a strat and press “Suggest change”, or suggest a new one in the stratbook.</>}</div>}
      <div className="tm-props">
        {list.map(st => {
          const t = tally(s.votes, st.id)
          return (
            <article key={st.id} className="tm-prop" onClick={() => go({ page: 'strat', id: st.id })}>
              <div className="tm-prop-title">
                <span className="tm-mapdot" style={{ backgroundImage: `url(csutil://radar/${st.map}.png)` }} />
                <div><b>{st.title}</b><span className="muted small">{mapName(st.map)} · <SideBadge side={st.side} /> {kindLabel(st.kind)}{st.description ? ` · ${st.description}` : ''}</span></div>
                <span className="tm-prop-score" title={`${t.up} yes, ${t.down} no`}>{t.up - t.down > 0 ? '+' : ''}{t.up - t.down}</span>
              </div>
              <ProposalInfo st={st} compact />
            </article>
          )
        })}
      </div>
    </div>
  )
}
