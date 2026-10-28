// Übertragungs-HUD des 3D-Replays (Entwurf v2) als Layout über dem Canvas: Minimap oben links, Granaten-Kamera-Rahmen darunter,
// Scoreboard, Killfeed, Teamleisten CT links / T rechts, Spieler-Panel, Tasten-Anzeige, Demo-Leiste + Zahnrad-Menü (Hotkeys-Dialog darin),
// Ego-Crosshair/Zielfernrohr (wie CS2 legacy_sniper_scope.vfx). Daten nur aus HudView (hud/state.ts), Sichtbarkeit aus options.ts (shown(el), 'Hide all' schlägt alles).
// Alle Maße in 1080p-px im einen .hud (zoom: var(--s), useHudScale setzt --s an der Bühne). Statistik (2×/s) über hudStats, damit nur
// Leistungszeile und [data-h3-stats] neu rendern, nicht das ganze HUD.
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { FLAG, nadeInFlight, newSample, roundAt, sampleTrack, type CS3D } from '../../shared/cs3d'
import { toRender, type CrosshairRender } from '../../shared/crosshair'
import { drawCrosshair } from './crosshair'
import type { MapMeta } from '../api'
import { drawScene, frameAt, isLower, playerAt } from '../replay/scene'
import type { CameraMode, EngineStats, Replay3DData } from './contracts'
import { InputsOverlay } from './InputsOverlay'
import { getOptions, onOptions, shown } from './options'
import { HudIcon } from './hud/assets'
import { DemoBar, type DemoBarProps } from './hud/DemoBar'
import { FlashIndicator } from './hud/FlashIndicator'
import { Killfeed } from './hud/Killfeed'
import { PlayerPanel } from './hud/PlayerPanel'
import { Scoreboard } from './hud/Scoreboard'
import { SettingsMenu } from './hud/SettingsMenu'
import { TeamBar } from './hud/TeamBar'
import type { HudView } from './hud/types'
import './hud.css'

/** Markergröße der Minimap (Spieler, Bombe, Linien) relativ zum 2D-Radar in 1024 px, je 330 px Minimap-Breite */
const RADAR_MARK = 0.75
const SNIPER = /awp|ssg|g3sg1|scar-20/i
const NADE_ICON = ['Smoke Grenade', 'Flashbang', 'High Explosive Grenade', 'Molotov', 'Incendiary Grenade', 'Decoy Grenade'] // Index = CS3D NADE

/** Leistungswerte für Zahnrad-Menü und Selbsttest; text = Zeile für [data-h3-stats] */
export type HudStats = Pick<EngineStats, 'fps' | 'calls' | 'frameMs' | 'cpuMs'> & { text: string }
let stats: HudStats | null = null
const statSubs = new Set<() => void>()
export const hudStats = {
  set(s: HudStats | null) { stats = s; statSubs.forEach(cb => cb()) },
  sub(cb: () => void) { statSubs.add(cb); return () => { statSubs.delete(cb) } },
}
const useStats = () => useSyncExternalStore(hudStats.sub, () => stats)
function StatsTag() {
  const s = useStats()
  return s && <span hidden data-h3-stats={s.text} />
}
function LiveSettings({ onReimport }: { onReimport?: () => void }) {
  return <SettingsMenu stats={useStats()} onReimport={onReimport} />
}

export interface HudProps {
  view: HudView
  data: Replay3DData
  map: MapMeta; img?: HTMLImageElement; lowerImg?: HTMLImageElement
  mode: CameraMode
  /** Fokus-Spieler (Panel, Demo-Leiste, Rahmen in der Teamleiste) */
  focus: string | null
  muted: ReadonlySet<string>
  onPick(steamid: string): void
  onMute(steamid: string): void
  /** Demo-Leiste (ohne players/focus/camera/round, die kommen aus view bzw. mode) */
  bar: Omit<DemoBarProps, 'players' | 'focus' | 'camera' | 'round'>
  /** Re-import-Hinweis im Zahnrad (HudTrack fehlt oder CS3D < 5) */
  onReimport?: () => void
}

