// Team-Seite: Kontext, Icons und kleine Bausteine (Avatar, Abstimmung, Lern-Status, Map-Leiste). Optik wie das Utility-Dashboard (.ut-*)
import { createContext, useContext, useState, type ReactNode } from 'react'
import type { MatchSummary } from '../../shared/model'
import type { Member, ProgressStatus, Strat, TeamState } from '../../shared/team'
import type { Lineup } from '../../shared/utility'
import type { RadarMeta } from '../../shared/utility-api'
import { POOL, mapColor, mapName, radarUrl } from '../utility/maps'
import { team } from '.'
import { PROGRESS, progressOf, tally } from './logic'

export type TRoute =
  | { page: 'home' }
  | { page: 'strats'; map?: string }
  | { page: 'strat'; id: string }
  | { page: 'edit'; draft: Strat; isNew?: boolean }
  | { page: 'proposals'; done?: boolean }
  | { page: 'lineups'; map?: string }
  | { page: 'lineup'; id: string }
  | { page: 'notes'; id?: string }
  | { page: 'roster' }

export interface TCtx {
  s: TeamState
  maps: { meta: Record<string, RadarMeta>; radars: string[] }
  /** importierte Demos (Lesezeichen, Win-Rate) */
  matches: MatchSummary[]
  route: TRoute
  go: (r: TRoute) => void
  notify: (msg: string, bad?: boolean) => void
  /** Team-Aufruf mit Meldung bei Erfolg/Fehler; Rückgabe true = geklappt */
  run: (p: Promise<unknown>, ok?: string) => Promise<boolean>
  preview: (l: Lineup) => void
  openDemo: (matchId: string, round: number, tick: number, kind: 'replay' | 'replay3d') => void
  /** Map, die zuletzt im Stratbook/bei den Lineups gewählt war */
  map: string
  setMap: (m: string) => void
}
export const TeamCtx = createContext<TCtx>(null as never)
export const useTeam = () => useContext(TeamCtx)
export const nameOf = (s: TeamState, id?: string) => s.members.find(m => m.id === id)?.name ?? (id ? 'Former member' : '–')
export const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const P: Record<string, string> = {
  up: 'M7 10v10H4V10zM7 10l4-7c1.5 0 2.5 1 2 3l-1 3h6a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 16.8 20H7',
  down: 'M17 14V4h3v10zM17 14l-4 7c-1.5 0-2.5-1-2-3l1-3H6a2 2 0 0 1-2-2.3l1.2-6A2 2 0 0 1 7.2 4H17',
  pen: 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3',
  plus: 'M12 5v14M5 12h14',
  crown: 'M3 8l4 4 5-7 5 7 4-4-2 11H5z',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  pos: 'M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10',
  arrow: 'M5 19L19 5M10 5h9v9',
  path: 'M4 19c4 0 3-7 8-7s4-7 8-7',
  zone: 'M5 6l12-2 3 10-9 6-7-5z',
  text: 'M5 7V4h14v3M12 4v16M9 20h6',
  erase: 'M16 3l5 5-11 11H5l-2-2 9-9M8 11l5 5M11 19h10',
  book: 'M4 19V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0 0 4h14',
  note: 'M5 3h10l4 4v14H5zM15 3v4h4M8 12h8M8 16h6',
  users: 'M9 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8M2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6',
  home: 'M3 11l9-8 9 8M5 9v12h14V9M10 21v-6h4v6',
  flag: 'M5 21V4M5 4h12l-2 4 2 4H5',
  start: 'M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11zM12 8a2 2 0 1 0 0 4a2 2 0 1 0 0-4',
  key: 'M15 3a6 6 0 1 1-5.2 9L3 18.8V21h3v-2h2v-2h2l1.8-1.8A6 6 0 0 1 15 3M16 8h.01',
  leave: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  vote: 'M9 12l2 2 4-4M5 3h14v18H5z',
  nade: 'M7 14a5 5 0 1 0 10 0a5 5 0 1 0-10 0M10 9V6h4v3M14 7l3 3',
}
export function TI({ name, size = 18, fill }: { name: keyof typeof P; size?: number; fill?: boolean }) {
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  )
}

/** Farbe je Mitglied (fest aus der ID) */
const HUES = [32, 205, 140, 330, 265, 0, 180, 50]
export const memberColor = (id = '') => `hsl(${HUES[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length]} 70% 62%)`
export function Avatar({ m, size = 30 }: { m?: Pick<Member, 'id' | 'name'>; size?: number }) {
  return <span className="tm-avatar" style={{ width: size, height: size, fontSize: size * 0.45, '--c': memberColor(m?.id) } as React.CSSProperties} title={m?.name}>{m?.name.slice(0, 1).toUpperCase() ?? '?'}</span>
}
export const AdminBadge = () => <span className="tm-admin" title="Admin: approves proposals, manages roles"><TI name="crown" size={12} /> Admin</span>

