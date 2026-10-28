// Utility-Seite: 3D-Vorschau eines Lineups wie ein kurzes Video mit Tasten-Anzeige (Vertrag shared/utility.ts; keine Videodateien).
// a) Lineup aus einer Demo (lineup.demo, Match noch in der Bibliothek): die echte Stelle im 3D-Replay in Ego-Sicht des Werfers ab 3 s vor dem Wurf.
// b) sonst oder Wurf nicht gefunden: nur die Map (api.prepareMap, beim ersten Mal Minuten) und ein Mini-Demo aus dem Lineup (synth.ts):
//    Augenhöhe auf dem Stand, Blick nach aim bzw. aufs Ziel, Tasten der Technik, angenäherte Flugbahn + Ziel (Engine.setMarks).
// Kamera (camera.ts): vor dem Wurf Ego mit Zoom (1×/2×/4×, Mausrad, Z); mit „Follow grenade“ folgt sie danach der Granate (Pose wie die
// Granaten-Kamera), ab der Wirkung OUT_S Außenansicht über die ganze Flugbahn mit Linie, dann zurück zum Start (Wiederholen = Play).
// Fadenkreuz einstellbar (settings.ts, pro PC): eigenes, das des Werfers aus der Demo oder ein CS2-Code, gemalt mit dem CS2-Zeichner.
// Engine wie das 3D-Replay, ohne Audio; Schilder, X-Ray, Impacts und Granaten-Kamera-Bild aus, solange offen (tempOptions). Bildtakt
// frameloop.ts: zeichnet nur beim Abspielen und bei Bedarf. Schließen (×, Esc, Klick daneben) gibt den GPU-Speicher frei (engine.dispose).
// Selbsttest: App.tsx #lineup=<JSON>[&at=<s>][&zoom=<k>][&set=<Einstellungen-JSON>][&panel]: at = Sekunden relativ zum Wurf (dort
// angehalten), set gilt nur für diese Sitzung (wird nicht gespeichert), panel öffnet die Fadenkreuz-Einstellungen; [data-h3-stats] = Ladezeiten.
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { parseFloorGrid, type Assets3D, type MapAssetManifest, type SoundMap } from '../../../shared/assets3d'
import { decode3d, newSample, roundAt, sampleTrack, type CS3D } from '../../../shared/cs3d'
import type { Crosshair as CrosshairCode } from '../../../shared/crosshair'
import type { Lineup } from '../../../shared/utility'
import { BUILTIN_TECHNIQUES } from '../../../shared/utility-lib'
import { api } from '../../api'
import { Icon } from '../../icons'
import { eyeZ, type CreateEngine, type Engine, type LineupMarks, type Replay3DData } from '../../replay3d/contracts'
import { createFrameLoop, type FrameLoop } from '../../replay3d/frameloop'
import { Crosshair } from '../../replay3d/Hud'
import { HudIcon } from '../../replay3d/hud/assets'
import { InputsOverlay, keysAt } from '../../replay3d/InputsOverlay'
import { tempOptions } from '../../replay3d/options'
import { FOLLOW_BLEND, OUT_BLEND, OUT_S, ZOOMS, orbitView, phaseAt, zoomAt } from './camera'
import { loadSettings, mergeSettings, saveSettings, xhairRender, type PreviewSettings, type XhairSettings } from './settings'
import { synthLineup } from './synth'
import { XhairPanel } from './XhairPanel'
import './preview.css'

type V3 = [number, number, number]
const SPEEDS = [0.25, 0.5, 1]
/** Granaten-Icon (Waffenname wie im HUD, hud/assets.tsx) */
const ICON: Record<Lineup['type'], string> = { smoke: 'Smoke Grenade', flash: 'Flashbang', he: 'High Explosive Grenade', molotov: 'Molotov', decoy: 'Decoy Grenade' }
/** Technik-Chip: eingebaute Bezeichnung, eigene Techniken (custom-<name>) als Name */
const techText = (t: string) => BUILTIN_TECHNIQUES.find(x => x.id === t)?.label ?? t.replace(/^custom-/, '').replace(/-/g, ' ')
/** solange die Vorschau offen ist: schlankes Bild ohne Überkopf-Schilder, X-Ray, Impacts und Granaten-Kamera-Bild */
const PREVIEW_OPTIONS = { xray: false, impacts: false, nadeCam: false, hideAll: false, ui: { labels: false, crosshair: true } }