export function Hud({ view, data, map, img, lowerImg, mode, focus, muted, onPick, onMute, bar, onReimport }: HudProps) {
  const o = useSyncExternalStore(onOptions, getOptions)
  const fp = focus ? view.players.find(p => p.steamid === focus) : undefined
  const ego = mode === 'ego' && view.focus && fp?.alive ? view.focus : undefined
  // ohne Code (v2-Datei, Bot): einfaches Kreuz
  const xh = useMemo(() => { const c = data.d.header.players.find(p => p.steamid === ego?.steamid)?.crosshair; return c && toRender(c) }, [data, ego?.steamid])
  const R = data.match.rounds.find(r => r.num === view.round)
  const pi = focus ? data.d.header.players.findIndex(p => p.steamid === focus) : -1
  const ni = o.nadeCam && !o.lowQuality && !o.hideAll ? nadeInFlight(data.d, view.tick, pi) : -1 // Low: Engine zeichnet kein Bild
  const thrower = ni >= 0 ? view.players.find(p => p.steamid === data.d.header.players[data.d.nade.player[ni]]?.steamid) : undefined

  return (
    <div className="hud">
      {ego && shown('crosshair') && (ego.scoped && SNIPER.test(fp!.weapon) ? <Scope k={scopeBlur(data.d, pi, view.tick, fp!.weapon)} />
        : !SNIPER.test(fp!.weapon) && (xh ? <Crosshair c={xh} /> : <div className="h3-cross" />))}
      {ego && !o.hideAll && <FlashIndicator f={ego} />}
      {shown('minimap') && <Minimap view={view} data={data} map={map} img={img} lowerImg={lowerImg} target={mode === 'free' ? null : focus} />}
      {ni >= 0 && (
        <div className="h3-pip" data-hud="nadecam">
          <div className="bar"><HudIcon name={NADE_ICON[data.d.nade.type[ni]] ?? 'Smoke Grenade'} img />GRENADE CAM<span className={thrower?.side}>{thrower?.name}</span></div>
          <i className="rec" />
        </div>
      )}
      {shown('scoreboard') && <Scoreboard view={view} winner={R?.winner} />}
      {shown('killfeed') && <Killfeed kills={view.killfeed} />}
      {shown('teams') && <>
        <TeamBar view={view} side="CT" focus={focus} muted={muted} onPick={onPick} onMute={onMute} />
        <TeamBar view={view} side="T" focus={focus} muted={muted} onPick={onPick} onMute={onMute} />
      </>}
      {shown('panel') && <PlayerPanel view={view} />}
      {o.showKeys && !o.hideAll && view.focus && (
        <div className="h3-keys" data-hud="keys"><InputsOverlay keys={view.focus.keys} label={`Keys · ${fp?.name ?? ''}`} /></div>
      )}
      <DemoBar {...bar} round={view.round} players={view.players} focus={focus} camera={mode} />
      {bar.settingsOpen && <LiveSettings onReimport={onReimport} />}
      <StatsTag />
    </div>
  )
}

/** Crosshair in Geräte-Pixeln (nicht die 3D-Renderskala), neu gezeichnet nur bei anderem Code oder anderer Größe; auch Lineup-Vorschau */
export function Crosshair({ c }: { c: CrosshairRender }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const draw = () => {
      const r = window.devicePixelRatio || 1, b = cv.getBoundingClientRect() // zoom: Bildschirm-px statt 1080p-px
      cv.width = Math.round(b.width * r); cv.height = Math.round(b.height * r) // leert auch
      drawCrosshair(cv.getContext('2d')!, c, cv.height, cv.width / 2, cv.height / 2)
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(cv)
    return () => ro.disconnect()
  }, [c])
  return <canvas ref={ref} className="h3-xhair" />
}

/** Zoom-Werte der Scharfschützengewehre (CS2 scripts/weapons.vdata, Index 1 = gezoomt): max. Tempo u/s, Ungenauigkeit Laufen/Sprung */
const SCOPED: [RegExp, max: number, move: number, jump: number][] = [[/awp/i, 100, 0.17648, 0.13383], [/ssg/i, 230, 0.12345, 0.00572], [/./, 120, 0.15048, 0.15377]]
const S0 = newSample()
/**
 * Unschärfe k (0..1) des Zielfernrohrs = saturate(2 · Ungenauigkeit ohne Steh-Anteil), wie legacy_sniper_scope.vfx sie bekommt.
 * shortcut: Ungenauigkeit nur aus Tempo (ab 34 % des Maximums linear bis 95 %) und Sprung, ohne Schuss/Erholung; genau erst mit
 * m_fAccuracyPenalty aus der Demo (Parser).
 */
function scopeBlur(d: CS3D, p: number, tick: number, weapon: string) {
  const r = roundAt(d, tick), k = r < 0 || p < 0 ? -1 : d.header.rounds[r].tracks.indexOf(p)
  if (k < 0) return 0
  sampleTrack(d, r, k, tick, S0)
  const [, max, move, jump] = SCOPED.find(([re]) => re.test(weapon))!
  const ramp = Math.min(1, Math.max(0, (Math.hypot(S0.vx, S0.vy) / max - 0.34) / 0.61))
  return Math.round(Math.min(1, 2 * (move * ramp + (S0.flags & FLAG.airborne ? jump : 0))) * 50) / 50 // 2 %-Stufen: seltener neu zeichnen
}

const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
/** Schwarz-Deckung für den Faktor f in linearem Licht (der Shader liest das Bild mit SrgbRead): sRGB ≈ linear^(1/2,2) */
const black = (f: number) => `rgba(0,0,0,${(1 - Math.max(0, f) ** (1 / 2.2)).toFixed(4)})`
/**
 * Zielfernrohr wie CS2 (materials/effects/legacy_sniper_scope.vmat, Shader legacy_sniper_scope.vfx; die Panorama-Bilder hud/scope/* nutzt
 * CS2 nicht): außerhalb des Kreises r = 0,425·H schwarz mit weicher Kante 0,03·H, innen Vignette smoothstep(0,55, 0,2, r), Linien
 * 1 Gerätepixel. Mit Unschärfe k: Kreis bis 0,38·H, Linien weich bis +0,1·H breit und nur noch 30 % deckend. Ohne Linsenverzerrung und
 * Farbsaum am Rand (braucht das Bild der Engine). W×H in Geräte-Pixeln; agent-page 'scope' vergleicht es mit der Shader-Formel.
 */
