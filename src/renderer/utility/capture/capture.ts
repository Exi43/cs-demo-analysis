// Lineup-Bilder aus der 3D-Map, ohne Demo (Engine wie die Lineup-Vorschau, nur öffentliche API): „Aim“ = Ego-Sicht am Stand mit dem Blick
// des Lineups und dem Fadenkreuz der Vorschau in der Mitte, „Position“ = schräg von hinten oben auf den Stand mit Ring und Blickrichtung
// (setMarks), Kamera nie hinter Wänden (Engine.raycast, views.ts).
// Canvas nie im DOM; Bild = Canvas direkt nach setTime (vor dem Compositing, ohne preserveDrawingBuffer), über utilityAddImageData als
// WebP ≤ 100 KB gespeichert (main/utility.ts storeImage). Eine Map einmal laden, dann beliebig viele Lineups (Startpaket: CaptureAll.tsx).
import { parseFloorGrid, type Assets3D, type FloorGrid, type MapAssetManifest, type SoundMap } from '../../../shared/assets3d'
import type { Lineup } from '../../../shared/utility'
import { api } from '../../api'
import type { CreateEngine, Engine } from '../../replay3d/contracts'
import { drawCrosshair } from '../../replay3d/crosshair'
import { loadSettings, xhairRender } from '../preview/settings'
import { synthLineup } from '../preview/synth'
import { along, feetEye, posCamera } from './views'

/** Bildgröße (16:9 wie Karten und Detailseite) */
export const W = 1280, H = 720
/** was ein Bild braucht (auch ein Entwurf im Editor) */
export type Shot = Pick<Lineup, 'map' | 'technique'> & { stand: Lineup['stand']; aim: NonNullable<Lineup['aim']> }
export type CaptureStatus = { msg: string; pct: number }
export interface MapShooter { shoot(l: Shot, say?: (s: CaptureStatus) => void): Promise<[string, string]>; dispose(): void }

/** Engine-Assets nur mit Map (wie preview/LineupPreview3D.tsx) */
const mapOnly = (map: MapAssetManifest): Assets3D =>
  ({ map, agents: { clips: '', clipMeta: {}, models: {}, arms: {} }, weapons: {}, sounds: { base: '', map: { mixgroupVol: {}, surfToStep: {}, map: {} as SoundMap['map'] } } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Map vorbereiten (beim ersten Mal Asset-Bau, Minuten) und Engine auf einem unsichtbaren Canvas; seed = ein Lineup der Map (Mini-Demo) */
export async function openMap(map: string, seed: Shot, say?: (s: CaptureStatus) => void): Promise<MapShooter> {
  const mod = import('../../replay3d/engine') as Promise<{ createEngine: CreateEngine }>
  const off = api.onPrepareStatus(s => { if (s.id === `map:${map}` && (s.state === 'building' || s.state === 'queued')) say?.({ msg: s.msg, pct: s.pct }) })
  try {
    const m = (await api.prepareMap(map)).map, res = await fetch(m.floor) // Bilder brauchen nur die Map, nicht das Vorschau-Kit
    if (!res.ok) throw new Error(`Could not load the floor grid of ${map} (${res.status})`)
    const g = parseFloorGrid(await res.arrayBuffer())
    // die Engine braucht eine Runde: Mini-Demo wie die Vorschau; gezeigt wird nur die Map (vor dem Wurf, ohne Spielermodell)
    const s = synthLineup({ id: '', map, type: 'smoke', side: 'T', title: '', stand: seed.stand, target: seed.stand, technique: [], steps: [], images: [], tags: [], owner: 'local', createdAt: 0, updatedAt: 0 }, g)
    const canvas = document.createElement('canvas')
    canvas.width = W; canvas.height = H
    const e = await (await mod).createEngine(canvas, mapOnly(m), s.data, p => say?.({ msg: p.msg, pct: p.pct }))
    if (!e.setView || !e.setMarks || !e.raycast) { e.dispose(); throw new Error('The 3D engine cannot place the camera') }
    e.resize(W, H)
    return shooter(e, canvas, g, s.from)
  } finally { off() }
}

function shooter(e: Engine, canvas: HTMLCanvasElement, g: FloorGrid, tick: number): MapShooter {
  const out = document.createElement('canvas')
  out.width = W; out.height = H
  const ctx = out.getContext('2d')!
  // dynamische Auflösung der Engine (langsame Bilder, z. B. GPU ausgelastet) ausgleichen: CSS-Größe so, dass die Zeichenfläche W × H bleibt
  let css = W
  const keep = () => { if (canvas.width !== W) { css = (css * W) / canvas.width; e.resize(css, (css * H) / W) } }
  /**
   * Bild stehen lassen, bis die Auto-Belichtung ruht (dirty, höchstens 3 s; sie gleitet nach Zeit, nicht nach Bildern), dann eins zeichnen
   * und sofort kopieren → Hash. Abstand ≥ 100 ms: ohne GPU-Timer zählte die Engine kürzere Abstände als Bildzeit (> 20 ms = zu langsam → kleinere Auflösung)
   */
  const grab = async (xhair?: boolean) => {
    for (const end = performance.now() + 3000; performance.now() < end;) { e.setTime(tick); await sleep(110); if (!e.dirty()) break } // erst nach der Messung (async) fragen
    for (let i = 0; i < 3; i++) { keep(); e.setTime(tick); if (canvas.width === W) break } // senkt die Engine dabei die Auflösung, ist das Canvas leer: noch einmal
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H)
    ctx.drawImage(canvas, 0, 0, W, H)
    if (xhair) drawCrosshair(ctx, xhairRender(loadSettings().xhair), 1.5 * H, W / 2, H / 2) // 1,5 × Spielgröße: auch klein lesbar
    const b = await new Promise<Blob | null>(r => out.toBlob(r, 'image/png'))
    if (!b) throw new Error('Could not encode the image')
    return api.utilityAddImageData(new Uint8Array(await b.arrayBuffer()))
  }
  return {
    async shoot(l, say) {
      const { feet, eye } = feetEye(l, g)
      say?.({ msg: 'Aim view', pct: 96 })
      e.setMarks!(null); e.setView!({ pos: eye, look: along(eye, l.aim.pitch, l.aim.yaw, 100) })
      const aim = await grab(true)
      // Position: Kamera mit freier Sicht, Ring am Stand, von hinten dazu eine Linie in Blickrichtung (ab 1,5 m, marks.ts)
      say?.({ msg: 'Position view', pct: 98 })
      const v = posCamera(eye, l.aim.yaw, e.raycast!)
      e.setMarks!({ path: v.behind ? [0, 60, 120, 180, 240, 300].map(d => along(eye, l.aim.pitch, l.aim.yaw, d)) : [], target: feet })
      e.setView!({ pos: v.pos, look: v.look })
      return [aim, await grab()]
    },
    dispose: () => e.dispose(),
  }
}

let chain: Promise<unknown> = Promise.resolve()
/** ein Lineup: Map laden, zwei Bilder [Aim, Position], Engine freigeben. Mehrere Aufrufe laufen nacheinander (eine Engine zur Zeit) */
export function captureLineup(l: Shot, say?: (s: CaptureStatus) => void): Promise<[string, string]> {
  const run = chain.then(async () => {
    const m = await openMap(l.map, l, say)
    try { return await m.shoot(l, say) } finally { m.dispose() }
  })
  chain = run.catch(() => {})
  return run
}
