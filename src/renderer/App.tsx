import { useEffect, useState } from 'react'
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

const loadImg = (src?: string) => new Promise<HTMLImageElement | undefined>(res => {
  if (!src) return res(undefined)
  const i = new Image(); i.onload = () => res(i); i.onerror = () => res(undefined); i.src = src
})

type View = 'library' | 'report' | 'replay' | 'multi' | 'stats'
export interface Jump { round: number; tick: number; n: number }

const NAV: [View, string, string][] = [
  ['report', 'Analysis', 'analysis'], ['replay', '2D replay', 'replay'], ['multi', 'Multi-round', 'multi'], ['stats', 'Stats', 'stats'],
]

export function App() {
  const [openIds, setOpenIds] = useState<string[]>([])
  const [matches, setMatches] = useState<MatchData[]>([])
  const [cur, setCur] = useState(0)
  const [map, setMap] = useState<{ meta: MapMeta; img?: HTMLImageElement; lower?: HTMLImageElement }>()
  const [view, setView] = useState<View>('library')
  const [jump, setJump] = useState<Jump>()
  const [error, setError] = useState<string>()
  const [importing, setImporting] = useState<{ file: string; pct: number; msg: string } | null>(null)

  // Doppelklick auf eine .dem-Datei: Fortschritt zeigen, danach direkt die Analyse öffnen
  useEffect(() => {
    const offP = api.onProgress(p => setImporting(p.pct >= 95 ? null : p))
    const offO = api.onOpened(id => { setImporting(null); setOpenIds([id]); setView('report') }, msg => { setImporting(null); setError(msg) })
    return () => { offP(); offO() }
  }, [])

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
  }, [openIds.join()])

  const match = matches[cur]
  const openRef = (r: Ref) => {
    const i = matches.findIndex(m => m.id === r.matchId)
    if (i >= 0) setCur(i)
    setView('replay'); setJump({ round: r.round, tick: r.tick, n: Date.now() })
  }
  const open = (ids: string[]) => { setOpenIds(ids); setView('report') }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">CS<span>Demo</span>Analysis</div>
        <button className={`nav ${view === 'library' ? 'on' : ''}`} onClick={() => setView('library')}><Icon name="library" /> Demos</button>
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
              <button key={k} className={`nav ${view === k ? 'on' : ''}`} disabled={!match} onClick={() => setView(k)}>
                <Icon name={icon} /> {k === 'report' && matches.length > 1 ? `${label} (${matches.length})` : label}
              </button>
            ))}
          </>
        )}
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
        {view !== 'library' && !match && !error && <div className="center muted pad">Loading {openIds.length > 1 ? `${openIds.length} demos` : 'match'}…</div>}
        {match && map && view === 'report' && <ReportView matches={matches} onRef={openRef} />}
        {match && map && view === 'replay' && <ReplayView key={match.id} match={match} map={map.meta} img={map.img} lowerImg={map.lower} jump={jump} />}
        {match && map && view === 'multi' && <MultiRoundView key={match.id} match={match} map={map.meta} img={map.img} lowerImg={map.lower} />}
        {match && view === 'stats' && <StatsView key={match.id} match={match} />}
      </main>
    </div>
  )
}
