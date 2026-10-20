// Jede Runde eines Teams einordnen: T-Plan (Rush/Execute/Default, Site, Timing, Utility) bzw. CT-Setup.
import type { BuyType, MatchData, Nade, Round, Side } from '../model.ts'
import { frameAtSec, prettyPlace, type Geo, type Zone } from './geo.ts'

export interface Ref { matchId: string; round: number; tick: number }

export interface TRound {
  kind: 'T'
  ref: Ref
  matchId: string
  round: number
  buy: BuyType
  won: boolean
  site?: 'A' | 'B'
  hitSec?: number
  plan: string // z. B. "B rush", "A execute", "Default → A", "Fake A → B"
  style: 'rush' | 'execute' | 'hit' | 'default' | 'fake' | 'none' | 'save'
  /** Spieler-Aufteilung beim Hit: Zone → Anzahl */
  split: Partial<Record<Zone, number>>
  /** Startaufteilung nach 12 s (Richtung) */
  start: Record<'A' | 'B' | 'Mid', number>
  /** Spieler, die erst Richtung andere Site liefen und dann zur Hit-Site rotierten */
  rotators: string[]
  lurkers: string[]
  utility: { type: Nade['type']; place: string; thrower: string; sec: number }[]
  earlyMid: number // T in Mid nach 20 s
  opening?: { killer?: string; victim: string; place: string; sec: number; forUs: boolean }
  planted: boolean
}

export interface CTRound {
  kind: 'CT'
  ref: Ref
  matchId: string
  round: number
  buy: BuyType
  won: boolean
  setup: string // "A2 M1 B2"
  zones: Record<'A' | 'Mid' | 'B', number>
  positions: Record<string, string> // steamid → Callout bei 15 s
  aggressive: { steamid: string; place: string; sec: number }[]
  utility: { type: Nade['type']; place: string; thrower: string; sec: number }[]
  stack?: 'A' | 'B'
  retake?: 'won' | 'lost'
  opening?: { killer?: string; victim: string; place: string; sec: number; forUs: boolean }
}

const SITE_ZONES: ('A' | 'B')[] = ['A', 'B']

export function teamSide(r: Round, team: string): Side { return r.teamOnSide.CT === team ? 'CT' : 'T' }

function opening(m: MatchData, r: Round, side: Side, geo: Geo) {
  const k = r.kills.find(k => k.attacker)
  if (!k) return undefined
  const victimSide = r.tracks.find(t => t.steamid === k.victim)?.side
  return {
    killer: k.attacker, victim: k.victim, sec: (k.tick - r.freezeEndTick) / 64,
    place: prettyPlace(k.victimPlace || geo.nearestPlace(k.victimPos[0], k.victimPos[1], k.victimPos[2])),
    forUs: victimSide !== side,
  }
}