/** Engine-Assets nur mit Map (Variante b): ohne Agenten, Waffen; Sounds nutzt nur das Audio, das die Vorschau nicht startet */
const mapOnly = (map: MapAssetManifest): Assets3D =>
  ({ map, agents: { clips: '', clipMeta: {}, models: {}, arms: {} }, weapons: {}, sounds: { base: '', map: { mixgroupVol: {}, surfToStep: {}, map: {} as SoundMap['map'] } } })

/**
 * Ticks: from/to = Ausschnitt, throwTick = Granate fliegt los, det = Wirkung (Smoke-Pop, Feuer, Detonation); nade = Index in d.nade.
 * marks = Flugbahn + Ziel (approx: b, angenähert und schon vor dem Wurf sichtbar; a: echte Bahn, nur in der Außenansicht); view = Außenansicht
 */
interface Source {
  data: Replay3DData; assets: Assets3D; steamid: string; from: number; throwTick: number; det: number; to: number; nade: number
  marks: LineupMarks; approx: boolean; thrower?: CrosshairCode | null; throwerName?: string
}
interface Clip extends Source { engine: Engine; d: CS3D }
type Status = { msg: string; pct: number } | { error: string } | null

/** Variante a: Match + Wurf (gleicher Spieler, nächster Wurf-Tick höchstens 1 s neben demo.tick); null = Match/Wurf fehlt */
async function fromDemo(demo: NonNullable<Lineup['demo']>): Promise<Source | null> {
  const assetsP = api.prepare3d(demo.matchId) // Assets (Worker, meist Cache) parallel zu den Daten
  assetsP.catch(() => {}) // ohne 3D-Daten: null unten
  const [match, buf] = await Promise.all([api.loadMatch(demo.matchId), api.load3d(demo.matchId)])
  if (!buf) return null
  const d = decode3d(buf), N = d.nade, P = d.path, rate = d.header.tickrate, p = d.header.players.findIndex(x => x.steamid === demo.steamid)
  let i = -1
  for (let j = 0; j < N.type.length; j++) {
    const dt = Math.abs(N.throwTick[j] - demo.tick)
    if (N.player[j] === p && dt <= rate && (i < 0 || dt < Math.abs(N.throwTick[i] - demo.tick))) i = j
  }
  const r = i < 0 ? -1 : roundAt(d, N.throwTick[i])
  if (r < 0) return null
  const R = d.header.rounds[r], k = R.tracks.indexOf(p), path: V3[] = []
  for (let j = N.pathStart[i]; j < N.pathStart[i + 1]; j++) path.push([P.x[j], P.y[j], P.z[j]])
  const s = k >= 0 ? sampleTrack(d, r, k, N.throwTick[i], newSample()) : null, eye: V3 = s ? [s.x, s.y, eyeZ(s.z, s.duck)] : path[0]
  const from = Math.max(R.firstTick, N.throwTick[i] - 3 * rate), to = N.detTick[i] + OUT_S * rate
  // Engine lädt nur die Waffen, die im Ausschnitt jemand hält (Header-Kopie; ganzes Match: 36 statt ~10 GLBs, Laden ~0,25 s länger)
  const n = R.nFrames, step = d.header.frameStep, f0 = Math.max(0, Math.floor((from - R.firstTick) / step)), f1 = Math.min(n - 1, Math.ceil((to - R.firstTick) / step)), held = new Set<number>()
  for (let t = 0; t < R.tracks.length; t++) for (let j = d.frameBase[r] + t * n + f0, e = d.frameBase[r] + t * n + f1; j <= e; j++) held.add(d.weapon[j])
  const clip = { ...d, header: { ...d.header, weapons: d.header.weapons.filter(w => held.has(w)) } }
  const assets = await assetsP
  return {
    data: { match, d: clip }, assets, steamid: demo.steamid, nade: i, throwTick: N.throwTick[i], det: N.detTick[i], from, to,
    marks: { path, target: [N.x[i], N.y[i], N.z[i]] }, approx: false,
    thrower: d.header.players[p].crosshair, throwerName: d.header.players[p].name,
  }
}

