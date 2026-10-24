// 3D-Replay-Seite (Vollbild wie die CS2-Demo-Wiedergabe, Entwurf v2): lädt CS3D, HudTrack, Avatare und Assets beim Öffnen (Assets bereitet
// der Main-Prozess schon nach dem Import / beim Öffnen des Matches im Hintergrund vor), steckt Engine/Audio zusammen und besitzt die Uhr
// über das ganze Match (Play/Pause, Tempo, Sprünge; die Runde folgt dem Tick). Low quality lädt nichts neu (Engine schaltet live um).
// Ladebildschirm: Fortschritt des Asset-Baus (auch "wartet auf eine andere Demo"), Fehler mit Retry, ohne Fortschritt nach STALL_MS ebenfalls Retry.
// Bildtakt frameloop.ts: in der Pause nur bei Sprung/Option/Resize/engine.dirty(), HUD-State höchstens 15×/s, Statistik 2×/s (hudStats).
// Tasten: hotkeys.ts matchAction auf window keydown (Bubble-Phase, damit der Hotkeys-Dialog sie beim Aufnehmen vorher abfängt).
// three & Co. kommen nur per dynamischem import() aus engine/audio.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { MatchData } from '../../shared/model'
import { CS3D_VERSION, decode3d, upperBound } from '../../shared/cs3d'
import type { PrepareProgress } from '../../shared/assets3d'
import type { Avatars, HudTrack } from '../../shared/hud'
import { api, type MapMeta } from '../api'
import type { Jump } from '../App'
import { TICKRATE } from '../replay/scene'
import { mapLabel } from '../format'
import type { AudioEngine, CameraMode, CreateAudio, CreateEngine, Engine, LabelInfo, Replay3DData } from './contracts'
import type { AudioStats } from './audio'
import { createFrameLoop, type FrameLoop } from './frameloop'
import { matchAction, type HotkeyAction } from './hotkeys'
import { getOptions, onOptions, setOptions, type OptionsPatch } from './options'
import { Hud, hudStats } from './Hud'
import { iconBitmaps, iconKey, useHudScale } from './hud/assets'
import { SPEEDS } from './hud/DemoBar'
import { hudView, timeline } from './hud/state'
import './hud.css'

/** null = bereit */
type Status = { p: PrepareProgress } | { error: string } | { nodata: true } | null
const LOADING: Status = { p: { stage: 'locate', pct: 0, msg: 'Loading 3D data…' } }
/** so lange ohne neuen Fortschritt → Hinweis + Retry (der Bau selbst bricht erst nach 10 min ab, main/assets3d) */
const STALL_MS = 60e3
/** Ladezeiten des letzten Öffnens (ms seit Beginn) für die Statistikzeile */
let openMs: Record<string, number> = {}
/** Ereignis-Sprung landet so weit davor (wie DemoBar) */
const LEAD_S = 2
/** Icons der Überkopf-Schilder, die die Engine zusätzlich zu LabelInfo braucht */
const LABEL_ICONS = ['eq/c4', 'ui/defuser_white']