export function classifyT(m: MatchData, r: Round, team: string, geo: Geo): TRound {
  const ts = r.tracks.filter(t => t.side === 'T')
  const end = r.frameTicks.length - 1
  const f0 = frameAtSec(r, 0)
  let hitF: number | undefined, site: 'A' | 'B' | undefined
  // Hit = erster Moment mit ≥3 lebenden T direkt auf einer Site (oder 2, wenn nur noch ≤3 leben)
  for (let f = f0; f <= end && hitF === undefined; f += 2) {
    const alive = ts.filter(t => t.hp[f] > 0)
    const need = alive.length <= 3 ? Math.min(2, alive.length) : 3
    if (!need) break
    for (const z of SITE_ZONES) {
      if (alive.filter(t => geo.siteAt(t.x[f], t.y[f]) === z).length >= need) { hitF = f; site = z; break }
    }
  }
  if (r.plant) {
    const pf = frameAtSec(r, (r.plant.tick - r.freezeEndTick) / 64)
    // Plant vor dem erkannten Hit oder auf der anderen Site (Rotation) → Plant ist der Hit
    if (hitF === undefined || pf < hitF || (r.plant.site && r.plant.site !== site)) hitF = pf
    site = r.plant.site ?? site
  }
  const hitTick = hitF !== undefined ? r.frameTicks[hitF] : undefined
  const hitSec = hitTick !== undefined ? (hitTick - r.freezeEndTick) / 64 : undefined

  const utility = r.nades
    .filter(n => ts.some(t => t.steamid === n.thrower) && n.type !== 'decoy' && n.throwTick >= r.freezeEndTick)
    .map(n => {
      const e = n.path[n.path.length - 1]
      return { type: n.type, place: prettyPlace(geo.nearestPlace(e[1], e[2], e[3])), thrower: n.thrower, sec: (n.throwTick - r.freezeEndTick) / 64 }
    })

  const split: Partial<Record<Zone, number>> = {}
  const lurkers: string[] = []
  if (hitF !== undefined) {
    for (const t of ts) {
      if (t.hp[hitF] <= 0) continue
      const onSite = geo.siteAt(t.x[hitF], t.y[hitF])
      const z: Zone = onSite ?? geo.zoneAt(t.x[hitF], t.y[hitF]); split[z] = (split[z] ?? 0) + 1
      // Lurker: beim Hit weit weg von der Hit-Site und nicht auf dem Weg dorthin
      const sc = site === 'A' ? geo.siteA : geo.siteB
      if (z !== site && Math.hypot(t.x[hitF] - sc[0], t.y[hitF] - sc[1]) > 2.2 * geo.siteR) lurkers.push(t.steamid)
    }
  }
  const f20 = Math.min(end, frameAtSec(r, 20))
  const earlyMid = ts.filter(t => t.hp[f20] > 0 && geo.zoneAt(t.x[f20], t.y[f20]) === 'Mid').length
  const won = r.winner === 'T'

  // Startrichtung pro Spieler: stärkste Festlegung Richtung A oder B zwischen 5 und 25 s
  const start = { A: 0, B: 0, Mid: 0 }
  const early = new Map<string, 'A' | 'B' | 'Mid'>()
  const fA = frameAtSec(r, 5), fB = Math.min(end, frameAtSec(r, 25), hitF ?? end)
  for (const t of ts) {
    let maxA = 0, maxB = 0
    for (let f = fA; f <= fB && t.hp[f] > 0; f += 4) { const s = geo.leanScore(t.x[f], t.y[f]); maxA = Math.max(maxA, s); maxB = Math.max(maxB, -s) }
    const lean = maxA > 0.12 && maxA >= maxB ? 'A' : maxB > 0.12 ? 'B' : 'Mid'
    early.set(t.steamid, lean); start[lean]++
  }
  const startMain: 'A' | 'B' | undefined = start.A >= 3 && start.A > start.B ? 'A' : start.B >= 3 && start.B > start.A ? 'B' : undefined
  // Rotierer: zuerst andere Seite, beim Hit auf der Hit-Site
  const rotators = hitF !== undefined && site ? ts.filter(t => t.hp[hitF!] > 0 && early.get(t.steamid) === (site === 'A' ? 'B' : 'A') &&
    geo.leanAt(t.x[hitF!], t.y[hitF!]) === site).map(t => t.steamid) : []

  let style: TRound['style'], plan: string
  const execUtil = hitSec !== undefined ? utility.filter(u => u.sec >= hitSec - 12 && u.sec <= hitSec + 3 && u.type !== 'he').length : 0
  if (hitSec === undefined || !site) {
    const aliveEnd = ts.filter(t => t.hp[end] > 0).length
    if (!won && aliveEnd >= 2 && r.reason.includes('time')) { style = 'none'; plan = 'No hit (time ran out)' }
    else if (!won && aliveEnd >= 2 && r.buy.T === 'eco') { style = 'save'; plan = 'Save' }
    else { style = 'none'; plan = startMain ? `Went ${startMain}, no hit` : 'No hit' }
  } else if (startMain && startMain !== site) { style = 'fake'; plan = `${start[startMain] >= 4 ? 'Fake' : 'Rotate'} ${startMain} → ${site}` }
  else if (hitSec < 30 && (split[site] ?? 0) >= 4) { style = 'rush'; plan = `${site} rush` }
  else if (execUtil >= 3) { style = hitSec > 60 ? 'default' : 'execute'; plan = hitSec > 60 ? `Default → ${site} execute` : `${site} execute` }
  else if (hitSec > 60) { style = 'default'; plan = `Default → ${site}` }
  else { style = 'hit'; plan = `${site} hit` }

  return {
    kind: 'T', ref: { matchId: m.id, round: r.num, tick: hitTick ?? r.freezeEndTick }, matchId: m.id, round: r.num,
    buy: r.buy.T, won, site, hitSec, plan, style, split, start, rotators, lurkers, utility, earlyMid,
    opening: opening(m, r, 'T', geo), planted: !!r.plant,
  }
}