export function drawScope(g: CanvasRenderingContext2D, W: number, H: number, k: number) {
  // Abdunklung 1 − Maske·Vignette (r in Bildhöhen); hinter dem letzten Stopp (r = R) bleibt es schwarz
  const R = 0.425 + (0.38 - 0.425) * k, gr = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, R * H)
  for (let i = 0; i <= 40; i++) {
    const r = i <= 24 ? ((R - 0.03) * i) / 24 : R - 0.03 + (0.03 * (i - 24)) / 16
    gr.addColorStop(Math.min(1, r / R), black(ss(R, R - 0.03, r) * ss(0.55, 0.2, r))) // r/R kann 1 + 1e-16 werden: addColorStop wirft
  }
  g.fillStyle = gr; g.fillRect(0, 0, W, H)
  // Linien: Abstand d zur Mitte (W/2 + 0,25 px), Faktor 1 − op·(1 − smoothstep(hw, hw2, d))
  const op = 1 - 0.7 * k ** 0.3, hw = 0.5, hw2 = hw + 0.1 * H * k + 0.25, cx = W / 2 + 0.25, cy = H / 2 + 0.25
  if (hw2 - hw <= 0.5) { // scharf: genau eine Pixelreihe/-spalte (Pixelmitte liegt 0,25 px neben der Linie)
    g.fillStyle = black(1 - op); g.fillRect(Math.floor(cx), 0, 1, H); g.fillRect(0, Math.floor(cy), W, 1)
    return
  }
  for (const v of [true, false]) {
    const c = v ? cx : cy, lg = v ? g.createLinearGradient(c - hw2, 0, c + hw2, 0) : g.createLinearGradient(0, c - hw2, 0, c + hw2)
    for (let i = 0; i <= 16; i++) { const d = Math.abs(i / 8 - 1) * hw2; lg.addColorStop(i / 16, black(1 - op * (1 - ss(hw, hw2, d)))) }
    g.fillStyle = lg
    if (v) g.fillRect(c - hw2, 0, 2 * hw2, H); else g.fillRect(0, c - hw2, W, 2 * hw2)
  }
  // Kreuzung: CS2 rechnet 1 − op + op·Lx·Ly, zwei überlagerte Streifen ergäben (1 − op + op·Lx)(1 − op + op·Ly) → Quadrat je Pixel
  // (liegt ganz in r < 0,2·H: dort deckt der Kreis nichts ab, putImageData ersetzt nur die Streifen)
  const x0 = Math.floor(cx - hw2), y0 = Math.floor(cy - hw2), n = Math.ceil(cx + hw2) - x0, img = g.createImageData(n, n)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const f = 1 - op + op * ss(hw, hw2, Math.abs(x0 + x + 0.5 - cx)) * ss(hw, hw2, Math.abs(y0 + y + 0.5 - cy))
    img.data[(y * n + x) * 4 + 3] = Math.round(255 * (1 - f ** (1 / 2.2)))
  }
  g.putImageData(img, x0, y0)
}
/** Zielfernrohr-Canvas in Geräte-Pixeln, neu gezeichnet bei anderem k oder anderer Größe */
function Scope({ k }: { k: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const draw = () => {
      const dpr = window.devicePixelRatio || 1, b = cv.getBoundingClientRect()
      cv.width = Math.round(b.width * dpr); cv.height = Math.round(b.height * dpr)
      drawScope(cv.getContext('2d')!, cv.width, cv.height, k)
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(cv)
    return () => ro.disconnect()
  }, [k])
  return <canvas ref={ref} className="h3-xhair" data-hud="scope" />
}

/** bestehendes 2D-Radar (drawScene) als Minimap: immer die ganze Karte (Berat 22.10.: nicht gezoomt, nicht gedreht) mit lesbaren Markern; Ebene folgt dem Kamera-Ziel */
function Minimap({ view, data, map, img, lowerImg, target }: { view: HudView; data: Replay3DData; map: MapMeta; img?: HTMLImageElement; lowerImg?: HTMLImageElement; target: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current, R = data.match.rounds.find(r => r.num === view.round)
    if (!c || !R) return
    const size = Math.round(c.getBoundingClientRect().width * (window.devicePixelRatio || 1))
    if (!size) return
    if (c.width !== size) c.width = c.height = size
    const tr = target ? R.tracks.find(t => t.steamid === target) : undefined
    const p = tr && playerAt(R, tr, frameAt(R, view.tick)), lower = !!p && isLower(map, p.z)
    drawScene(c.getContext('2d')!, data.match, { map, level: lower ? 'lower' : 'upper' }, lower && lowerImg ? lowerImg : img,
      [{ round: R, tick: view.tick, alpha: 1, showNames: false, highlight: target ?? undefined }], size / 1024, (size / 330) * RADAR_MARK)
  })
  return <canvas ref={ref} className="h3-radar" data-hud="radar" />
}
