// Team-Seite (Seitenleiste „Team“, unabhängig von Demos): Kopfzeile mit Reitern, Seiten Dashboard / Stratbook / Strat / Vorschläge /
// Lineups / Notizen / Roster, ohne Team „Erstellen / Beitreten“. Daten nur über `team` (index.ts).
// Selbsttest-Hash: #team[/home|strats[/<map>]|strat/<id>|edit/<id>|new|proposals[/done]|lineups[/<map>]|lineup/<id>|notes[/<id>]|roster];mock=admin|player|new
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react'
import type { MatchSummary } from '../../shared/model'
import type { Lineup } from '../../shared/utility'
import { api } from '../api'
import { team } from '.'
import { Dashboard } from './Dashboard'
import { LineupPage, LineupsPage } from './Lineups'
import { isAdmin, isOpen } from './logic'
import { NotesPage } from './Notes'
import { ProposalsPage } from './Proposals'
import { Roster } from './Roster'
import { StratPage, newStrat } from './StratPage'
import { Stratbook } from './Stratbook'
import { AdminBadge, Avatar, TI, TeamCtx, errText, firstMap, useTeam, type TCtx, type TRoute } from './tui'
import '../utility/utility.css'
import './team.css'

const LineupPreview3D = lazy(() => import('../utility/preview/LineupPreview3D').then(m => ({ default: m.LineupPreview3D })))

function fromHash(hash: string, s: TCtx['s']): TRoute {
  const [, page, arg] = hash.split(';')[0].split('/')
  if (page === 'strats' || page === 'lineups') return { page, map: arg }
  if (page === 'strat' || page === 'lineup') return { page, id: arg }
  if (page === 'edit') { const st = s.strats.find(x => x.id === arg); return st ? { page: 'edit', draft: st } : { page: 'home' } }
  if (page === 'new') return { page: 'edit', draft: newStrat(s, firstMap(s)), isNew: true }
  if (page === 'proposals') return { page, done: arg === 'done' }
  if (page === 'notes') return { page, id: arg }
  if (page === 'roster') return { page }
  return { page: 'home' }
}

const TABS: [TRoute['page'], string, Parameters<typeof TI>[0]['name']][] = [
  ['home', 'Dashboard', 'home'], ['strats', 'Stratbook', 'book'], ['proposals', 'Proposals', 'vote'], ['lineups', 'Lineups', 'nade'], ['notes', 'Notes', 'note'], ['roster', 'Roster', 'users'],
]
const tabOf = (p: TRoute['page']) => (p === 'strat' || p === 'edit' ? 'strats' : p === 'lineup' ? 'lineups' : p)

