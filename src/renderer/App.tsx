import { lazy, Suspense, useEffect, useState } from 'react'
import type { MatchData } from '../shared/model'
import type { Ref } from '../shared/analysis/rounds'
import { api, type MapMeta } from './api'
import { Library } from './views/Library'
import { ReplayView } from './replay/ReplayView'
import { StatsView } from './views/StatsView'
import { MultiRoundView } from './replay/MultiRoundView'
import { ReportView } from './views/ReportView'
import { mapLabel } from './format'
import { Icon } from './icons'
import { setWindowShown } from './replay3d/frameloop'
import { LogButtons } from './LogButtons'

// 3D-Replay erst beim Öffnen laden (three, Engine und Audio holt die View danach selbst per import())
const Replay3DView = lazy(() => import('./replay3d/Replay3DView').then(m => ({ default: m.Replay3DView })))
// Entwicklung: #hudpreview/<fixture> zeigt nur die Vorschau des Übertragungs-HUDs (Selbsttest CSDA_VIEW=hudpreview/normal)
const HudPreview = lazy(() => import('./replay3d/hud/Preview').then(m => ({ default: m.HudPreview })))
const PREVIEW = location.hash.startsWith('#hudpreview')
// Utility-Dashboard (eigene Lineups, unabhängig von Demos); Selbsttest #utility/... (UtilityView.tsx)
const UtilityView = lazy(() => import('./utility/UtilityView').then(m => ({ default: m.UtilityView })))
const UTILITY_HASH = location.hash.startsWith('#utility') ? location.hash.slice(1) : undefined
// Selbsttest: #lineup=<Lineup-JSON, URL-kodiert>[&at=<s>] zeigt nur die 3D-Vorschau des Lineups (CSDA_VIEW=lineup=…)
const LineupPreview3D = lazy(() => import('./utility/preview/LineupPreview3D').then(m => ({ default: m.LineupPreview3D })))
const LINEUP = location.hash.startsWith('#lineup=') ? JSON.parse(decodeURIComponent(location.hash.slice(8).split('&')[0])) : null
// Team-Seite (Stratbook, Vorschläge, Notizen; unabhängig von Demos); Selbsttest #team/...;mock=admin|player|new (team/TeamView.tsx)
const TeamView = lazy(() => import('./team/TeamView').then(m => ({ default: m.TeamView })))
const TEAM_HASH = location.hash.startsWith('#team') ? location.hash.slice(1) : undefined

const loadImg = (src?: string) => new Promise<HTMLImageElement | undefined>(res => {
  if (!src) return res(undefined)
  const i = new Image(); i.onload = () => res(i); i.onerror = () => res(undefined); i.src = src
})

type View = 'library' | 'utility' | 'team' | 'report' | 'replay' | 'replay3d' | 'multi' | 'stats'
export interface Jump { round: number; tick: number; n: number }

const NAV: [View, string, string][] = [
  ['report', 'Analysis', 'analysis'], ['replay', '2D replay', 'replay'], ['replay3d', '3D replay', 'cube'], ['multi', 'Multi-round', 'multi'], ['stats', 'Stats', 'stats'],
]

export function App() {
  if (LINEUP) return <Suspense fallback={null}><LineupPreview3D lineup={LINEUP} onClose={() => {}} /></Suspense>
  return PREVIEW ? <Suspense fallback={null}><HudPreview /></Suspense> : <MainApp />
}