export function Replay3DView({ match, map, img, lowerImg, jump, onReimported, onExit }: {
  match: MatchData; map: MapMeta; img?: HTMLImageElement; lowerImg?: HTMLImageElement; jump?: Jump
  /** Demo wurde für 3D neu importiert: Match neu laden */
  onReimported: () => void
  /** zurück zur 2D-Ansicht ('Exit 3D') */
  onExit?: () => void
}) {
  const rate = match.tickrate || TICKRATE, last = match.rounds[match.rounds.length - 1]
  const total = Math.max(last.endTick, last.frameTicks[last.frameTicks.length - 1] ?? 0)
  const starts = useMemo(() => match.rounds.map(r => r.startTick), [match])
  const rounds = useMemo(() => match.rounds.map(r => ({ num: r.num, startTick: r.startTick, endTick: r.endTick, winner: r.winner })), [match])
  const o = useSyncExternalStore(onOptions, getOptions)
  const [tick, setTick] = useState(match.rounds[0].startTick) // HUD-Kopie (höchstens 15×/s), die Uhr läuft in S
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [mode, setMode] = useState<CameraMode>('ego')
  const [focus, setFocus] = useState<string | null>(() => match.rounds[0].tracks.find(t => t.side === 'CT')?.steamid ?? null)
  const [muted, setMuted] = useState<ReadonlySet<string>>(new Set())
  const [settings, setSettings] = useState(false)
  const [avatars, setAvatars] = useState<Avatars>({})
  const [retry, setRetry] = useState(0)
  const [status, setStatus] = useState<Status>(LOADING)
  const [stalled, setStalled] = useState(false)
  useEffect(() => {
    setStalled(false)
    if (!status || !('p' in status)) return
    const t = setTimeout(() => setStalled(true), STALL_MS)
    return () => clearTimeout(t)
  }, [status])
  const [rt, setRt] = useState<{ engine: Engine; audio?: AudioEngine; data: Replay3DData; track: HudTrack | null }>()
  const rtRef = useRef(rt); rtRef.current = rt
  const [cs2, setCs2] = useState<string>()
  useEffect(() => { api.cs2Status().then(s => setCs2('error' in s ? s.error : `Counter-Strike 2 build ${s.patch}: ${s.csgo}`)) }, [])
  useEffect(() => { api.avatars(match.players.map(p => p.steamid)).then(setAvatars, e => console.warn('avatars', e)) }, [match.id])

  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useHudScale(stageRef)
  const S = useRef<{ tick: number; playing: boolean; speed: number; loop?: FrameLoop }>({ tick, playing: false, speed: 1 })
  const seek = (t: number) => { const s = S.current; s.tick = Math.max(0, Math.min(total, t)); s.loop?.jump(); setTick(s.tick) }
  const play = (on: boolean) => { const s = S.current; s.playing = on; s.loop?.setPlaying(on); setPlaying(on) }
  const changeSpeed = (v: number) => { S.current.speed = v; setSpeed(v) }
  const roundIdx = (t: number) => Math.max(0, upperBound(starts, t) - 1)
  /** Rundenstart: 2 s vor Freeze-Ende, früher, wenn in der Freeze-Zeit schon gefunkt wird (dort liegt der Großteil der Sprache) */
  const startOf = (i: number) => {
    const R = match.rounds[i], v = rt?.data.d.voice.tick
    return Math.min(R.freezeEndTick - rate * 2, v?.[upperBound(v, R.startTick - 1)] ?? Infinity)
  }
  const goRound = (i: number) => seek(startOf(Math.max(0, Math.min(match.rounds.length - 1, i))))
  const pick = (sid: string) => { setFocus(sid); setMode('ego') }
  const toggleMute = (sid: string) => setMuted(m => { const n = new Set(m); if (!n.delete(sid)) n.add(sid); return n })

  // Sprung aus der Analyse bzw. Selbsttest-Hash #auto/replay3d/<runde>/<sek>[/<ego|free>/<spielerindex>[/<optionen>]]
  useEffect(() => {
    if (jump) return seek(Math.max(match.rounds[Math.min(match.rounds.length - 1, jump.round - 1)].startTick, jump.tick))
    const [, , r, sec, cam, pi] = location.hash.startsWith('#auto/replay3d/') ? location.hash.slice(1).split('/') : []
    const i = r ? Math.min(match.rounds.length - 1, Number(r) - 1) : 0
    seek(sec ? match.rounds[i].freezeEndTick + Number(sec) * rate : startOf(i))
    if (cam === 'ego' || cam === 'free') setMode(cam)
    if (pi && match.players[Number(pi)]) setFocus(match.players[Number(pi)].steamid)
  }, [match.id, jump?.n])

  // Laden: Assets (Main, meist schon vorbereitet), CS3D + HudTrack und die Engine-/Audio-Module parallel → Engine → Audio.
  // Neuer Canvas je Versuch (WebGL-Kontext nicht wiederverwenden).
  useEffect(() => {
    let dead = false, done = false, queued = false
    const own: { e?: Engine; a?: AudioEngine } = {}
    const t0 = performance.now(), ms: Record<string, number> = {}, lap = (k: string) => { ms[k] = performance.now() - t0 }
    let lastMsg = ''
    const progress = (p: PrepareProgress) => {
      if (p.msg !== lastMsg) lap((lastMsg = p.msg)) // Ladezeiten je Schritt (Statistikzeile, Selbsttest)
      if (!dead && !done) setStatus({ p })
    }
    // Asset-Bau im Main-Prozess: eigener Stand, oder der Bau einer anderen Demo, auf den dieses Match gerade wartet
    const off = api.onPrepareStatus(s => {
      const mine = s.id === match.id
      if (mine) queued = s.state === 'queued'
      if (mine ? s.state === 'building' || queued : queued && s.state === 'building')
        progress({ stage: 'locate', pct: s.pct, msg: mine ? s.msg : `Another demo is being prepared first: ${s.msg} (${s.pct} %)` })
    })
    setRt(undefined); setStatus(LOADING)
    ;(async () => {
      const assetsP = api.prepare3d(match.id)
      assetsP.catch(() => {}) // ohne 3D-Daten unten abgefangen
      const modsP = Promise.all([import('./engine') as Promise<{ createEngine: CreateEngine }>, import('./audio') as Promise<{ createAudio: CreateAudio }>])
      const [buf, track] = await Promise.all([api.load3d(match.id), api.loadHud(match.id).catch(() => null)])
      lap('data')
      if (dead) return
      if (!buf) {
        // Import lief, nur die 3D-Daten scheiterten: Grund zeigen statt endlos neu importieren zu lassen
        const error3d = (await api.listMatches()).find(s => s.id === match.id)?.error3d
        if (dead) return
        return setStatus(error3d ? { error: `3D data could not be read from this demo: ${error3d}` } : { nodata: true })
      }
      const data: Replay3DData = { match, d: decode3d(buf) }
      const assets = await assetsP
      lap('assets')
      const [{ createEngine }, { createAudio }] = await modsP
      if (dead) return
      // Audio parallel zur Engine (rechnet, während die Engine auf Dateien/GPU wartet); ohne Ton weiter, statt das 3D-Replay scheitern zu lassen
      const audioP = createAudio(data, assets).catch(err => { console.warn('audio', err); return undefined })
      const e = await createEngine(canvasRef.current!, assets, data, progress).catch(async err => { (await audioP)?.dispose(); throw err })
      lap('engine')
      if (dead) { e.dispose(); return (await audioP)?.dispose() }
      own.e = e
      const a = await audioP
      lap('audio')
      if (dead) return a?.dispose()
      own.a = a
      openMs = ms; done = true
      setRt({ engine: e, audio: a, data, track }); setStatus(null)
    })().catch(err => { if (!dead) setStatus({ error: err instanceof Error ? err.message : String(err) }) })
    return () => { dead = true; off(); own.a?.dispose(); own.e?.dispose(); hudStats.set(null) }
  }, [match.id, retry])

  // Bildtakt: Uhr vorstellen → Engine → Audio; HUD (onHud) höchstens 15×/s, Statistik 2×/s
  useEffect(() => {
    if (!rt) return
    const { engine, audio } = rt, s = S.current
    const loop = createFrameLoop({
      step(now, dt) {
        if (s.playing) {
          s.tick += (dt / 1000) * rate * s.speed
          if (s.tick >= total) { s.tick = total; play(false) }
        }
        engine.setTime(s.tick)
        audio?.update({ tick: s.tick, playing: s.playing, speed: s.speed, at: now }, engine.listener())
      },
      wantsFrame: () => engine.dirty(),
      onHud: () => setTick(s.tick),
      onStats: fps => {
        const st = engine.stats(), as = (audio as { stats?(): AudioStats } | undefined)?.stats?.()
        // Draw-Calls des letzten Bildes, aufgeteilt (world, viewmodel, nadecam, post)
        const by = st.callsBy ? ` (${Object.entries(st.callsBy).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''
        hudStats.set({
          fps, calls: st.calls, frameMs: st.frameMs, cpuMs: st.cpuMs,
          text: `${Math.round(fps)} fps · ${st.calls} draw calls${by} · ${st.frameMs.toFixed(1)} ms/frame · cpu ${st.cpuMs.toFixed(2)} ms · ${(st.triangles / 1e6).toFixed(2)} M tris`
            + ` · loaded in ${(st.loadMs / 1000).toFixed(1)} s · open ${Object.entries(openMs).map(([k, v]) => `${k} ${(v / 1000).toFixed(2)}`).join(' ')} s${as ? ` · sounds ${as.sfx?.files ?? 0} loaded, ${as.sfx?.errors ?? 0} failed · voice ${as.voice.decoded}/${as.voice.clips} decoded, ${as.voice.started} played` : ' · no audio'}`,
        })
      },
    })
    s.loop = loop
    loop.setPlaying(s.playing)
    return () => { loop.stop(); s.loop = undefined }
  }, [rt])

  useEffect(() => {
    const el = stageRef.current
    if (!rt || !el) return
    const ro = new ResizeObserver(() => { rt.engine.resize(el.clientWidth, el.clientHeight); S.current.loop?.invalidate() })
    ro.observe(el)
    return () => ro.disconnect()
  }, [rt])
  useEffect(() => { rt?.engine.setCamera(focus && mode === 'ego' ? 'ego' : 'free', focus ?? undefined); S.current.loop?.invalidate() }, [rt, mode, focus])
  // Voice-Ticks erst jetzt bekannt: unveränderten Rundenstart auf den ersten Funkspruch vorziehen
  useEffect(() => { const t = S.current.tick, i = roundIdx(t); if (rt && t === match.rounds[i].freezeEndTick - rate * 2) goRound(i) }, [rt])
  useEffect(() => {
    const a = rt?.audio
    if (!a) return
    a.setVolume('master', o.volume); a.setVolume('voice', o.voice ? 1 : 0)
    for (const p of rt.data.d.header.players) a.setMuted(p.steamid, muted.has(p.steamid))
  }, [rt, o.volume, o.voice, muted])

  const view = useMemo(() => rt && hudView(rt.data, rt.track, tick, focus, rt.audio?.speaking(tick) ?? [], avatars), [rt, tick, focus, avatars])
  const events = useMemo(() => (rt ? timeline(match, rt.data.d, focus) : []), [rt, focus])

  // Überkopf-Schilder: nur bei Änderung an die Engine (höchstens im HUD-Takt); Icons einmal je Name als Bitmap
  const ov = useRef({ key: '', labels: {} as Record<string, LabelInfo>, icons: new Map<string, CanvasImageSource>(), tried: new Set<string>() })
  // neue Engine (Retry) kennt Schilder und Icons noch nicht: beim nächsten Durchlauf alles neu senden
  useEffect(() => { ov.current.key = '' }, [rt])
  useEffect(() => {
    if (!rt || !view) return
    const O = ov.current, labels: Record<string, LabelInfo> = {}
    for (const p of view.players) if (p.alive) labels[p.steamid] = { weapon: p.weapon ? iconKey(p.weapon) : '', utility: p.utility.map(iconKey), bomb: p.bomb, defusing: view.defuse?.steamid === p.steamid }
    const key = JSON.stringify(labels)
    if (key !== O.key) { O.key = key; O.labels = labels; rt.engine.setOverlay({ labels, icons: O.icons }) }
    const missing = [...new Set([...LABEL_ICONS, ...Object.values(labels).flatMap(l => [l.weapon, ...l.utility])])].filter(n => n && !O.tried.has(n))
    if (!missing.length) return
    missing.forEach(n => O.tried.add(n))
    iconBitmaps(missing).then(bm => {
      if (!bm.size) return
      O.icons = new Map([...O.icons, ...bm]) // neue Map: die Schilder zeichnen bei neuem icons-Objekt neu
      rt.engine.setOverlay({ labels: O.labels, icons: O.icons })
    })
  }, [rt, view])

  // Tasten (hotkeys.ts); act liest immer den aktuellen Render-Stand
  const act = useRef<(a: HotkeyAction) => void>(() => {})
  act.current = a => {
    const s = S.current, players = view?.players ?? [], opt = getOptions()
    const cycle = (d: number) => {
      const n = players.length, i = players.findIndex(p => p.steamid === focus)
      if (n) pick(players[i < 0 ? 0 : (i + d + n) % n].steamid)
    }
    if (a.startsWith('slot')) { const p = players.find(x => x.slot === (Number(a.slice(4)) || 10)); if (p) pick(p.steamid); return }
    switch (a) {
      case 'playPause': return play(!s.playing)
      case 'slower': case 'faster': return changeSpeed(SPEEDS[Math.max(1, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(s.speed) + (a === 'faster' ? 1 : -1)))])
      case 'back15': return seek(s.tick - 15 * rate)
      case 'fwd15': return seek(s.tick + 15 * rate)
      case 'prevRound': return goRound(roundIdx(s.tick) - 1)
      case 'nextRound': return goRound(roundIdx(s.tick) + 1)
      case 'prevPlayer': return cycle(-1)
      case 'nextPlayer': return cycle(1)
      case 'nextEvent': { const e = events.find(e => e.tick - LEAD_S * rate > s.tick + rate / 4); if (e) seek(e.tick - LEAD_S * rate); return }
      case 'camToggle': return setMode(m => (m === 'ego' ? 'free' : 'ego'))
      case 'settings': return setSettings(v => !v)
      case 'labels': return setOptions({ ui: { labels: !opt.ui.labels } })
      case 'xray': case 'nadeTrails': case 'impacts': case 'nadeCam': case 'showKeys': case 'voice': case 'hideAll':
        return setOptions({ [a]: !opt[a] } as OptionsPatch)
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.repeat || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return
      const a = matchAction(e)
      if (a) { e.preventDefault(); act.current(a) }
    }
    addEventListener('keydown', onKey) // Bubble-Phase: der Hotkeys-Dialog stoppt Tasten beim Aufnehmen vorher (capture)
    // Selbsttest/Messung (scripts/dev3d/perf3d.ps1) steuern die Seite von außen, nur unter #auto/ (opt = Optionen setzen, audio = AudioContext-Zustand)
    if (location.hash.startsWith('#auto/')) Object.assign(window, { __h3: {
      act: (a: HotkeyAction) => act.current(a), at: (r: number, sec: number) => seek(match.rounds[r - 1].freezeEndTick + sec * rate),
      opt: (p: OptionsPatch) => setOptions(p), audio: () => rtRef.current?.audio?.ctx.state ?? 'none',
      focus: (i: number) => { if (match.players[i]) pick(match.players[i].steamid) }, // Ego auf Spielerindex wie im Hash
      openMs: () => openMs,
    } })
    return () => removeEventListener('keydown', onKey)
  }, [])

  // Alter Import ohne 3D-Daten: gespeicherte Demo neu einlesen, sonst Datei wählen lassen
  const reimport = async () => {
    const off = api.onProgress(p => setStatus({ p: { stage: 'locate', pct: p.pct, msg: p.msg } }))
    try {
      const saved = (await api.listMatches()).find(s => s.id === match.id)?.demoPath
      let s = saved ? await api.importDemo(saved).catch(() => undefined) : undefined
      if (!s) {
        const [f] = await api.pickDemos()
        if (!f) return setStatus({ nodata: true })
        s = await api.importDemo(f)
      }
      if (s.id !== match.id) return setStatus({ error: 'The selected demo is a different match. It was added to your demos.' })
      onReimported()
    } catch (err) {
      setStatus({ error: err instanceof Error ? err.message : String(err) })
    } finally { off() }
  }
  const exitBtn = onExit && <button onClick={onExit}>Exit 3D</button>

  return (
    <div className="h3-root">
      <div className="h3-stage hud-stage" data-hud-stage ref={stageRef} {...(rt ? { 'data-h3-ready': '' } : {})}>
        <canvas key={retry} ref={canvasRef} className="h3-canvas" />
        {rt && view && (
          <Hud view={view} data={rt.data} map={map} img={img} lowerImg={lowerImg} mode={mode} focus={focus} muted={muted} onPick={pick} onMute={toggleMute}
            onReimport={!rt.track || rt.data.d.header.version < CS3D_VERSION ? reimport : undefined}
            bar={{
              tick, total, tickrate: rate, rounds, events, playing, speed, settingsOpen: settings,
              onPlay: play, onSpeed: changeSpeed, onSeek: seek, onRound: n => goRound(match.rounds.findIndex(r => r.num === n)),
              onPlayer: pick, onCamera: setMode, onSettings: setSettings, onExit,
            }} />
        )}
        {status && (
          <div className="h3-load">
            <div className="h3-load-box">
              <h2>Prepare 3D for {mapLabel(match.map)}</h2>
              {'p' in status && <>
                <div className="bar"><div style={{ width: `${status.p.pct}%` }} /></div>
                <div>{status.p.msg}</div>
                <div className="small muted">The first time takes a few minutes: map, agents, weapons and sounds are built from your local Counter-Strike 2 installation and cached.</div>
                {cs2 && <div className="small muted">{cs2}</div>}
                {stalled && <div className="small muted">No progress for a minute. The build may still be working; Retry restarts loading.</div>}
                {(exitBtn || stalled) && <div className="h3-load-row">{stalled && <button onClick={() => setRetry(n => n + 1)}>Retry</button>}{exitBtn}</div>}
              </>}
              {'error' in status && <>
                <div className="error">{status.error}</div>
                <div className="small muted">3D replay needs Counter-Strike 2 installed via Steam on this PC. Nothing is downloaded from Valve; the game files stay on your disk.</div>
                <div className="h3-load-row">
                  <button className="on" onClick={() => setRetry(n => n + 1)}>Retry</button>
                  <label title="Lower resolution, no anti-aliasing, bloom or sun shadows (less GPU memory), applies with Retry">
                    <input type="checkbox" checked={o.lowQuality} onChange={e => setOptions({ lowQuality: e.target.checked })} /> Low quality
                  </label>
                  {exitBtn}
                </div>
              </>}
              {'nodata' in status && <>
                <div className="muted">This match was imported before 3D support. Re-import the demo to add the 3D data.</div>
                <div className="h3-load-row"><button className="on" onClick={reimport}>Re-import demo for 3D</button>{exitBtn}</div>
              </>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