export function TeamView({ hash = '', onOpenDemo }: { hash?: string; onOpenDemo: TCtx['openDemo'] }) {
  const s = useSyncExternalStore(team.subscribe, team.state)
  const [maps, setMaps] = useState<TCtx['maps']>()
  const [matches, setMatches] = useState<MatchSummary[]>([])
  const [route, setRoute] = useState<TRoute>(() => fromHash(hash, team.state()))
  const [map, setMap] = useState(() => firstMap(team.state()))
  const [toast, setToast] = useState<{ msg: string; bad?: boolean; n: number }>()
  const [prev, setPrev] = useState<Lineup>()

  useEffect(() => { api.utilityMaps().then(setMaps, e => setToast({ msg: `Radar data missing: ${errText(e)}`, bad: true, n: Date.now() })); api.listMatches().then(setMatches, () => {}) }, [])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(undefined), toast.bad ? 7000 : 3000); return () => clearTimeout(t) }, [toast])

  if (!maps) return <div className="ut tm"><div className="ut-empty pad muted">Loading team…</div></div>
  const notify: TCtx['notify'] = (msg, bad) => setToast({ msg, bad, n: Date.now() })
  const run: TCtx['run'] = (p, ok) => p.then(() => { if (ok) notify(ok); return true }, e => { notify(errText(e), true); return false })
  const go = (r: TRoute) => { setRoute(r); document.querySelector('.tm .ut-body')?.scrollTo(0, 0) }
  const ctx: TCtx = { s, maps, matches, route, go, notify, run, preview: setPrev, openDemo: onOpenDemo, map, setMap }
  const open = s.strats.filter(isOpen).length

  return (
    <TeamCtx.Provider value={ctx}>
      <div className="ut tm">
        <header className="ut-head tm-head">
          <button className="ut-logo" onClick={() => go({ page: 'home' })}><svg viewBox="-16 -16 32 32" width="22" height="22"><polygon points="13,7.5 0,15 -13,7.5 -13,-7.5 0,-15 13,-7.5" /></svg>TEAM</button>
          {s.team && <span className="tm-teamname">{s.team.name}</span>}
          {s.team && (
            <nav className="tm-tabs">
              {TABS.map(([p, label, icon]) => (
                <button key={p} className={tabOf(route.page) === p ? 'on' : ''} onClick={() => go(p === 'strats' || p === 'lineups' ? { page: p, map } : ({ page: p } as TRoute))}>
                  <TI name={icon} size={16} />{label}{p === 'proposals' && open > 0 && <em>{open}</em>}
                </button>
              ))}
            </nav>
          )}
          <div className="ut-head-actions">
            <span className={`tm-sync ${s.error ? 'bad' : s.syncing ? 'busy' : s.online ? 'ok' : 'off'}`} title={s.error ?? (s.syncing ? 'Syncing…' : s.online ? 'Online: changes are shared with your team' : 'Offline: changes are sent when you are back online')}>
              <i />{s.error ? 'Sync error' : s.syncing ? 'Syncing' : s.online ? 'Online' : 'Offline'}
            </span>
            {s.me && <span className="tm-me"><Avatar m={s.me} size={26} />{s.me.name}{isAdmin(s) && <AdminBadge />}</span>}
          </div>
        </header>
        <div className="ut-body">
          {!s.team || !s.me ? <Onboarding /> : <>
            {route.page === 'home' && <Dashboard />}
            {route.page === 'strats' && <Stratbook />}
            {route.page === 'strat' && <StratPage key={route.id} id={route.id} />}
            {route.page === 'edit' && <StratPage key={route.draft.id + 'e'} id={route.draft.id} draft={route.draft} isNew={route.isNew} />}
            {route.page === 'proposals' && <ProposalsPage done={route.done} />}
            {route.page === 'lineups' && <LineupsPage />}
            {route.page === 'lineup' && <LineupPage key={route.id} id={route.id} />}
            {route.page === 'notes' && <NotesPage id={route.id} />}
            {route.page === 'roster' && <Roster />}
          </>}
        </div>
        {prev && <div className="ut-preview-layer"><Suspense fallback={null}><LineupPreview3D lineup={prev} onClose={() => setPrev(undefined)} /></Suspense></div>}
        {toast && <div key={toast.n} className={`ut-toast ${toast.bad ? 'bad' : ''}`}>{toast.msg}</div>}
      </div>
    </TeamCtx.Provider>
  )
}

/** ohne Team: erstellen oder mit Code beitreten */
function Onboarding() {
  const { s, run } = useTeam()
  const [name, setName] = useState(''), [teamName, setTeamName] = useState(''), [code, setCode] = useState('')
  return (
    <div className="tm-onboard">
      <div className="tm-onboard-intro">
        <h1>Play as a team</h1>
        <p>One stratbook for your five. Everyone adds lineups and suggests strats, everyone votes, your IGL approves. Your demos stay on your PC.</p>
        {s.error && <div className="ut-toast bad tm-inline-err">{s.error}</div>}
      </div>
      <label className="tm-field tm-onboard-name"><span>Your name in the team</span><input className="ut-input big" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. your in-game name" maxLength={24} /></label>
      <div className="tm-onboard-cards">
        <form className="tm-onboard-card" onSubmit={e => { e.preventDefault(); run(team.create(teamName, name), 'Team created. You are the admin.') }}>
          <span className="tm-onboard-ico"><TI name="crown" size={26} /></span>
          <h2>Create a team</h2>
          <p>You become the admin. Invite the others with a code.</p>
          <input className="ut-input" value={teamName} onChange={e => setTeamName(e.target.value)} placeholder="Team name" maxLength={32} />
          <button className="ut-btn primary big" disabled={!teamName.trim() || !name.trim()}>Create team</button>
        </form>
        <form className="tm-onboard-card" onSubmit={e => { e.preventDefault(); run(team.join(code, name), 'You joined the team') }}>
          <span className="tm-onboard-ico"><TI name="key" size={26} /></span>
          <h2>Join with a code</h2>
          <p>Ask your IGL for the invite code.</p>
          <input className="ut-input tm-code" value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="TEAM-0000" maxLength={16} />
          <button className="ut-btn primary big" disabled={!code.trim() || !name.trim()}>Join team</button>
        </form>
      </div>
    </div>
  )
}
