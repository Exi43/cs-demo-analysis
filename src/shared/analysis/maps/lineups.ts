// Benannte Lineups: Landepunkt (+ optional Wurfpunkt, Seite) -> Name. Ohne Abhängigkeiten.
// Aus Spike proanalyse/lineups/lineup-match.ts übernommen (Logik unverändert); Kataloge in catalog/de_<map>.ts.

export type LineupType = 'smoke' | 'molotov' | 'flash' | 'he'
export type Vec3 = [number, number, number]

export interface PlaceVolume { name: string; min: Vec3; max: Vec3; planes: [number, number, number, number][] }
export interface Zone { x: number; y: number; z: number | null; r: number; zMin: number | null; zMax: number | null; place: string; n?: number }
export interface LineupEntry {
  id: string
  /** eindeutiger Name (mit Zusatz wie "(CT)" bei gleichnamigen Varianten) */
  name: string
  /** Anzeigename ohne Zusatz, z. B. "Catwalk smoke" */
  baseName: string
  type: LineupType
  side: 'T' | 'CT' | 'any'
  aliases: string[]
  /** Landezonen: Mittelpunkt + Radius (2D), optional Höhenbereich; mehrere = Varianten desselben Lineups */
  zones: Zone[]
  throwFrom: { name: string; x?: number; y?: number; n?: number }[]
  confidence: 'high' | 'medium' | 'low'
  nameSource: string
  posSource: 'demo-cluster' | 'csnades-calibrated'
}
export interface LineupCatalog {
  map: string
  callouts: Record<string, string>
  places: PlaceVolume[]
  entries: LineupEntry[]
}
export interface NadeIn { type: string; land: Vec3; throw?: Vec3; side?: 'T' | 'CT' }
export interface LineupHit {
  /** Anzeigename (ohne Varianten-Zusatz) */
  name: string
  /** eindeutiger Katalog-Name der Variante */
  variant?: string
  named: boolean
  id?: string
  confidence?: LineupEntry['confidence']
  place: string
  /** Abstand zum Zonen-Mittelpunkt / Radius (0 = genau, 1 = Rand) */
  score?: number
}

export const WORD: Record<LineupType, string> = { smoke: 'smoke', molotov: 'molly', flash: 'flash', he: 'HE' }
const Z_TOL: Record<LineupType, number> = { smoke: 64, molotov: 64, flash: 160, he: 120 }

export function normType(t: string): LineupType | undefined {
  const s = t.toLowerCase()
  if (s.includes('smoke')) return 'smoke'
  if (s.includes('flash')) return 'flash'
  if (s.includes('molotov') || s.includes('incend') || s.includes('incgren') || s === 'molly') return 'molotov'
  if (s.includes('he')) return 'he'
  return undefined
}

function inside(v: PlaceVolume, p: Vec3, skipVertical: boolean): boolean {
  for (const [a, b, c, d] of v.planes) {
    if (skipVertical && Math.abs(c) > 0.5) continue
    if (a * p[0] + b * p[1] + c * p[2] > d + 1) return false
  }
  return true
}
const volSize = (v: PlaceVolume) => (v.max[0] - v.min[0]) * (v.max[1] - v.min[1]) * (v.max[2] - v.min[2])

/** CS2-Place (env_cs_place) eines Punktes; Flash in der Luft: 2D-Treffer mit nächster Höhe; sonst nächste Box (2D) bis 400 u */
export function placeAt(cat: LineupCatalog, p: Vec3): string {
  let best: PlaceVolume | undefined
  for (const v of cat.places) if (inside(v, p, false) && (!best || volSize(v) < volSize(best))) best = v
  if (best) return best.name
  let bz = Infinity
  for (const v of cat.places) {
    if (!inside(v, p, true)) continue
    const dz = p[2] < v.min[2] ? v.min[2] - p[2] : p[2] > v.max[2] ? p[2] - v.max[2] : 0
    if (dz < bz) { bz = dz; best = v }
  }
  if (best) return best.name
  let bd = 400
  for (const v of cat.places) {
    const d = Math.hypot(...[0, 1].map(i => Math.max(v.min[i] - p[i], 0, p[i] - v.max[i]))) // 2D: Flash hoch in der Luft
    if (d < bd) { bd = d; best = v }
  }
  return best?.name ?? ''
}

export function calloutOf(cat: LineupCatalog, place: string): string {
  return cat.callouts[place] ?? place.replace(/of(?=[A-Z])/g, ' of ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
}

/** Granate -> Lineup-Name. Nächste Zone gleichen Typs (Abstand/Radius <= 1), Seite und Wurfpunkt als Tie-Breaker. */
export function matchNade(cat: LineupCatalog, nade: NadeIn): LineupHit {
  const type = normType(nade.type)
  const place = placeAt(cat, nade.land)
  if (!type) return { name: '', named: false, place }
  let best: LineupEntry | undefined, bs = Infinity
  for (const e of cat.entries) {
    if (e.type !== type) continue
    let d = Infinity
    for (const L of e.zones) {
      if (L.zMin != null && L.zMax != null && (nade.land[2] < L.zMin - Z_TOL[type] || nade.land[2] > L.zMax + Z_TOL[type])) continue
      // Smoke/Molly: anderer Place als die Zone = Strafe (Flash detoniert in der Luft, dort nicht)
      const pen = (type === 'smoke' || type === 'molotov') && L.place && place && L.place !== place ? 0.3 : 0
      d = Math.min(d, Math.hypot(nade.land[0] - L.x, nade.land[1] - L.y) / L.r + pen)
    }
    if (d > 1) continue
    let s = d
    if (nade.side && e.side !== 'any' && e.side !== nade.side) s += 0.35
    if (nade.throw && e.throwFrom.some(f => f.x != null && Math.hypot(nade.throw![0] - f.x!, nade.throw![1] - f.y!) < 250)) s -= 0.15
    if (s < bs) { bs = s; best = e }
  }
  if (best) return { name: best.baseName, variant: best.name, named: true, id: best.id, confidence: best.confidence, place, score: +bs.toFixed(2) }
  const c = calloutOf(cat, place)
  return { name: c ? `${c} ${WORD[type]}` : WORD[type], named: false, place }
}
