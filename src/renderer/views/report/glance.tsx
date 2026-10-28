// „At a glance“: 7 Karten mit Ampel, schlimmste Runden als Chips (Replay), „+ Review“ und 3 Trainingsziele (Team-Notizen über ../../team)
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { MatchData } from '../../../shared/model'
import { goals as pickGoals, type Card, type CardId, type Pick } from '../../../shared/analysis/glance'
import type { Light } from '../../../shared/analysis/lights'
import type { Bookmark, Note, TeamApi, TeamState } from '../../../shared/team'
import { Icon } from '../../icons'
import { isAdmin } from '../../team/logic'
import { mapLabel } from '../../format'
import { ReportCtx, TokenIcon } from './ui'

/** Team-Zugriff erst beim Öffnen des Reports laden (Sync startet sonst schon beim App-Start) */
export function useTeamApi(): { api: TeamApi; s: TeamState } | undefined {
  const [t, setT] = useState<{ api: TeamApi; s: TeamState }>()
  useEffect(() => {
    let live = true, off = () => {}
    import('../../team').then(({ team }) => {
      if (!live) return
      setT({ api: team, s: team.state() })
      off = team.subscribe(s => setT({ api: team, s }))
    }, () => {})
    return () => { live = false; off() }
  }, [])
  return t
}

const ICON: Record<CardId, ReactNode> = {
  opening: <Icon name="xhair" size={17} />, trades: <Icon name="shuffle" size={17} />, advantage: <Icon name="team" size={17} />,
  rounds: <TokenIcon t="deagle" size={15} />, t: <TokenIcon t="c4" size={15} />, ct: <TokenIcon t="kit" size={15} />, util: <TokenIcon t="flash" size={15} />,
}
const LIGHT: Record<Light, string> = { good: 'On track', warn: 'Watch', bad: 'Fix' }

/** Chips mit Grund im Tooltip; Klick öffnet das Replay an der Stelle */
export function PickChips({ picks }: { picks: Pick[] }) {
  const c = useContext(ReportCtx)
  return <span className="rp-chips">{picks.map(p => {
    const w = c.won(p.ref)
    return <button key={`${p.ref.matchId}:${p.ref.round}`} className={`rchip ${w === undefined ? 'n' : w ? 'w' : 'l'}`} title={`${p.why} · watch in replay`} onClick={() => c.onRef(p.ref)}>{c.label(p.ref)}</button>
  })}</span>
}

export interface Who { us: string; them: string; map: string; matches: MatchData[]; score: string }

const bookmarks = (picks: Pick[], matches: MatchData[]): Bookmark[] => picks.flatMap(p => {
  const m = matches.find(x => x.id === p.ref.matchId)
  return m ? [{ demoKey: m.id, demoName: m.fileName, round: p.ref.round, tick: p.ref.tick, label: p.why }] : []
})

function CardView({ c, dim, onReview }: { c: Card; dim: boolean; onReview?: () => void }) {
  return (
    <article className={`gl-card ${c.light ?? 'none'} ${dim ? 'dim' : ''}`}>
      <header>
        <span className="gl-ico">{ICON[c.id]}</span>
        <h3>{c.title}</h3>
        <span className="gl-light" title={c.light ? undefined : 'Too few rounds for a rating'}><i />{c.light ? LIGHT[c.light] : 'Few rounds'}</span>
      </header>
      <div className="gl-num">{c.value}<span>{c.unit}</span></div>
      <p className="gl-text">{c.text}</p>
      {c.facts.length > 0 && <div className="gl-facts">{c.facts.map((f, i) => <span key={i} className={f.tone ?? ''}>{f.text}</span>)}</div>}
      <footer>
        {c.rounds.length ? <PickChips picks={c.rounds} /> : <span className="muted small">No rounds to review</span>}
        {onReview && c.rounds.length > 0 && <button className="ghost gl-review" onClick={onReview} title="Add these rounds to a review playlist in the team notes">+ Review</button>}
      </footer>
    </article>
  )
}

