// Spieler-Statistiken und Ratings aus MatchData.
// FACEIT Rating / Round Swing sind Nachbauten: FACEIT veröffentlicht die Gewichte nicht.
import type { MatchData, Round, Side } from './model.ts'

export interface PlayerStats {
  steamid: string
  name: string
  team: string
  rounds: number
  kills: number
  deaths: number
  assists: number
  flashAssists: number
  headshots: number
  damage: number
  utilDamage: number
  kastRounds: number
  openingKills: number
  openingDeaths: number
  tradeKills: number
  tradedDeaths: number
  multi: [number, number, number, number, number] // 1k..5k Runden
  clutchesWon: number
  clutchesPlayed: number
  enemiesFlashed: number
  teamFlashed: number
  flashesThrown: number
  smokesThrown: number
  hesThrown: number
  molliesThrown: number
  swing: number // Summe Gewinnchancen-Änderung (0..1 pro Runde)
  rwsSum: number
  // abgeleitet
  adr: number
  kd: number
  kpr: number
  dpr: number
  hsPct: number
  kast: number
  swingPct: number // Round Swing in Prozentpunkten pro Runde
  rws: number
  rating: number // FACEIT-Rating-Nachbau, ~1,00 = Durchschnitt
}

export interface Clutch { round: number; steamid: string; vs: number; won: boolean; side: Side }

/** Gewinnchance der T-Seite aus Lebenden, Bombe und Ausrüstungs-Differenz (T − CT, nur Lebende). */
export function tWinProb(tAlive: number, ctAlive: number, planted: boolean, equipDiff = 0): number {
  if (ctAlive === 0 && tAlive > 0) return 1
  if (tAlive === 0) return planted ? 0.12 + Math.max(0, 0.18 - 0.04 * ctAlive) : 0
  const x = -0.15 + 0.78 * (tAlive - ctAlive) + (planted ? 1.1 : 0) + 0.08 * (5 - Math.max(tAlive, ctAlive)) + 0.00004 * equipDiff
  return 1 / (1 + Math.exp(-x))
}

const sideIn = (r: Round, s?: string): Side | undefined => (s ? r.tracks.find(t => t.steamid === s)?.side : undefined)

/** Abgeleitete Werte aus den Summen berechnen (auch nach dem Zusammenführen mehrerer Matches). */
export function finishStats(p: PlayerStats) {
  const R = Math.max(1, p.rounds)
  p.adr = p.damage / R; p.kpr = p.kills / R; p.dpr = p.deaths / R
  p.kd = p.deaths ? p.kills / p.deaths : p.kills
  p.hsPct = p.kills ? (100 * p.headshots) / p.kills : 0
  p.kast = (100 * p.kastRounds) / R
  p.swingPct = (100 * p.swing) / R
  p.rws = p.rwsSum / R
  // Multikill-Wirkung: mehrere Kills in einer Runde zählen überproportional
  const mk = (p.multi[0] + 2.2 * p.multi[1] + 3.6 * p.multi[2] + 5 * p.multi[3] + 6.5 * p.multi[4]) / R
  p.rating = 0.3 * (1 + p.swingPct / 8) + 0.25 * (p.rws / 10) + 0.2 * (p.kast / 72) + 0.25 * (mk / 0.75)
}