function MainApp() {
  const [openIds, setOpenIds] = useState<string[]>([])
  const [matches, setMatches] = useState<MatchData[]>([])
  const [cur, setCur] = useState(0)
  const [map, setMap] = useState<{ meta: MapMeta; img?: HTMLImageElement; lower?: HTMLImageElement }>()
  const [view, setView] = useState<View>(UTILITY_HASH ? 'utility' : TEAM_HASH ? 'team' : 'library')
  const [jump, setJump] = useState<Jump>()
  // Sprünge aus der Analyse öffnen das zuletzt benutzte Replay (2D oder 3D)
  const [replayKind, setReplayKind] = useState<'replay' | 'replay3d'>('replay')
  const [reload, setReload] = useState(0)
  const [error, setError] = useState<string>()
  const [importing, setImporting] = useState<{ file: string; pct: number; msg: string } | null>(null)

  // Doppelklick auf eine .dem-Datei: Fortschritt zeigen, danach direkt die Analyse öffnen
  useEffect(() => {
    const offP = api.onProgress(p => setImporting(p.pct >= 95 ? null : p))
    const offO = api.onOpened(id => { setImporting(null); setOpenIds([id]); setView('report') }, msg => { setImporting(null); setError(msg) })
    return () => { offP(); offO() }
  }, [])
  useEffect(() => api.onWindowShown(setWindowShown), []) // minimiert: Bildtakt der Replays anhalten
  // andere Seiten wechseln die Ansicht per Ereignis 'csda:view' (Utility-Kopfzeile → Team-Seite)
  useEffect(() => { const h = (e: Event) => setView((e as CustomEvent<View>).detail); addEventListener('csda:view', h); return () => removeEventListener('csda:view', h) }, [])

  // Selbsttest: #auto/<view>/... öffnet das neueste Match
  useEffect(() => {
    const auto = location.hash.startsWith('#auto') ? location.hash.slice(1).split('/') : undefined
    if (!auto) return
    api.listMatches().then(l => { const m = l.sort((a, b) => b.parsedAt.localeCompare(a.parsedAt))[0]; if (m) setOpenIds([m.id]) })
    setView((auto[1] as View) || 'report')
  }, [])

  useEffect(() => {
    setMatches([]); setError(undefined); setCur(0)
    if (!openIds.length) return
    ;(async () => {
      const ms = await Promise.all(openIds.map(id => api.loadMatch(id)))
      const meta = await api.getMap(ms[0].map)
      if (!meta) { setError(`No radar data for ${ms[0].map}`); return }
      const [img, lower] = await Promise.all([loadImg(meta.image), loadImg(meta.lowerImage)])
      setMap({ meta, img, lower }); setMatches(ms)
    })().catch(e => setError(String(e)))
  }, [openIds.join(), reload])

  const match = matches[cur]
  const openRef = (r: Ref) => {
    const i = matches.findIndex(m => m.id === r.matchId)
    if (i >= 0) setCur(i)
    setView(replayKind); setJump({ round: r.round, tick: r.tick, n: Date.now() })
  }
  const open = (ids: string[]) => { setOpenIds(ids); setView('report') }
  const go = (v: View) => { setView(v); if (v === 'replay' || v === 'replay3d') setReplayKind(v) }
  // Team-Lesezeichen: lokale Demo an Runde/Tick im 2D- oder 3D-Replay öffnen
  const openDemo = (id: string, round: number, tick: number, kind: 'replay' | 'replay3d') => { setOpenIds([id]); go(kind); setJump({ round, tick, n: Date.now() }) }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">CS<span>Demo</span>Analysis</div>
        <button className={`nav ${view === 'library' ? 'on' : ''}`} onClick={() => setView('library')}><Icon name="library" /> Demos</button>
        <button className={`nav ${view === 'utility' ? 'on' : ''}`} onClick={() => setView('utility')}><Icon name="nade" /> Utility</button>
        <button className={`nav ${view === 'team' ? 'on' : ''}`} onClick={() => setView('team')}><Icon name="team" /> Team</button>
        {openIds.length > 0 && (
          <>
            <div className="nav-sep" />
            {match && (
              <div className="match-card">
                {map?.meta.image && <img src={map.meta.image} alt="" />}
                <div>
                  <b>{mapLabel(match.map)}</b>
                  {matches.length > 1 ? (
                    <select value={cur} onChange={e => setCur(Number(e.target.value))}>
                      {matches.map((m, i) => <option key={m.id} value={i}>Demo {i + 1}: {m.teams.map(t => m.finalScore[t]).join(':')}</option>)}
                    </select>
                  ) : <div className="small">{match.teams.map(t => `${t} ${match.finalScore[t]}`).join(' : ')}</div>}
                </div>
              </div>
            )}
            {NAV.map(([k, label, icon]) => (
              <button key={k} className={`nav ${view === k ? 'on' : ''}`} disabled={!match} onClick={() => go(k)}>
                <Icon name={icon} /> {k === 'report' && matches.length > 1 ? `${label} (${matches.length})` : label}
              </button>
            ))}
          </>
        )}
        <LogButtons />
      </aside>
      <main>
        {importing && view !== 'library' && (
          <div className="toast">
            <div className="small">Importing {importing.file.split(/[\\/]/).pop()} · {importing.msg}</div>
            <div className="bar"><div style={{ width: `${importing.pct}%` }} /></div>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        {view === 'library' && <Library onOpen={id => open([id])} onAnalyze={open} />}
        {view === 'utility' && <Suspense fallback={<div className="center muted pad">Loading utility…</div>}><UtilityView hash={UTILITY_HASH} /></Suspense>}
        {view === 'team' && <Suspense fallback={<div className="center muted pad">Loading team…</div>}><TeamView hash={TEAM_HASH} onOpenDemo={openDemo} /></Suspense>}
        {view !== 'library' && view !== 'utility' && view !== 'team' && !match && !error &&<div className="center muted pad">Loading {openIds.length > 1 ? `${openIds.length} demos` : 'match'}…</div>}
        {match && map && view === 'report' && <ReportView matches={matches} onRef={openRef} />}
        {match && map && view === 'replay' && <ReplayView key={match.id} match={match} map={map.meta} img={map.img} lowerImg={map.lower} jump={jump} />}
        {match && map && view === 'replay3d' && (
          <Suspense fallback={<div className="center muted pad">Loading 3D replay…</div>}>
            <Replay3DView key={match.id} match={match} map={map.meta} img={map.img} lowerImg={map.lower} jump={jump} onReimported={() => setReload(n => n + 1)} onExit={() => go('replay')} />
          </Suspense>
        )}
        {match && map && view === 'multi' && <MultiRoundView key={match.id} match={match} map={map.meta} img={map.img} lowerImg={map.lower} />}
        {match && view === 'stats' && <StatsView key={match.id} match={match} />}
      </main>
    </div>
  )
}
