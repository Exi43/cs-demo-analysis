// Karten-Geometrie aus den Demos selbst ableiten: Callout-Mittelpunkte, Zonen (A / Mid / B), Laufwege und Besitzkarte.
import type { MatchData, Round, Side } from '../model.ts'
import { laneOf } from './maps/index.ts'

export type Zone = 'A' | 'B' | 'Mid' | 'T-Spawn' | 'CT-Spawn'
export interface Geo {
  map: string
  /** Laufweg eines Places ("LongDoors" → "A long", P1 laneOf); '' bleibt '' */
  lane: (place: string) => string
  /** Besitzkarte: T-Anteil je Place 3–15 s nach Freezetime (≥ 0,75 = T-Hälfte) */
  tShare: Map<string, number>
  /** T-Anteil der 250-u-Zelle; undefined bei < 15 Samples */
  tCell: (x: number, y: number) => number | undefined
  /** T-Anteil an einer Position: Zelle, sonst Place, sonst 0,5 */
  tAt: (x: number, y: number, place: string) => number
  place: Map<string, { x: number; y: number; z: number; n: number }>
  zoneAt: (x: number, y: number) => Zone
  /** Direkt auf einer Bombsite (für Hit-Erkennung) */
  siteAt: (x: number, y: number) => 'A' | 'B' | undefined
  siteR: number
  nearestPlace: (x: number, y: number, z?: number) => string
  siteA: [number, number]; siteB: [number, number]; tSpawn: [number, number]; ctSpawn: [number, number]
}

const d2 = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1])

export function buildGeo(matches: MatchData[]): Geo {
  const acc = new Map<string, { x: number; y: number; z: number; n: number }>()
  const tStart: [number, number][] = [], ctStart: [number, number][] = []
  for (const m of matches) for (const r of m.rounds) {
    for (const tr of r.tracks) {
      for (let i = 0; i < tr.x.length; i += 8) {
        if (tr.hp[i] <= 0) continue
        const p = r.places[tr.place[i]]; if (!p) continue
        const a = acc.get(p) ?? { x: 0, y: 0, z: 0, n: 0 }
        a.x += tr.x[i]; a.y += tr.y[i]; a.z += tr.z[i]; a.n++; acc.set(p, a)
      }
      const f = Math.max(0, r.frameTicks.findIndex(t => t >= r.freezeEndTick))
      ;(tr.side === 'T' ? tStart : ctStart).push([tr.x[f], tr.y[f]])
    }
  }
  for (const a of acc.values()) { a.x /= a.n; a.y /= a.n; a.z /= a.n }
  const avg = (pts: [number, number][]): [number, number] => pts.length ? [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length] : [0, 0]
  const plants = (site: 'A' | 'B') => matches.flatMap(m => m.rounds.flatMap(r => r.plant?.site === site ? [[r.plant.pos[0], r.plant.pos[1]] as [number, number]] : []))
  const center = (name: string, site: 'A' | 'B'): [number, number] => {
    const p = acc.get(name); if (p) return [p.x, p.y]
    return avg(plants(site))
  }
  const siteA = center('BombsiteA', 'A'), siteB = center('BombsiteB', 'B')
  const tSpawn = acc.get('TSpawn') ? [acc.get('TSpawn')!.x, acc.get('TSpawn')!.y] as [number, number] : avg(tStart)
  const ctSpawn = acc.get('CTSpawn') ? [acc.get('CTSpawn')!.x, acc.get('CTSpawn')!.y] as [number, number] : avg(ctStart)

  const siteR = Math.min(750, 0.33 * d2(siteA, siteB))
  const siteAt = (x: number, y: number): 'A' | 'B' | undefined => {
    const dA = d2([x, y], siteA), dB = d2([x, y], siteB)
    return dA < siteR && dA < dB ? 'A' : dB < siteR ? 'B' : undefined
  }
  const zoneAt = (x: number, y: number): Zone => {
    const p: [number, number] = [x, y]
    const dA = d2(p, siteA), dB = d2(p, siteB), dT = d2(p, tSpawn), dCT = d2(p, ctSpawn)
    if (dA < 450 && dA < dB) return 'A'
    if (dB < 450) return 'B'
    if (dT < 0.35 * Math.min(dA, dB)) return 'T-Spawn'
    if (dA < 0.62 * dB) return 'A'
    if (dB < 0.62 * dA) return 'B'
    if (dCT < 0.5 * Math.min(dA, dB) && dCT < 700) return 'CT-Spawn'
    return 'Mid'
  }
  // Besitzkarte aus den Demos selbst (kartenunabhängig): wer steht 3–15 s nach Freezetime wo, je Place und 250-u-Zelle
  type Count = Map<string, { T: number; CT: number }>
  const byPlace: Count = new Map(), byCell: Count = new Map()
  const cellKey = (x: number, y: number) => `${Math.floor(x / 250)},${Math.floor(y / 250)}`
  const bump = (c: Count, k: string, side: Side) => { const o = c.get(k) ?? { T: 0, CT: 0 }; o[side]++; c.set(k, o) }
  for (const m of matches) for (const r of m.rounds) for (let s = 3; s <= 15; s++) {
    const f = frameAtSec(r, s)
    for (const t of r.tracks) if (t.hp[f] > 0) { bump(byPlace, r.places[t.place[f]], t.side); bump(byCell, cellKey(t.x[f], t.y[f]), t.side) }
  }
  const tShare = new Map([...byPlace].map(([p, o]) => [p, o.T / (o.T + o.CT)]))
  const tCell = (x: number, y: number) => { const o = byCell.get(cellKey(x, y)); return o && o.T + o.CT >= 15 ? o.T / (o.T + o.CT) : undefined }
  const tAt = (x: number, y: number, place: string) => tCell(x, y) ?? tShare.get(place) ?? 0.5
  const map = matches[0]?.map ?? ''
  const list = [...acc.entries()]
  const nearestPlace = (x: number, y: number, z?: number) => {
    let best = '', bd = Infinity
    for (const [name, p] of list) {
      const d = Math.hypot(p.x - x, p.y - y) + (z !== undefined ? Math.abs(p.z - z) * 0.5 : 0)
      if (d < bd) { bd = d; best = name }
    }
    return best
  }
  return { map, lane: p => laneOf(map, p), tShare, tCell, tAt, place: acc, zoneAt, siteAt, siteR, nearestPlace, siteA, siteB, tSpawn, ctSpawn }
}

/** Frame-Index zu Sekunden nach Freezetime-Ende */
export function frameAtSec(r: Round, sec: number): number {
  const tick = r.freezeEndTick + sec * 64
  const ft = r.frameTicks
  let lo = 0, hi = ft.length - 1
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ft[mid] < tick) lo = mid + 1; else hi = mid }
  return lo
}