export type TeamHandle = ReturnType<typeof useTeamApi>
export function GlanceView({ cards, who, t, player, playerName, onClearPlayer }: { cards: Card[]; who: Who; t: TeamHandle; player?: string; playerName?: string; onClearPlayer: () => void }) {
  const [msg, setMsg] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // neue Meldung: alte Ausblende-Uhr weg (sonst verschwindet z. B. das zweite „+ Review“ nach Bruchteilen einer Sekunde)
  const say = (m: string) => { setMsg(m); clearTimeout(timer.current); timer.current = setTimeout(() => setMsg(''), 2500) }
  const inTeam = !!t?.s.team && !!t.s.me
  const goals = pickGoals(cards)
  const run = (p: Promise<unknown>, ok: string) => p.then(() => say(ok), e => say(`Failed: ${String((e as Error)?.message ?? e)}`))

  const review = (c: Card) => {
    const { api, s } = t!, me = s.me!, title = `Review: ${mapLabel(who.map)} vs ${who.them}`.slice(0, 60)
    const old = s.notes.find(n => n.kind === 'review' && !n.deleted && n.title === title && n.author === me.id)
    const add = bookmarks(c.rounds, who.matches).filter(b => !old?.bookmarks.some(o => o.demoKey === b.demoKey && o.round === b.round))
    if (!add.length) return say('Already in the review playlist')
    const note: Note = old ? { ...old, bookmarks: [...old.bookmarks, ...add], updatedAt: Date.now() }
      : { id: crypto.randomUUID(), teamId: s.team!.id, kind: 'review', title, date: Date.now(), map: who.map, opponent: who.them, text: '', bookmarks: add, author: me.id, updatedAt: Date.now() }
    run(api.saveNote(note), `Added ${add.length} round${add.length > 1 ? 's' : ''} to “${title}”`)
  }
  const saveGoals = () => {
    const { api, s } = t!
    run(api.saveNote({
      id: crypto.randomUUID(), teamId: s.team!.id, kind: 'scrim', title: `vs ${who.them}`.slice(0, 60), date: Date.now(), map: who.map, opponent: who.them, result: who.score,
      text: `Goals for the next practice:\n${goals.map((g, i) => `${i + 1}. ${g.goal}`).join('\n')}\n\n${cards.map(c => `${c.title}: ${c.value} ${c.unit}`).join('\n')}`,
      bookmarks: bookmarks(goals.flatMap(g => g.rounds), who.matches), author: s.me!.id, updatedAt: Date.now(),
    }), 'Saved as team note')
  }
  const setFocus = () => {
    const { api, s } = t!
    run(api.saveTeam({ ...s.team!, focus: `${mapLabel(who.map)}: ${goals.map(g => g.focus).join('. ')}.`.slice(0, 200) }), 'Focus of the week set')
  }

  return (
    <>
      {player && (
        <div className="gl-filter">
          <Icon name="team" size={15} /> Cards for <b>{playerName}</b>
          <span className="muted small">Team-wide cards are dimmed.</span>
          <button className="ghost" onClick={onClearPlayer} title="Show the whole team"><Icon name="x" size={14} /> Whole team</button>
        </div>
      )}
      <div className="gl-grid">{cards.map(c => <CardView key={c.id} c={c} dim={!!player && c.team} onReview={inTeam ? () => review(c) : undefined} />)}</div>

      <section className="gl-goals">
        <h2><Icon name="target" size={18} /> 3 goals for the next practice</h2>
        {goals.length ? (
          <ol>{goals.map(g => (
            <li key={g.id} className={g.light}>
              <span className="gl-ico">{ICON[g.id]}</span>
              <div><b>{g.goal}</b><span className="muted small">{g.title}: {g.value} {g.unit}</span></div>
            </li>
          ))}</ol>
        ) : <p className="muted">No red or yellow cards. Keep doing what you did.</p>}
        {inTeam && goals.length > 0 && (
          <div className="gl-actions">
            <button onClick={saveGoals}><Icon name="clipboard" size={15} /> Save as team note</button>
            {isAdmin(t!.s) && <button onClick={setFocus}><Icon name="star" size={15} /> Set as focus of the week</button>}
          </div>
        )}
      </section>
      {msg && <div className="gl-toast" role="status">{msg}</div>}
    </>
  )
}