/** Variante b: nur Map + Mini-Demo; Höhen ohne z aus dem Boden-Raster */
async function fromMap(l: Lineup): Promise<Source> {
  const map = await api.prepareMap(l.map), res = await fetch(map.floor)
  if (!res.ok) throw new Error(`Could not load the floor grid of ${l.map} (${res.status})`)
  const s = synthLineup(l, parseFloorGrid(await res.arrayBuffer()))
  return { ...s, assets: mapOnly(map), nade: 0, approx: true }
}

/** Selbsttest-Parameter hinter dem Lineup im Hash (#lineup=…&at=…&zoom=…&set=…&panel) */
const hashArgs = () => new URLSearchParams(location.hash.slice(location.hash.indexOf('&') + 1))

export function LineupPreview3D(p: { lineup: Lineup; onClose: () => void }): JSX.Element {
  const l = p.lineup
  const [status, setStatus] = useState<Status>({ msg: 'Loading…', pct: 0 })
  const [clip, setClip] = useState<Clip>()
  const [tick, setTick] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [phase, setPhase] = useState<0 | 1 | 2>(0)
  const [stats, setStats] = useState('')
  const [zoom, setZoom] = useState(() => { const z = Number(hashArgs().get('zoom')); return ZOOMS.includes(z) ? z : 1 })
  const [panel, setPanel] = useState(() => hashArgs().has('panel'))
  const [set, setSet] = useState<PreviewSettings>(() => { const s = loadSettings(), o = hashArgs().get('set'); return o ? mergeSettings(JSON.parse(o), s) : s })
  const update = (u: { xhair?: Partial<XhairSettings>; follow?: boolean }) =>
    setSet(cur => { const n = { xhair: { ...cur.xhair, ...u.xhair }, follow: u.follow ?? cur.follow }; saveSettings(n); return n })
  const stageRef = useRef<HTMLDivElement>(null), canvasRef = useRef<HTMLCanvasElement>(null)
  const S = useRef<{ tick: number; playing: boolean; speed: number; zoom: number; follow: boolean; phase: number; loop?: FrameLoop }>(
    { tick: 0, playing: false, speed: 1, zoom, follow: set.follow, phase: -1 })
  const close = useRef(p.onClose); close.current = p.onClose
  const xr = useMemo(() => xhairRender(set.xhair, clip?.thrower), [set.xhair, clip])

  // Laden: Demo-Stelle oder nur Map, dann Engine; Fortschritt des Asset-Baus über onPrepareStatus (Match-id bzw. 'map:<name>')
  useEffect(() => {
    let dead = false, engine: Engine | undefined, watch = ''
    const t0 = performance.now(), ms: string[] = [], lap = (k: string) => ms.push(`${k} ${((performance.now() - t0) / 1000).toFixed(2)}`)
    const off = api.onPrepareStatus(s => { if (!dead && s.id === watch && (s.state === 'building' || s.state === 'queued')) setStatus({ msg: s.msg, pct: s.pct }) })
    tempOptions(PREVIEW_OPTIONS)
    setClip(undefined); setStatus({ msg: 'Loading…', pct: 0 })
    ;(async () => {
      const mod = import('../../replay3d/engine') as Promise<{ createEngine: CreateEngine }>
      const has = l.demo && (await api.listMatches()).some(s => s.id === l.demo!.matchId)
      if (has) watch = l.demo!.matchId
      let src = has ? await fromDemo(l.demo!) : null
      if (dead) return
      if (!src) { watch = `map:${l.map}`; src = await fromMap(l) }
      lap(src.approx ? 'map' : 'demo')
      const { createEngine } = await mod
      if (dead) return
      lap('code')
      let last = ''
      const e = await createEngine(canvasRef.current!, src.assets, src.data, pr => { if (pr.msg !== last) lap((last = pr.msg)); if (!dead) setStatus({ msg: pr.msg, pct: pr.pct }) })
      if (dead) return e.dispose()
      engine = e
      e.setCamera('ego', src.steamid)
      lap('engine')
      setStats(`lineup preview ${src.approx ? 'map only' : 'demo'} · open ${ms.join(' ')} s · loaded in ${e.stats().loadMs} ms`)
      setClip({ ...src, engine: e, d: src.data.d }); setStatus(null)
    })().catch(err => {
      if (dead) return
      console.error(`Lineup preview failed: ${err instanceof Error ? err.stack : err}`)
      setStatus({ error: err instanceof Error ? err.message : String(err) })
    })
    return () => { dead = true; off(); engine?.dispose(); tempOptions(null) }
  }, [l.id, l.updatedAt]) // neues Objekt mit gleichem Stand (Store, Re-Render) lädt nicht neu

  // Bildtakt: Uhr von from bis to (danach zurück zum Start, angehalten), Kamera je Tick (camera.ts), HUD höchstens 15×/s
  useEffect(() => {
    if (!clip) return
    const s = S.current, e = clip.engine, rate = clip.d.header.tickrate, at = hashArgs().get('at') // Selbsttest
    s.tick = at ? clip.throwTick + Number(at) * rate : clip.from
    s.playing = !at; s.phase = -1
    const direct = (t: number) => {
      const ph = phaseAt(t, clip.throwTick, clip.det, s.follow)
      if (ph !== s.phase) {
        s.phase = ph; setPhase(ph)
        if (ph === 1) e.setView?.({ nade: clip.nade }, FOLLOW_BLEND, clip.throwTick)
        else if (ph === 2) e.setView?.(orbitView(clip.marks.target, clip.marks.path[0], clip.det), OUT_BLEND, clip.det)
        else e.setView?.(null)
        e.setMarks?.(ph === 2 || (ph === 0 && clip.approx) ? clip.marks : null) // beim Folgen läge die Linie direkt vor der Kamera
      }
      e.setZoom?.(ph === 0 ? zoomAt(t, clip.throwTick, s.zoom, rate) : 1)
    }
    const loop = createFrameLoop({
      step(_now, dt) {
        if (s.playing) {
          s.tick += (dt / 1000) * rate * s.speed
          if (s.tick >= clip.to) { s.tick = clip.from; s.playing = false; loop.setPlaying(false); setPlaying(false) }
        }
        direct(s.tick)
        e.setTime(s.tick)
      },
      wantsFrame: () => e.dirty(),
      onHud: () => setTick(s.tick),
      onStats: () => {},
    })
    s.loop = loop
    e.onDirty = loop.wake
    loop.setPlaying(s.playing); setPlaying(s.playing); setTick(s.tick)
    return () => { loop.stop(); e.onDirty = undefined; s.loop = undefined }
  }, [clip])

  useEffect(() => { const s = S.current; s.zoom = zoom; s.follow = set.follow; s.loop?.invalidate() }, [zoom, set.follow])

  useEffect(() => {
    const el = stageRef.current
    if (!clip || !el) return
    const ro = new ResizeObserver(() => { clip.engine.resize(el.clientWidth, el.clientHeight); S.current.loop?.invalidate() })
    ro.observe(el)
    return () => ro.disconnect()
  }, [clip])

  const zoomStep = (d: number) => setZoom(z => ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + d))])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current()
      else if ((e.key === 'z' || e.key === 'Z') && !/^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement).tagName)) setZoom(z => ZOOMS[(ZOOMS.indexOf(z) + 1) % ZOOMS.length])
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  const play = (on: boolean) => { const s = S.current; if (clip) { s.playing = on; s.loop?.setPlaying(on); setPlaying(on) } }
  const replay = () => { if (clip) { S.current.tick = clip.from; S.current.loop?.jump(); play(true) } }
  const pickSpeed = (v: number) => { S.current.speed = v; setSpeed(v) }
  const frac = (t: number) => (clip ? Math.min(1, Math.max(0, (t - clip.from) / (clip.to - clip.from))) : 0)
  const showMarks = clip && (phase === 2 || (phase === 0 && clip.approx))

  return (
    <div className="lp-back" onMouseDown={e => { if (e.target === e.currentTarget) p.onClose() }}>
      <div className="lp-dialog" role="dialog" aria-modal="true" aria-label={`3D preview: ${l.title}`}>
        <header className="lp-head">
          <span className={`lp-type ${l.type}`}><HudIcon name={ICON[l.type]} img /></span>
          <div className="lp-title">
            <b>{l.title || 'Lineup'}</b>
            <div className="lp-chips">
              <span className={`lp-side ${l.side}`}>{l.side === 'both' ? 'T / CT' : l.side}</span>
              {l.technique.map(t => <span key={t} className="lp-chip">{techText(t)}</span>)}
            </div>
          </div>
          {clip && <span className={`lp-src ${clip.approx ? 'approx' : ''}`}>{clip.approx ? 'Map only · no demo' : `From demo · round ${l.demo?.round ?? '?'}${l.demo?.player ? ` · ${l.demo.player}` : ''}`}</span>}
          <button className="lp-close ghost" onClick={p.onClose} aria-label="Close preview" title="Close (Esc)"><Icon name="x" size={20} /></button>
        </header>
        <div className="lp-stage hud-stage" ref={stageRef} onWheel={e => zoomStep(e.deltaY < 0 ? 1 : -1)} {...(clip ? { 'data-h3-ready': '' } : {})}>
          <canvas ref={canvasRef} className="h3-canvas" />
          {clip && <>
            {phase === 0 && <Crosshair c={xr} />}
            <div className="lp-keys"><InputsOverlay keys={keysAt(clip.d, clip.steamid, tick)} /></div>
            <div className={`lp-nade ${tick >= clip.throwTick ? 'thrown' : ''}`}>
              <HudIcon name={ICON[l.type]} img /><span>{tick < clip.throwTick ? l.type : tick < clip.det ? 'Thrown' : 'Landed'}</span>
              {phase === 0 && zoom > 1 && tick < clip.throwTick && <em>{zoom}× zoom</em>}
            </div>
            {showMarks && <div className="lp-legend"><span><i className="path" />{clip.approx ? 'Trajectory (approx.)' : 'Trajectory'}</span><span><i className="ring" />Target</span></div>}
          </>}
          {stats && <span hidden data-h3-stats={stats} />}
          {status && (
            <div className="h3-load">
              <div className="h3-load-box">
                <h2>3D preview</h2>
                {'msg' in status && <>
                  <div className="bar"><div style={{ width: `${status.pct}%` }} /></div>
                  <div>{status.msg}</div>
                  <div className="small muted">The first time, the 3D files are built from your Counter-Strike 2 installation (a few minutes; without a demo only the map). Then they are cached.</div>
                </>}
                {'error' in status && <div className="error">{status.error}</div>}
              </div>
            </div>
          )}
        </div>
        <footer className="lp-bar">
          <button className="lp-play" disabled={!clip} onClick={() => play(!playing)} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play'}>
            <Icon name={playing ? 'pause' : 'replay'} size={20} />
          </button>
          <button disabled={!clip} onClick={replay} aria-label="Replay from the start" title="Replay"><Icon name="again" /> Replay</button>
          <div className="lp-time" aria-hidden>
            <div className="lp-fill" style={{ width: `${frac(tick) * 100}%` }} />
            {clip && <i className="lp-throw" style={{ left: `${frac(clip.throwTick) * 100}%` }} title="Throw" />}
          </div>
          <div className="lp-speed" role="group" aria-label="Zoom on the aim point before the throw" title="Zoom on the aim point before the throw (mouse wheel, Z)">
            <Icon name="zoom" size={16} />
            {ZOOMS.map(v => <button key={v} className={zoom === v ? 'on' : ''} onClick={() => setZoom(v)}>{v}×</button>)}
          </div>
          <button className={`lp-follow ${set.follow ? 'on' : ''}`} aria-pressed={set.follow} onClick={() => update({ follow: !set.follow })}
            title="After the throw the camera follows the grenade, then shows the whole flight from outside"><Icon name="camera" /> Follow grenade</button>
          <div className="lp-speed" role="group" aria-label="Speed">
            {SPEEDS.map(v => <button key={v} className={speed === v ? 'on' : ''} onClick={() => pickSpeed(v)}>{v}×</button>)}
          </div>
          <button className={`lp-xh ${panel ? 'on' : ''}`} onClick={() => setPanel(v => !v)} aria-label="Crosshair settings" aria-expanded={panel} title="Crosshair"><Icon name="xhair" /></button>
        </footer>
        {panel && <XhairPanel x={set.xhair} thrower={clip?.thrower ? clip.throwerName ?? 'the thrower' : null} onChange={x => update({ xhair: x })} onClose={() => setPanel(false)} />}
      </div>
    </div>
  )
}
