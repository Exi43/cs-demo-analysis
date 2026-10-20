// Karten-Geometrie aus den Demos selbst ableiten: Callout-Mittelpunkte und Zonen (A / Mid / B).
import type { MatchData, Round } from '../model.ts'

export type Zone = 'A' | 'B' | 'Mid' | 'T-Spawn' | 'CT-Spawn'
export interface Geo {
  place: Map<string, { x: number; y: number; z: number; n: number }>
  zoneOf: (place: string) => Zone
  zoneAt: (x: number, y: number) => Zone
  /** Direkt auf einer Bombsite (für Hit-Erkennung) */
  siteAt: (x: number, y: number) => 'A' | 'B' | undefined
  siteR: number
  /** Grobe Richtung (A-Seite / B-Seite / Mitte) */
  leanAt: (x: number, y: number) => 'A' | 'B' | 'Mid'
  /** > 0 = Richtung A, < 0 = Richtung B */
  leanScore: (x: number, y: number) => number
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
  // Weichere Richtung für Laufwege: Long Doors/Catwalk auf Dust2 zählen schon als "A-Seite"
  // Fortschritt vom T-Spawn zur Site: wer Richtung A läuft, entfernt sich meist von B
  const tA = d2(tSpawn, siteA), tB = d2(tSpawn, siteB)
  const leanScore = (x: number, y: number) => (1 - d2([x, y], siteA) / tA) - (1 - d2([x, y], siteB) / tB)
  const leanAt = (x: number, y: number): 'A' | 'B' | 'Mid' => {
    const s = leanScore(x, y)
    return s > 0.12 ? 'A' : s < -0.12 ? 'B' : 'Mid'
  }
  const zoneCache = new Map<string, Zone>()
  const zoneOf = (place: string): Zone => {
    if (/bombsite\s*a/i.test(place)) return 'A'
    if (/bombsite\s*b/i.test(place)) return 'B'
    if (zoneCache.has(place)) return zoneCache.get(place)!
    const p = acc.get(place); const z = p ? zoneAt(p.x, p.y) : 'Mid'
    zoneCache.set(place, z); return z
  }
  const list = [...acc.entries()]
  const nearestPlace = (x: number, y: number, z?: number) => {
    let best = '', bd = Infinity
    for (const [name, p] of list) {
      const d = Math.hypot(p.x - x, p.y - y) + (z !== undefined ? Math.abs(p.z - z) * 0.5 : 0)
      if (d < bd) { bd = d; best = name }
    }
    return best
  }
  return { place: acc, zoneOf, zoneAt, leanAt, leanScore, siteAt, siteR, nearestPlace, siteA, siteB, tSpawn, ctSpawn }
}

/** Callout lesbar machen: "TopofMid" → "Top of Mid", "BombsiteA" → "A-Site" */
export function prettyPlace(p: string): string {
  if (!p) return '?'
  const m = /^Bombsite([AB])$/i.exec(p); if (m) return `${m[1].toUpperCase()}-Site`
  if (p === 'TSpawn') return 'T-Spawn'
  if (p === 'CTSpawn') return 'CT-Spawn'
  return p.replace(/of(?=[A-Z])/g, ' of ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim()
}

/** Frame-Index zu Sekunden nach Freezetime-Ende */
export function frameAtSec(r: Round, sec: number): number {
  const tick = r.freezeEndTick + sec * 64
  const ft = r.frameTicks
  let lo = 0, hi = ft.length - 1
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ft[mid] < tick) lo = mid + 1; else hi = mid }
  return lo
}
