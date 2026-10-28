// Utility-Dashboard (Seitenleiste „Utility“, unabhängig von Demos): lädt die Bibliothek, speichert jede Änderung (kurz verzögert, beim
// Verlassen sofort), Kopfzeile mit Import/Export und Team-Status, Seiten Start / Map / Lineup / Editor, 3D-Vorschau als Ebene.
// Selbsttest-Hash: #utility[/<map>[/radar|list|cards|focus|playbook|export|lineup[/<id>[/clip]]|add/<schritt>]] oder #utility/import (Datei aus CSDA_UTIL_IMPORT);
// #utility/capture rendert statt des Dashboards die Bilder aller Lineups der Datei (capture/CaptureAll.tsx, Startpaket)
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Lineup, UtilityLibrary } from '../../shared/utility'
import { api } from '../api'
import { Icon } from '../icons'
import { Detail } from './Detail'
import { Editor } from './Editor'
import { Home } from './Home'
import { ExportDialog, ImportDialog, type ImportData } from './ImportExport'
import { MapPage } from './MapPage'
import { mapName } from './maps'
import { newDraft } from './ops'
import { MapsStatus } from './preview/MapsStatus'
import { ClipDialog } from './TeamClip'
import { teamStore } from '../team/store'
import { UtilCtx, live, type Ctx, type Route } from './ui'
import './utility.css'

// 3D-Vorschau erst beim Öffnen laden (der Vorschau-Zweig bringt three.js mit)
const LineupPreview3D = lazy(() => import('./preview/LineupPreview3D').then(m => ({ default: m.LineupPreview3D })))
const CaptureAll = lazy(() => import('./capture/CaptureAll').then(m => ({ default: m.CaptureAll })))
type Mode = 'radar' | 'list' | 'cards'
const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Start-Seite aus dem Selbsttest-Hash (nach dem Laden, weil Lineup-Seiten die Bibliothek brauchen) */
function fromHash(hash: string, lib: UtilityLibrary): { route: Route; mode?: Mode; importNow?: boolean; exportNow?: boolean; clipTest?: boolean } {
  const [, map, sub, arg, extra] = hash.split('/')
  if (!map) return { route: { page: 'home' } }
  if (map === 'import') return { route: { page: 'home' }, importNow: true }
  const home: Route = { page: 'map', map }, on = live(lib).filter(l => l.map === map)
  if (sub === 'radar' || sub === 'list' || sub === 'cards') return { route: home, mode: sub }
  if (sub === 'export') return { route: home, exportNow: true }
  if (sub === 'focus') { // Ziel mit den meisten Lineups gewählt (Standpunkte + Wurflinien sichtbar)
    const near = (l: (typeof on)[number]) => on.filter(x => x.type === l.type && Math.hypot(x.target.x - l.target.x, x.target.y - l.target.y) < 80).length
    return { route: { page: 'map', map, focus: [...on].sort((a, b) => near(b) - near(a))[0]?.id }, mode: 'radar' }
  }
  if (sub === 'playbook') return { route: { page: 'map', map, playbook: lib.playbooks.find(p => !p.deleted && p.map === map)?.id } }
  if (sub === 'lineup') {
    // Team-Lineups kommen erst nach dem Laden des Team-Caches: eine genannte ID gilt auch, wenn sie lokal fehlt
    const l = on.find(l => l.id === arg) ?? (arg ? { id: arg } : [...on].sort((a, b) => b.images.length + b.steps.length - a.images.length - a.steps.length)[0])
    return { route: l ? { page: 'lineup', id: l.id, back: home } : home, clipTest: !!l && extra === 'clip' } // …/lineup/<id>/clip: Clip-Selbsttest
  }
  if (sub === 'add') {
    const step = Number(arg) || 2, src = on[0] // ab Schritt 3 Stand/Ziel/Typ eines vorhandenen Lineups (sonst ist das Radar leer)
    const draft = { ...newDraft(map), ...(step >= 3 && src ? { stand: src.stand, target: src.target, type: src.type, side: src.side } : {}) }
    return { route: { page: 'edit', draft, isNew: true, step, back: home } }
  }
  return { route: home }
}

export const UtilityView = ({ hash = '' }: { hash?: string }) =>
  hash === 'utility/capture' ? <Suspense fallback={null}><CaptureAll /></Suspense> : <Utility hash={hash} />

