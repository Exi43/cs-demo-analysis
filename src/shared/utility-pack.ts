// Lineup-Startpaket (scripts/starter-pack.ts): Würfe vieler Pro-Demos je Map zu wiederkehrenden Lineups bündeln. Rein (ohne Node/DOM),
// Test: utility-pack.test.ts. Bündel = gleiche Map/Typ/Seite, Stand, Ziel und Blick nahe am Kern-Wurf (gierig: der Wurf mit den meisten
// Nachbarn zuerst). Ins Paket nur Bündel, die mehrere Spieler in mehreren Matches mit derselben Technik geworfen haben.
import { calloutName, nadeName, placeAtPoint } from './analysis/maps/index.ts'
import type { Lineup, NadeType, Tag, ThrowCandidate } from './utility.ts'
import { BUILTIN_TECHNIQUES } from './utility-lib.ts'

/** Wurf mit Rundenlage: s nach Freezetime-Ende, Bombe gelegt (s, fehlt = kein Plant) */
export interface PackThrow extends ThrowCandidate { sec: number; plantSec?: number }

/** Nachbar: Stand (3D) und Ziel näher als so viele u, Blick (pitch und yaw) je näher als AIM_DEG */
export const STAND_U = 48, TARGET_U = 96, AIM_DEG = 3
/** Mindestmaß eines echten Lineups: Würfe, verschiedene Spieler, verschiedene Matches, Anteil der häufigsten Technik */
export const MIN_THROWS = 3, MIN_PLAYERS = 2, MIN_MATCHES = 2, MIN_TECH_SHARE = 0.6
/** höchstens so viele je Typ und Map, in dieser Reihenfolge ins Paket */
export const PACK_CAPS: [NadeType, number][] = [['smoke', 12], ['molotov', 6], ['flash', 5], ['he', 2]]

export const PACK_TAGS: Omit<Tag, 'updatedAt'>[] = [
  { id: 'pro', name: 'Pro', color: '#ffb21e' }, { id: 'execute', name: 'Execute', color: '#ff6b3d' },
  { id: 'default', name: 'Default', color: '#6fb3ff' }, { id: 'retake', name: 'Retake', color: '#7bd16b' },
]

type P = { x: number; y: number; z?: number }
const dist = (u: P, v: P) => Math.hypot(u.x - v.x, u.y - v.y, (u.z ?? 0) - (v.z ?? 0))
const dYaw = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180)
const near = (a: PackThrow, b: PackThrow) => {
  const x = a.lineup, y = b.lineup
  return dist(x.stand, y.stand) < STAND_U && dist(x.target, y.target) < TARGET_U && !!x.aim && !!y.aim &&
    Math.abs(x.aim.pitch - y.aim.pitch) < AIM_DEG && dYaw(x.aim.yaw, y.aim.yaw) < AIM_DEG
}

/**
 * Technik als Lineup-IDs: Sprung im Stand = jumpthrow, mit Anlauf (gehen/laufen) = wjumpthrow, sonst die Bewegung aus techniqueAt
 * (stand/walk/run, crouch); dazu die Maustaste
 */
export function packTechnique(tech: readonly string[]): string[] {
  const click = tech.filter(t => t === 'left' || t === 'right' || t === 'both')
  if (tech.includes('jump')) return [tech.includes('run') || tech.includes('walk') ? 'wjumpthrow' : 'jumpthrow', ...tech.filter(t => t === 'crouch'), ...click]
  return [...tech.filter(t => t !== 'jump')]
}