export function computeStats(m: MatchData, roundFilter?: (r: Round) => boolean): { players: PlayerStats[]; clutches: Clutch[] } {
  const rounds = roundFilter ? m.rounds.filter(roundFilter) : m.rounds
  const S = new Map<string, PlayerStats>()
  for (const p of m.players) {
    S.set(p.steamid, {
      steamid: p.steamid, name: p.name, team: p.team, rounds: 0, kills: 0, deaths: 0, assists: 0, flashAssists: 0,
      headshots: 0, damage: 0, utilDamage: 0, kastRounds: 0, openingKills: 0, openingDeaths: 0, tradeKills: 0,
      tradedDeaths: 0, multi: [0, 0, 0, 0, 0], clutchesWon: 0, clutchesPlayed: 0, enemiesFlashed: 0, teamFlashed: 0,
      flashesThrown: 0, smokesThrown: 0, hesThrown: 0, molliesThrown: 0, swing: 0, rwsSum: 0,
      adr: 0, kd: 0, kpr: 0, dpr: 0, hsPct: 0, kast: 0, swingPct: 0, rws: 0, rating: 0,
    })
  }
  const clutches: Clutch[] = []
  const addSwing = (s: string | undefined, v: number) => { const p = s && S.get(s); if (p) p.swing += v }

  for (const r of rounds) {
    const inRound = r.tracks.map(t => t.steamid).filter(s => S.has(s))
    for (const s of inRound) S.get(s)!.rounds++
    const enemy = (a?: string, b?: string) => !!a && !!b && sideIn(r, a) !== sideIn(r, b)

    // Kills, Opening, Trades, Multikills
    const killsBy = new Map<string, number>()
    const kast = new Set<string>()
    let first = true
    for (const k of r.kills) {
      if (k.tick > r.endTick) continue // Exit-Frags nach Rundenende zählen nicht
      const v = S.get(k.victim); if (v) v.deaths++
      if (k.traded) { if (v) v.tradedDeaths++; kast.add(k.victim) }
      if (k.attacker && enemy(k.attacker, k.victim)) {
        const a = S.get(k.attacker)
        if (a) {
          a.kills++; if (k.headshot) a.headshots++; if (k.isTrade) a.tradeKills++
          killsBy.set(k.attacker, (killsBy.get(k.attacker) ?? 0) + 1); kast.add(k.attacker)
        }
        if (first) { if (a) a.openingKills++; if (v) v.openingDeaths++ }
        first = false
      }
      if (k.assister && enemy(k.assister, k.victim)) {
        const as = S.get(k.assister); if (as) { as.assists++; if (k.flashAssist) as.flashAssists++; kast.add(k.assister) }
      }
    }
    for (const [s, n] of killsBy) S.get(s)!.multi[Math.min(5, n) - 1]++

    // Überlebt → KAST
    for (const tr of r.tracks) if (!r.kills.some(k => k.victim === tr.steamid && k.tick <= r.endTick)) kast.add(tr.steamid)
    for (const s of kast) { const p = S.get(s); if (p) p.kastRounds++ }

    // Schaden (nur Gegner)
    const dmgInRound = new Map<string, number>()
    for (const d of r.damages) {
      if (!d.attacker || !enemy(d.attacker, d.victim)) continue
      const a = S.get(d.attacker); if (!a) continue
      a.damage += d.dmg; if (d.utility) a.utilDamage += d.dmg
      if (d.tick <= r.endTick) dmgInRound.set(d.attacker, (dmgInRound.get(d.attacker) ?? 0) + d.dmg)
    }
    for (const b of r.blinds) {
      const a = S.get(b.attacker); if (!a || b.duration < 0.7) continue
      if (b.team) a.teamFlashed++; else if (enemy(b.attacker, b.victim)) a.enemiesFlashed++
    }
    for (const n of r.nades) {
      const a = S.get(n.thrower); if (!a) continue
      if (n.type === 'flash') a.flashesThrown++; else if (n.type === 'smoke') a.smokesThrown++
      else if (n.type === 'he') a.hesThrown++; else if (n.type === 'molotov') a.molliesThrown++
    }

    // RWS: Gewinner teilen 100 Punkte nach Schaden; bei Bomben-Sieg bekommt Planter/Defuser 30
    {
      const winners = r.tracks.filter(t => t.side === r.winner).map(t => t.steamid)
      const bombBy = r.reason.includes('exploded') ? r.plant?.player : r.reason.includes('defused') ? r.defuse?.player : undefined
      const pool = bombBy && winners.includes(bombBy) ? 70 : 100
      if (pool === 70) { const p = S.get(bombBy!); if (p) p.rwsSum += 30 }
      const total = winners.reduce((a, s) => a + (dmgInRound.get(s) ?? 0), 0)
      for (const s of winners) { const p = S.get(s); if (p) p.rwsSum += total ? (pool * (dmgInRound.get(s) ?? 0)) / total : pool / winners.length }
    }

    // Round Swing + Clutches
    const alive: Record<Side, Set<string>> = { CT: new Set(), T: new Set() }
    const equip = new Map<string, number>()
    for (const tr of r.tracks) { alive[tr.side].add(tr.steamid); equip.set(tr.steamid, tr.equipValue) }
    const eqDiff = () => [...alive.T].reduce((a, s) => a + (equip.get(s) ?? 0), 0) - [...alive.CT].reduce((a, s) => a + (equip.get(s) ?? 0), 0)
    const prob = (planted: boolean) => tWinProb(alive.T.size, alive.CT.size, planted, eqDiff())
    const clutchOf: Partial<Record<Side, Clutch>> = {}
    // Ereignisse in Zeitfolge: Kills + Plant + Defuse
    type Ev = { tick: number; kind: 'kill' | 'plant' | 'defuse'; i?: number }
    const evs: Ev[] = r.kills.map((k, i) => ({ tick: k.tick, kind: 'kill' as const, i }))
    if (r.plant) evs.push({ tick: r.plant.tick, kind: 'plant' })
    if (r.defuse) evs.push({ tick: r.defuse.tick, kind: 'defuse' })
    evs.sort((a, b) => a.tick - b.tick)
    let planted = false
    for (const ev of evs) {
      if (ev.tick > r.endTick) break
      if (ev.kind === 'plant') { const before = prob(false); planted = true; addSwing(r.plant!.player, prob(true) - before); continue }
      if (ev.kind === 'defuse') { addSwing(r.defuse!.player, prob(true)); continue }
      const k = r.kills[ev.i!]
      const vs = sideIn(r, k.victim); if (!vs) continue
      const before = prob(planted)
      alive[vs].delete(k.victim)
      const after = prob(planted)
      const delta = vs === 'CT' ? after - before : before - after // Gewinn für die Seite des Killers
      if (k.attacker && enemy(k.attacker, k.victim)) {
        // Anteil nach Schaden am Opfer (Killer mindestens 40 %), Flash-Assist bekommt 15 %
        const dmgOnVictim = new Map<string, number>()
        for (const d of r.damages) if (d.victim === k.victim && d.tick <= k.tick && d.attacker && enemy(d.attacker, k.victim)) dmgOnVictim.set(d.attacker, (dmgOnVictim.get(d.attacker) ?? 0) + d.dmg)
        const total = [...dmgOnVictim.values()].reduce((a, b) => a + b, 0)
        const flash = k.flashAssist && k.assister && enemy(k.assister, k.victim) ? 0.15 : 0
        const rest = 1 - flash
        addSwing(k.attacker, delta * rest * (0.4 + (total ? 0.6 * (dmgOnVictim.get(k.attacker) ?? 0) / total : 0.6)))
        if (total) for (const [s, d] of dmgOnVictim) if (s !== k.attacker) addSwing(s, delta * rest * 0.6 * d / total)
        if (flash) addSwing(k.assister, delta * flash)
      }
      // Ein getradeter Tod kostet weniger
      addSwing(k.victim, -delta * (k.traded ? 0.5 : 1))
      for (const side of ['CT', 'T'] as Side[]) {
        const other = side === 'CT' ? 'T' : 'CT'
        if (alive[side].size === 1 && alive[other].size >= 1 && !clutchOf[side]) {
          clutchOf[side] = { round: r.num, steamid: [...alive[side]][0], vs: alive[other].size, won: false, side }
        }
      }
    }
    for (const side of ['CT', 'T'] as Side[]) {
      const c = clutchOf[side]; if (!c) continue
      c.won = r.winner === side
      clutches.push(c)
      const p = S.get(c.steamid); if (p) { p.clutchesPlayed++; if (c.won) p.clutchesWon++ }
    }
  }

  for (const p of S.values()) finishStats(p)
  return { players: [...S.values()].filter(p => p.rounds > 0), clutches }
}