/** Daumen hoch/runter mit Zählung, eigener Stimme und optionalem Kommentar */
export function VoteBox({ strat, compact }: { strat: Strat; compact?: boolean }) {
  const { s, run } = useTeam()
  const t = tally(s.votes, strat.id, s.me?.id)
  const [comment, setComment] = useState<string>()
  const open = strat.status === 'proposed'
  const vote = (v: 1 | -1) => run(team.vote(strat.id, v, comment ?? s.votes.find(x => x.stratId === strat.id && x.memberId === s.me?.id)?.comment), v === 1 ? 'Voted yes' : 'Voted no').then(ok => ok && setComment(undefined))
  return (
    <div className={`tm-vote ${compact ? 'compact' : ''}`} onClick={e => e.stopPropagation()}>
      <div className="tm-vote-btns">
        <button className={`tm-thumb up ${t.mine === 1 ? 'on' : ''}`} disabled={!open} onClick={() => vote(1)} title="Vote yes"><TI name="up" size={17} /><b>{t.up}</b></button>
        <button className={`tm-thumb down ${t.mine === -1 ? 'on' : ''}`} disabled={!open} onClick={() => vote(-1)} title="Vote no"><TI name="down" size={17} /><b>{t.down}</b></button>
        {!compact && open && (comment == null
          ? <button className="ut-link small" onClick={() => setComment('')}>Add comment</button>
          : <input className="ut-input tm-vote-input" autoFocus placeholder="Comment (optional), then vote" value={comment} onChange={e => setComment(e.target.value)} />)}
      </div>
      {!compact && t.comments.length > 0 && (
        <ul className="tm-comments">
          {t.comments.map(c => (
            <li key={c.memberId}><Avatar m={s.members.find(m => m.id === c.memberId) ?? { id: c.memberId, name: '?' }} size={22} />
              <span className={`tm-comment-v ${c.value === 1 ? 'up' : 'down'}`}><TI name={c.value === 1 ? 'up' : 'down'} size={12} /></span>
              <p><b>{nameOf(s, c.memberId)}</b> {c.comment}</p></li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** eigener Lern-Status zu einer Strat oder einem Lineup */
export function LearnSeg({ refTo }: { refTo: { strat: string } | { lineup: string } }) {
  const { s, run } = useTeam()
  const cur = progressOf(s.progress, s.me?.id, refTo)
  const set = (status: ProgressStatus) => s.me && run(team.setProgress({ memberId: s.me.id, ref: refTo, status, updatedAt: Date.now() }))
  return (
    <div className="tm-learn" role="group" aria-label="Your learning status">
      {PROGRESS.map(p => <button key={p.id} className={`${p.id} ${cur === p.id ? 'on' : ''}`} onClick={() => set(p.id)}><i />{p.label}</button>)}
    </div>
  )
}
export const LearnDot = ({ status }: { status?: ProgressStatus }) => <i className={`tm-ldot ${status ?? 'none'}`} title={status ? PROGRESS.find(p => p.id === status)!.label : 'Not started'} />

/** Map-Leiste: Pool-Kacheln (Status aus dem Team-Map-Pool, Permaban ausgegraut), Zahl rechts oben */
export function MapStrip({ value, onPick, count }: { value: string; onPick: (m: string) => void; count: (m: string) => number }) {
  const { s, maps } = useTeam()
  const pool = poolOf(s).filter(p => maps.meta[p.map] && p.status !== 'off')
  return (
    <div className="tm-strip">
      {pool.map(p => (
        <button key={p.map} className={`tm-stile ${p.status} ${value === p.map ? 'on' : ''}`} style={{ '--m': mapColor(p.map) } as React.CSSProperties} onClick={() => onPick(p.map)}
          title={p.status === 'permaban' ? `${mapName(p.map)}: permaban` : mapName(p.map)}>
          <img src={radarUrl(p.map)} alt="" decoding="async" />
          <span>{mapName(p.map)}</span>
          {p.status === 'permaban' ? <small>Permaban</small> : count(p.map) > 0 && <em>{count(p.map)}</em>}
        </button>
      ))}
    </div>
  )
}
export const STATUS_LABEL = { main: 'Main', practice: 'Practice', permaban: 'Permaban', off: 'Not in pool' } as const
/** Map-Pool des Teams, fehlende Pool-Maps als „practice“ ergänzt, in Pool-Reihenfolge */
export function poolOf(s: TeamState) {
  const own = s.team?.mapPool ?? []
  const all = [...POOL, ...own.map(p => p.map).filter(m => !POOL.includes(m))]
  return all.map(m => own.find(p => p.map === m) ?? { map: m, status: 'practice' as const })
}
export const firstMap = (s: TeamState) => poolOf(s).find(p => p.status === 'main')?.map ?? POOL[0]

export function Section({ icon, title, extra, children }: { icon: keyof typeof P; title: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return <section className="tm-sec"><h3><TI name={icon} size={17} /> {title}{extra && <span className="tm-sec-extra">{extra}</span>}</h3>{children}</section>
}