/** Bündel (gierig, jeder Wurf in höchstens einem): Kern = Wurf mit den meisten Nachbarn, Mitglieder = seine noch freien Nachbarn */
export function clusterThrows(list: PackThrow[]): PackThrow[][] {
  const groups = new Map<string, PackThrow[]>()
  for (const t of list) { const k = `${t.map}|${t.type}|${t.side}`; groups.set(k, [...(groups.get(k) ?? []), t]) }
  const out: PackThrow[][] = []
  // shortcut: paarweise je Map/Typ/Seite (einige hundert Würfe); bei sehr vielen Demos Raster nach Stand-Zelle
  for (const g of groups.values()) {
    const nb = g.map(a => g.filter(b => b !== a && near(a, b)))
    const free = new Set(g)
    for (const i of g.map((_, i) => i).sort((a, b) => nb[b].length - nb[a].length)) {
      if (!free.has(g[i])) continue
      const c = [g[i], ...nb[i].filter(t => free.has(t))]
      c.forEach(t => free.delete(t))
      out.push(c)
    }
  }
  return out
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const callout = (map: string, p: P) => calloutName(map, placeAtPoint(map, [p.x, p.y, p.z ?? 0]))
const WORD: Record<NadeType, string> = { smoke: 'smoke', flash: 'flash', molotov: 'molotov', he: 'HE', decoy: 'decoy' }
/** gleiche Eingabe → gleiche ID (ein neueres Paket ersetzt beim Import dasselbe Lineup statt es zu verdoppeln) */
const stableId = (s: string) => {
  let a = 0x811c9dc5, b = 0x01000193
  for (let i = 0; i < s.length; i++) { a = Math.imul(a ^ s.charCodeAt(i), 0x01000193); b = Math.imul(b ^ s.charCodeAt(i), 0x5bd1e995) }
  return `pro-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`
}

/** Bündel → Lineup oder null (zu selten, zu wenige Spieler/Matches, Technik nicht stabil). Repräsentant = Wurf am nächsten am Median */
export function lineupOfCluster(c: PackThrow[], now: number): (Lineup & { thrown: number }) | null {
  const players = new Set(c.map(t => t.steamid)), matches = new Set(c.map(t => t.matchId))
  if (c.length < MIN_THROWS || players.size < MIN_PLAYERS || matches.size < MIN_MATCHES) return null
  const key = (t: PackThrow) => packTechnique(t.lineup.technique).join('+'), counts = new Map<string, number>()
  for (const t of c) counts.set(key(t), (counts.get(key(t)) ?? 0) + 1)
  const [tech, n] = [...counts].sort((a, b) => b[1] - a[1])[0]
  if (n / c.length < MIN_TECH_SHARE) return null
  const same = c.filter(t => key(t) === tech), L = (t: PackThrow) => t.lineup
  const m = {
    sx: median(same.map(t => L(t).stand.x)), sy: median(same.map(t => L(t).stand.y)), sz: median(same.map(t => L(t).stand.z ?? 0)),
    tx: median(same.map(t => L(t).target.x)), ty: median(same.map(t => L(t).target.y)), tz: median(same.map(t => L(t).target.z ?? 0)),
    p: median(same.map(t => L(t).aim!.pitch)), y: median(same.map(t => L(t).aim!.yaw)),
  }
  const off = (t: PackThrow) => dist(L(t).stand, { x: m.sx, y: m.sy, z: m.sz }) + dist(L(t).target, { x: m.tx, y: m.ty, z: m.tz }) / 2 +
    10 * (Math.abs(L(t).aim!.pitch - m.p) + dYaw(L(t).aim!.yaw, m.y))
  const rep = same.reduce((a, b) => (off(b) < off(a) ? b : a)), l = rep.lineup, technique = tech.split('+')
  const map = rep.map, to = callout(map, l.target), from = callout(map, l.stand)
  // Name aus dem Kartenkatalog (z. B. „Garage smoke“, „molly“ → „molotov“), sonst Callout des Ziels; Wurfpunkt = Augenhöhe über dem Stand
  const hit = nadeName(map, { type: rep.type, land: [l.target.x, l.target.y, l.target.z ?? 0], throw: [l.stand.x, l.stand.y, (l.stand.z ?? 0) + 64], side: rep.side })
  const name = hit.named ? hit.name.replace(/ molly$/, ' molotov') : to ? `${to} ${WORD[rep.type]}` : `${WORD[rep.type][0].toUpperCase()}${WORD[rep.type].slice(1)}`
  const title = [name, from && !name.startsWith(`${from} `) ? `from ${from}` : ''].filter(Boolean).join(' ')
  // Tags: T zu ≥ 50 % höchstens 25 s vor dem Plant = Execute, sonst früh (Median ≤ 30 s) = Default; CT zu ≥ 50 % nach dem Plant = Retake
  const share = (f: (t: PackThrow) => boolean) => c.filter(f).length / c.length >= 0.5
  const tags = ['pro']
  if (rep.side === 'T' && share(t => t.plantSec !== undefined && t.plantSec >= t.sec && t.plantSec - t.sec <= 25)) tags.push('execute')
  else if (rep.side === 'T' && median(c.map(t => t.sec)) <= 30) tags.push('default')
  if (rep.side === 'CT' && share(t => t.plantSec !== undefined && t.sec > t.plantSec)) tags.push('retake')
  // keine Schritte: Stand und Blick zeigen die Bilder (scripts/starter-pack.ts images) und die 3D-Vorschau, die Technik steht als Chip (Berat: keine unnötige Erklärung)
  return {
    id: stableId(`${map}|${rep.type}|${rep.side}|${Math.round(l.stand.x)}|${Math.round(l.stand.y)}|${Math.round(l.target.x)}|${Math.round(l.target.y)}`),
    map, type: rep.type, side: rep.side, title, description: `Thrown ${c.length}× by pros`,
    stand: l.stand, target: l.target, aim: l.aim, technique, steps: [],
    images: [], tags, owner: 'local', createdAt: now, updatedAt: now, thrown: c.length,
  }
}

/**
 * Würfe einer Map → Paket: Lineups je Typ nach PACK_CAPS (häufigste zuerst), ohne zweites Lineup mit fast gleichem Stand und Ziel;
 * doppelte Titel bekommen die Technik bzw. eine Nummer angehängt
 */
export function packLineups(list: PackThrow[], now: number): Lineup[] {
  const all = clusterThrows(list).map(c => lineupOfCluster(c, now)).filter(l => l !== null).sort((a, b) => b.thrown - a.thrown)
  const out: Lineup[] = []
  for (const [type, cap] of PACK_CAPS) {
    let k = 0
    for (const { thrown: _, ...l } of all) {
      if (l.type !== type || k >= cap) continue
      if (out.some(o => o.type === l.type && o.side === l.side && dist(o.stand, l.stand) < 2 * STAND_U && dist(o.target, l.target) < TARGET_U)) continue
      out.push(l); k++
    }
  }
  const label = (id: string) => BUILTIN_TECHNIQUES.find(t => t.id === id)?.label ?? id
  const twins = () => [...new Set(out.map(l => l.title))].map(t => out.filter(l => l.title === t)).filter(g => g.length > 1)
  for (const g of twins()) if (new Set(g.map(l => l.technique[0])).size > 1) g.forEach(l => { l.title += ` (${label(l.technique[0])})` })
  for (const g of twins()) g.forEach((l, i) => { l.title += ` #${i + 1}` }) // gleiche Technik: durchnummeriert, häufigstes zuerst
  return out
}