function Utility({ hash }: { hash: string }) {
  const [lib, setLib] = useState<UtilityLibrary>()
  const [maps, setMaps] = useState<Ctx['maps']>()
  const [failed, setFailed] = useState<string>()
  const [route, setRoute] = useState<Route>({ page: 'home' })
  const [mode, setMode] = useState<Mode>()
  const [toast, setToast] = useState<{ msg: string; bad?: boolean; undo?: () => void; n: number }>()
  const [imp, setImp] = useState<ImportData>()
  const [exp, setExp] = useState<{ ids?: string[] }>()
  const [prev, setPrev] = useState<Lineup>()
  const [clipTest, setClipTest] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  // Team-Sync: Team-Lineups zusätzlich zu den lokalen (gespeichert wird lokal nur owner 'local')
  const store = useMemo(teamStore, [])
  const ts = useSyncExternalStore(store.subscribe, store.state) // auch Änderungen vor dem ersten Effekt (Cache lädt schnell)
  const all = useMemo(() => (lib && ts.lineups.length ? { ...lib, lineups: [...lib.lineups, ...ts.lineups] } : lib), [lib, ts.lineups])
  const latest = useRef(all)
  latest.current = all

  const notify: Ctx['notify'] = (msg, bad, undo) => setToast({ msg, bad, undo, n: Date.now() })
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(undefined), toast.bad || toast.undo ? 7000 : 3500); return () => clearTimeout(t) }, [toast])
  const startImport = () => api.utilityImportOpen().then(r => { if (r) setImp(r) }, e => notify(`Import failed: ${errText(e)}`, true))

  useEffect(() => {
    Promise.all([api.utilityLoad(), api.utilityMaps()]).then(([r, m]) => {
      setLib(r.lib); setMaps(m)
      if (r.warning) notify(r.warning, true)
      const h = fromHash(hash, r.lib)
      setRoute(h.route); setMode(h.mode); setClipTest(!!h.clipTest)
      if (h.importNow) startImport()
      if (h.exportNow) setExp({})
    }, e => setFailed(errText(e)))
  }, [])

  // Speichern: jede Änderung nach 150 ms, beim Verlassen der Seite/des Fensters sofort; nie bevor geladen wurde (sonst überschriebe
  // eine leere Bibliothek die Datei). Fehler bleiben sichtbar, die Daten im Fenster gehen nicht verloren.
  const pending = useRef<UtilityLibrary | undefined>(undefined)
  const flush = () => { const l = pending.current; if (!l) return; pending.current = undefined; api.utilitySave(l).catch(e => notify(`Could not save: ${errText(e)}`, true)) }
  // Team-Lineups (owner { team }) gehen an den Team-Sync (Rechte prüft der Server; abgelehnt → Meldung, Anzeige springt zurück)
  const update: Ctx['update'] = f => {
    const cur = latest.current
    if (!cur) return
    const n = f(cur), before = new Map(cur.lineups.map(l => [l.id, l]))
    latest.current = n
    for (const l of n.lineups) if (l.owner !== 'local' && before.get(l.id) !== l) store.saveLineup(l).catch(e => notify(`Team: ${errText(e)}`, true))
    const local = { ...n, lineups: n.lineups.filter(l => l.owner === 'local') }
    pending.current = local; setLib(local)
  }
  const share = (ids: string[]) => {
    const ls = lib?.lineups.filter(l => ids.includes(l.id) && l.owner === 'local' && !l.deleted) ?? []
    if (!ls.length) return notify('Only your own (local) lineups can be shared', true)
    store.shareLineups(ls).then(() => notify(`Shared ${ls.length} lineup${ls.length > 1 ? 's' : ''} with ${ts.team?.name ?? 'your team'}`), e => notify(`Team: ${errText(e)}`, true))
  }
  // Team-Seite liegt in der App-Navigation (App.tsx hört auf 'csda:view')
  const openTeam = () => dispatchEvent(new CustomEvent('csda:view', { detail: 'team' }))
  useEffect(() => { if (!pending.current) return; const t = setTimeout(flush, 150); return () => clearTimeout(t) }, [lib])
  useEffect(() => { addEventListener('pagehide', flush); return () => { removeEventListener('pagehide', flush); flush() } }, [])

  const go = (r: Route) => { setRoute(r); setMode(undefined); body.current?.scrollTo(0, 0) }
  if (failed) return <div className="ut"><div className="ut-empty pad">The utility library could not be loaded: {failed}</div></div>
  if (!lib || !all || !maps) return <div className="ut"><div className="ut-empty pad muted">Loading utility…</div></div>

  const ctx: Ctx = { lib: all, update, maps, go, route, notify, preview: setPrev, openExport: ids => setExp({ ids }), team: { store, state: ts }, share }
  const crumbs: [string, Route | undefined][] = [['Maps', { page: 'home' }]]
  const mapOf = route.page === 'map' ? route.map : route.page === 'lineup' ? all.lineups.find(l => l.id === route.id)?.map : route.page === 'edit' ? route.draft.map : undefined
  if (mapOf) crumbs.push([mapName(mapOf), { page: 'map', map: mapOf }])
  if (route.page === 'lineup') crumbs.push([all.lineups.find(l => l.id === route.id)?.title ?? '', undefined])
  if (route.page === 'edit') crumbs.push([route.isNew ? 'Add lineup' : 'Edit', undefined])

  return (
    <UtilCtx.Provider value={ctx}>
      <div className="ut">
        <header className="ut-head">
          <button className="ut-logo" onClick={() => go({ page: 'home' })}><svg viewBox="-16 -16 32 32" width="22" height="22"><polygon points="13,7.5 0,15 -13,7.5 -13,-7.5 0,-15 13,-7.5" /></svg>UTILITY</button>
          <nav className="ut-crumbs">
            {route.page !== 'home' && crumbs.map(([label, r], i) => <span key={i}>{r ? <button onClick={() => go(r)}>{label}</button> : <b>{label}</b>}</span>)}
          </nav>
          <div className="ut-head-actions">
            <MapsStatus />
            <button className="ut-btn ghost" onClick={startImport} title="Import lineups from a .csutil file"><Icon name="folder" size={16} /> Import</button>
            <button className="ut-btn ghost" onClick={() => setExp({})} disabled={!live(all).length} title="Export lineups as a .csutil file"><Icon name="upload" size={16} /> Export</button>
            <button className={`ut-team ${ts.team ? (ts.online ? 'on' : 'off') : ''}`} onClick={openTeam}
              title={ts.team ? `${ts.team.name}: ${ts.online ? 'connected' : 'offline, changes are sent later'}${ts.error ? ` · ${ts.error}` : ''}. Open the team page.` : 'Create or join a team to share lineups'}>
              <i className="ut-team-dot" /><Icon name="multi" size={15} /> {ts.team ? ts.team.name : 'Team'}
              <small>{!ts.team ? 'join or create' : ts.syncing ? 'syncing' : ts.online ? 'connected' : 'offline'}</small>
            </button>
          </div>
        </header>
        <div className="ut-body" ref={body}>
          {route.page === 'home' && <Home />}
          {route.page === 'map' && <MapPage key={route.map} map={route.map} playbook={route.playbook} focus={route.focus} mode={mode} />}
          {route.page === 'lineup' && <Detail key={route.id} id={route.id} back={route.back} />}
          {route.page === 'edit' && <Editor key={route.draft.id} draft={route.draft} isNew={route.isNew} step={route.step} back={route.back} />}
        </div>
        {imp && <ImportDialog data={imp} onClose={() => setImp(undefined)} />}
        {exp && <ExportDialog ids={exp.ids} onClose={() => setExp(undefined)} />}
        {clipTest && route.page === 'lineup' && <ClipDialog lineupId={route.id} selftest onClose={() => setClipTest(false)} />}
        {prev && <div className="ut-preview-layer"><Suspense fallback={null}><LineupPreview3D lineup={prev} onClose={() => setPrev(undefined)} /></Suspense></div>}
        {toast && (
          <div key={toast.n} className={`ut-toast ${toast.bad ? 'bad' : ''}`}>
            {toast.msg}
            {toast.undo && <button className="ut-link" onClick={() => { toast.undo!(); setToast(undefined) }}>Undo</button>}
          </div>
        )}
      </div>
    </UtilCtx.Provider>
  )
}