export function classifyCT(m: MatchData, r: Round, team: string, geo: Geo): CTRound {
  const cts = r.tracks.filter(t => t.side === 'CT')
  const f15 = Math.min(r.frameTicks.length - 1, frameAtSec(r, 15))
  const zones = { A: 0, Mid: 0, B: 0 }
  const positions: Record<string, string> = {}
  for (const t of cts) {
    if (t.hp[f15] <= 0) continue
    const z = geo.zoneAt(t.x[f15], t.y[f15])
    zones[z === 'A' || z === 'B' ? z : 'Mid']++
    positions[t.steamid] = prettyPlace(r.places[t.place[f15]] || geo.nearestPlace(t.x[f15], t.y[f15]))
  }
  // Aggressiv = in den ersten 25 s näher am T-Spawn als an beiden Sites
  const aggressive: CTRound['aggressive'] = []
  for (const t of cts) {
    for (let sec = 3; sec <= 25; sec += 2) {
      const f = frameAtSec(r, sec); if (f >= r.frameTicks.length || t.hp[f] <= 0) break
      const p: [number, number] = [t.x[f], t.y[f]]
      const dT = Math.hypot(p[0] - geo.tSpawn[0], p[1] - geo.tSpawn[1])
      const dSite = Math.min(Math.hypot(p[0] - geo.siteA[0], p[1] - geo.siteA[1]), Math.hypot(p[0] - geo.siteB[0], p[1] - geo.siteB[1]))
      const dCT = Math.hypot(p[0] - geo.ctSpawn[0], p[1] - geo.ctSpawn[1])
      if (dT < dSite * 0.85 && dT < dCT) {
        aggressive.push({ steamid: t.steamid, place: prettyPlace(r.places[t.place[f]] || geo.nearestPlace(p[0], p[1])), sec })
        break
      }
    }
  }
  const won = r.winner === 'CT'
  // CT-Utility der ersten 30 s (frühe Smokes/Mollys verraten das Setup)
  const utility = r.nades
    .filter(n => cts.some(t => t.steamid === n.thrower) && n.type !== 'decoy' && n.throwTick >= r.freezeEndTick && n.throwTick <= r.freezeEndTick + 30 * 64)
    .map(n => { const e = n.path[n.path.length - 1]; return { type: n.type, place: prettyPlace(geo.nearestPlace(e[1], e[2], e[3])), thrower: n.thrower, sec: (n.throwTick - r.freezeEndTick) / 64 } })
  return {
    kind: 'CT', ref: { matchId: m.id, round: r.num, tick: r.freezeEndTick + 15 * 64 }, matchId: m.id, round: r.num,
    buy: r.buy.CT, won, setup: `A${zones.A} M${zones.Mid} B${zones.B}`, zones, positions, aggressive, utility,
    stack: zones.A >= 3 ? 'A' : zones.B >= 3 ? 'B' : undefined,
    retake: r.plant ? (won ? 'won' : 'lost') : undefined,
    opening: opening(m, r, 'CT', geo),
  }
}

export function classifyRounds(m: MatchData, team: string, geo: Geo): (TRound | CTRound)[] {
  return m.rounds.map(r => (teamSide(r, team) === 'T' ? classifyT(m, r, team, geo) : classifyCT(m, r, team, geo)))
}
