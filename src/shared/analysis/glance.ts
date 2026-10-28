// „At a glance“: Report aus Sicht UNSERES Teams (Berat, 28.10.: „lieber weniger, dafür wichtigere Sachen“).
// prepare() klassifiziert jede Runde einmal (teuer), cards() rechnet daraus die 7 Karten, auf Wunsch nur für einen Spieler (billig).
// Ampel-Grenzen: lights.ts. Test: glance.test.ts.
import type { Kill, MatchData, Round, Side } from '../model.ts'
import { computeStats } from '../stats.ts'
import { buyClass } from './economy.ts'
import { buildGeo } from './geo.ts'
import { LIMITS, light, MIN_SAMPLE, worst, type Light } from './lights.ts'
import { mergeStats, type Entry } from './report.ts'
import { classifyCT, classifyT, teamSide, type CTRound, type Ref, type TRound } from './rounds.ts'
import type { BuyClass } from './types.ts'
import { pct } from './util.ts'

export type CardId = 'opening' | 'trades' | 'advantage' | 'rounds' | 't' | 'ct' | 'util'
export type WinType = 'elim' | 'bomb' | 'defuse' | 'time'
export interface Pick { ref: Ref; why: string }
export interface Fact { text: string; tone?: 'good' | 'bad' }
/** eine Karte: Zahl + Einheit, Ampel (undefined = zu wenig Runden), ein Satz, kleine Fakten, 2–3 schlimmste Runden, Trainingsziel */
export interface Card {
  id: CardId; title: string; value: string; unit: string; light?: Light; text: string; facts: Fact[]; rounds: Pick[]; goal: string
  /** Kurzform des Ziels für den Focus of the week */
  focus: string
  /** true = Team-Wert, der Spieler-Filter wirkt hier nicht */
  team: boolean
}
interface WL { won: number; total: number }

/** Tod mit Lebenden je Seite (aus unserer Sicht) direkt vor und nach dem Kill */
export interface Death { k: Kill; ours: boolean; enemyKill: boolean; usBefore: number; themBefore: number; us: number; them: number; opening: boolean }
export interface RoundData {
  m: MatchData; r: Round; side: Side; won: boolean; buyUs: BuyClass; buyThem: BuyClass
  ours: Set<string>; deaths: Death[]
  /** unsere T-Analyse (side T) bzw. ihre T-Analyse + unsere CT-Analyse (side CT) */
  t?: TRound; oppT?: TRound; ct?: CTRound
}
export interface Prepared { us: string; them: string; entries: Entry[]; rounds: RoundData[]; names: Record<string, string> }

const LEAD = 4 * 64 // Replay 4 s vor dem Ereignis öffnen
const at = (d: RoundData, tick: number): Ref => ({ matchId: d.m.id, round: d.r.num, tick: Math.max(d.r.freezeEndTick, Math.round(tick) - LEAD) })
const key = (d: RoundData) => `${d.m.id}:${d.r.num}`

export function winType(reason: string): WinType {
  return reason.includes('exploded') ? 'bomb' : reason.includes('defused') ? 'defuse' : /saved|time/.test(reason) ? 'time' : 'elim'
}

/** Tode einer Runde in Zeitfolge mit Lebenden je Seite; Exit-Frags nach Rundenende zählen nicht (wie stats.ts) */
export function deathsOf(r: Round, side: Side): Death[] {
  const sideOf = new Map(r.tracks.map(t => [t.steamid, t.side]))
  let us = r.tracks.filter(t => t.side === side).length, them = r.tracks.length - us, opened = false
  return r.kills.filter(k => k.tick <= r.endTick).sort((a, b) => a.tick - b.tick).map(k => {
    const vs = sideOf.get(k.victim), as = k.attacker ? sideOf.get(k.attacker) : undefined
    const ours = vs === side, enemyKill = !!as && !!vs && as !== vs, usBefore = us, themBefore = them
    if (ours) us--; else if (vs) them--
    const opening = enemyKill && !opened
    if (opening) opened = true
    return { k, ours, enemyKill, usBefore, themBefore, us, them, opening }
  })
}

/** Teuer: jede Runde einmal klassifizieren (T-Hits, Plants, Retakes, Rotationen) */
export function prepare(entries: Entry[], them: string): Prepared {
  const matches = entries.map(e => e.match), geo = buildGeo(matches)
  const names: Record<string, string> = {}
  for (const m of matches) for (const p of m.players) names[p.steamid] = p.name
  const rounds: RoundData[] = []
  for (const { match: m, team } of entries) {
    const opp = m.teams.find(t => t !== team) ?? them
    for (const r of m.rounds) {
      const side = teamSide(r, team), other: Side = side === 'T' ? 'CT' : 'T'
      const d: RoundData = {
        m, r, side, won: r.winner === side, buyUs: buyClass(m, r, side), buyThem: buyClass(m, r, other),
        ours: new Set(r.tracks.filter(t => t.side === side).map(t => t.steamid)), deaths: deathsOf(r, side),
      }
      if (side === 'T') d.t = classifyT(m, r, team, geo)
      else { d.oppT = classifyT(m, r, opp, geo); d.ct = classifyCT(m, r, team, geo, d.oppT) }
      rounds.push(d)
    }
  }
  return { us: entries[0].team, them, entries, rounds, names }
}

// ---------------------------------------------------------------- Karten

const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`
/** Runden einmal je Runde, max. 3 */
function top(...lists: { d: RoundData; ref: Ref; why: string }[][]): Pick[] {
  const seen = new Set<string>(), out: Pick[] = []
  for (const x of lists.flat()) { if (seen.has(key(x.d))) continue; seen.add(key(x.d)); out.push({ ref: x.ref, why: x.why }); if (out.length === 3) break }
  return out
}
const lit = (v: number, l: (typeof LIMITS)[keyof typeof LIMITS], sample: number) => (sample >= MIN_SAMPLE ? light(v, l) : undefined)
const bySide = (ds: RoundData[], f: (s: Side) => string) => (['T', 'CT'] as Side[]).filter(s => ds.some(d => d.side === s)).map(s => ({ text: `${s} ${f(s)}` }))

/** 1 Opening-Duelle: gewonnen und Rundensieg danach, je Seite */
export function openingCard(P: Prepared, p?: string): Card {
  const name = (id?: string) => (id && P.names[id]) || '?'
  const rs = P.rounds.map(d => ({ d, o: d.deaths.find(x => x.opening) })).filter((x): x is { d: RoundData; o: Death } => !!x.o && (!p || x.o.k.victim === p || x.o.k.attacker === p))
  const won = rs.filter(x => !x.o.ours), lost = rs.filter(x => x.o.ours)
  const conv = won.filter(x => x.d.won).length, back = lost.filter(x => x.d.won).length, v = pct(won.length, rs.length)
  return {
    id: 'opening', title: 'Opening duels', value: `${v} %`, unit: 'first duels won', light: lit(v, LIMITS.opening, rs.length), team: false,
    text: rs.length ? `Won ${won.length}/${rs.length} first duels, ${conv} of them became round wins.` : 'No opening duels.',
    facts: [...bySide(rs.map(x => x.d), s => `${won.filter(x => x.d.side === s).length}/${rs.filter(x => x.d.side === s).length}`),
      { text: `Won it → round ${conv}/${won.length}` }, { text: `Lost it → round ${back}/${lost.length}` }],
    rounds: top(won.filter(x => !x.d.won).map(x => ({ d: x.d, ref: at(x.d, x.o.k.tick), why: 'Won the opening, lost the round' })),
      lost.filter(x => !x.d.won).map(x => ({ d: x.d, ref: at(x.d, x.o.k.tick), why: `Opening death: ${name(x.o.k.victim)}` }))),
    goal: 'Opening duels: take first contact in pairs, so a lost duel is traded at once.',  focus: 'Take first contact in pairs',
  }
}

/** 2 Trades: unsere Tode durch Gegner ohne Rache in 5 s; Tode als Letzter zählen nicht (niemand konnte traden) */
export function tradesCard(P: Prepared, p?: string): Card {
  const name = (id?: string) => (id && P.names[id]) || '?'
  const ds = P.rounds.flatMap(d => d.deaths.filter(x => x.ours && x.enemyKill && x.usBefore > 1 && (!p || x.k.victim === p)).map(x => ({ d, x })))
  const un = ds.filter(y => !y.x.k.traded), op = ds.filter(y => y.x.opening), opUn = op.filter(y => !y.x.k.traded)
  const v = pct(un.length, ds.length)
  const perRound = new Map<RoundData, typeof un>()
  for (const y of un) perRound.set(y.d, [...(perRound.get(y.d) ?? []), y])
  return {
    id: 'trades', title: 'Trades', value: `${v} %`, unit: 'deaths not traded', light: lit(v, LIMITS.untraded, ds.length), team: false,
    text: ds.length ? `${un.length} of ${ds.length} deaths were not traded within 5 s.` : 'No deaths to trade.',
    facts: [{ text: `Opening death untraded ${opUn.length}/${op.length}`, tone: op.length && opUn.length * 2 > op.length ? 'bad' : undefined },
      ...bySide(ds.map(y => y.d), s => `${pct(un.filter(y => y.d.side === s).length, ds.filter(y => y.d.side === s).length)} %`)],
    rounds: top(opUn.filter(y => !y.d.won).map(y => ({ d: y.d, ref: at(y.d, y.x.k.tick), why: `Opening death not traded: ${name(y.x.k.victim)}` })),
      [...perRound].filter(([d]) => !d.won).sort((a, b) => b[1].length - a[1].length).map(([d, ys]) => ({ d, ref: at(d, ys[0].x.k.tick), why: `${n(ys.length, 'death')} not traded` }))),
    goal: 'Trades: the second player stays within flash range of the first, nobody peeks alone.', focus: 'Trade every death',
  }
}

export interface Advantage { diff: number; tick: number; us: number; them: number; first: number }
/** Überzahl einer Runde: größter Vorsprung (us − them, Gegner leben noch) mit Moment und Stand; first = Tick der ersten Überzahl */
export function advantageOf(d: RoundData): Advantage | undefined {
  let best: Advantage | undefined
  for (const x of d.deaths) if (x.them > 0 && x.us > x.them && (!best || x.us - x.them > best.diff)) best = { diff: x.us - x.them, tick: x.k.tick, us: x.us, them: x.them, first: best?.first ?? x.k.tick }
  return best
}

/** 3 Vorteil verspielt: Runden verloren trotz Überzahl (5v4, 4v3 …). Spieler: Runden, in denen er die Überzahl erlebt; verloren zählt nur, wenn er darin stirbt */
export function advantageCard(P: Prepared, p?: string): Card {
  const rs = P.rounds.map(d => ({ d, a: advantageOf(d) })).filter((x): x is { d: RoundData; a: Advantage } => !!x.a)
  const died = (x: { d: RoundData; a: Advantage }, after: boolean) => x.d.deaths.some(y => y.k.victim === p && (after ? y.k.tick >= x.a.first : y.k.tick < x.a.first))
  const base = p ? rs.filter(x => x.d.ours.has(p) && !died(x, false)) : rs
  const lost = base.filter(x => !x.d.won && (!p || died(x, true)))
  const v = pct(lost.length, base.length), worstLost = [...lost].sort((a, b) => b.a.diff - a.a.diff)
  return {
    id: 'advantage', title: 'Advantage thrown', value: `${lost.length}/${base.length}`, unit: 'man-up rounds lost', light: lit(v, LIMITS.advantage, base.length), team: false,
    text: lost.length ? `Lost ${n(lost.length, 'round')} after going a player up, worst a ${worstLost[0].a.us}v${worstLost[0].a.them}.` : base.length ? 'Every man-up round was closed out.' : 'Never a player up.',
    facts: bySide(base.map(x => x.d), s => `lost ${lost.filter(x => x.d.side === s).length}/${base.filter(x => x.d.side === s).length}`),
    rounds: top(worstLost.map(x => ({ d: x.d, ref: at(x.d, x.a.tick), why: `Lost a ${x.a.us}v${x.a.them}` }))),
    goal: 'Man up: group up and trade, no solo peeks, play for time and the bomb.', focus: 'Close out man-up rounds',
  }
}

const ANTI_US: BuyClass[] = ['full', 'light'], ANTI_THEM: BuyClass[] = ['eco', 'deagle'], FORCE_US: BuyClass[] = ['deagle', 'smg']
/** 4 Rundentypen: Pistols, 2. Runde nach Pistol-Sieg, verlorene Anti-Ecos, gewonnene Forces */
export function roundTypesCard(P: Prepared): Card {
  const pistols = P.rounds.filter(d => d.buyUs === 'pistol')
  const conv = pistols.filter(d => d.won).flatMap(d => {
    const nx = P.rounds[P.rounds.indexOf(d) + 1]
    return nx && nx.m === d.m && nx.side === d.side ? [nx] : []
  })
  const anti = P.rounds.filter(d => ANTI_US.includes(d.buyUs) && ANTI_THEM.includes(d.buyThem)), antiLost = anti.filter(d => !d.won)
  const forces = P.rounds.filter(d => FORCE_US.includes(d.buyUs) && ANTI_US.includes(d.buyThem))
  const convLost = conv.filter(d => !d.won), bad = antiLost.length + convLost.length, sample = anti.length + conv.length
  const ref = (d: RoundData) => at(d, d.r.freezeEndTick)
  return {
    id: 'rounds', title: 'Round types', value: `${bad}`, unit: bad === 1 ? 'costly loss' : 'costly losses', light: sample ? light(bad, LIMITS.roundTypes) : undefined, team: true,
    text: `Pistols ${pistols.filter(d => d.won).length}/${pistols.length}, anti-ecos lost ${antiLost.length}/${anti.length}, forces won ${forces.filter(d => d.won).length}/${forces.length}.`,
    facts: [...conv.map(d => ({ text: `Round ${d.r.num} after pistol ${d.won ? 'won' : 'lost'}`, tone: d.won ? 'good' as const : 'bad' as const })),
      ...(anti.length ? [{ text: `Anti-eco lost ${antiLost.length}/${anti.length}`, tone: antiLost.length ? 'bad' as const : undefined }] : [])],
    rounds: top(antiLost.map(d => ({ d, ref: ref(d), why: 'Lost an anti-eco' })), convLost.map(d => ({ d, ref: ref(d), why: 'Lost round 2 after the pistol win' })),
      pistols.filter(d => !d.won).map(d => ({ d, ref: ref(d), why: 'Lost the pistol round' }))),
    goal: 'Anti-ecos and round 2: stay together, no hero peeks, trade the first contact.', focus: 'Win anti-ecos and round 2',
  }
}

/** 5 T: Site-Hits, Plant-Quote, Siege nach Plant */
export function tCard(P: Prepared): Card {
  const rs = P.rounds.filter(d => d.t), planted = rs.filter(d => d.r.plant), post = planted.filter(d => d.won)
  const pp = pct(planted.length, rs.length), wp = pct(post.length, planted.length)
  const lp = lit(pp, LIMITS.plant, rs.length), lw = lit(wp, LIMITS.postPlant, planted.length)
  const hits = (s: 'A' | 'B') => rs.filter(d => d.t!.site === s).length
  return {
    id: 't', title: 'T side', value: `${pp} %`, unit: 'rounds with a plant', light: worst(lp, lw), team: true,
    text: rs.length ? `Planted in ${planted.length}/${rs.length} T rounds and won ${post.length}/${planted.length} of those.` : 'No T rounds.',
    facts: [{ text: `A hits ${hits('A')}` }, { text: `B hits ${hits('B')}` }, { text: `No hit ${rs.filter(d => !d.t!.site).length}` },
      { text: `After plant ${post.length}/${planted.length}`, tone: lw === 'bad' ? 'bad' : lw === 'good' ? 'good' : undefined }],
    rounds: top(planted.filter(d => !d.won).map(d => ({ d, ref: at(d, d.r.plant!.tick), why: d.r.plant!.site ? `Lost after the ${d.r.plant!.site} plant` : 'Lost after the plant' })),
      rs.filter(d => !d.won && !d.r.plant && ANTI_US.includes(d.buyUs)).map(d => ({ d, ref: d.t!.ref, why: 'Full buy, no plant' }))),
    ...(lw === 'bad' && lp !== 'bad'
      ? { goal: 'Post-plant: set the crossfire before the defuse, nobody chases kills.', focus: 'Hold the post-plant crossfire' }
      : { goal: 'Get the bomb down: call the hit by 1:00 and go together.', focus: 'Hit by 1:00 and plant' }),
  }
}

/** 6 CT: wo Sites fallen, Retake-Quote, zu frühe Rotationen (> 10 s vor dem Hit) */
export function ctCard(P: Prepared): Card {
  const rs = P.rounds.filter(d => d.ct), planted = rs.filter(d => d.r.plant)
  const tries = planted.filter(d => { const x = d.oppT?.plantInfo?.retake; return x && x !== 'save' && x !== 'no-ct' }), wins = tries.filter(d => d.won)
  const early = rs.map(d => ({ d, x: d.ct!.rotations.filter(x => x.vsHit < -10).sort((a, b) => a.startSec - b.startSec)[0] })).filter(y => y.x)
  const v = pct(wins.length, tries.length)
  const lr = lit(v, LIMITS.retake, tries.length), le = rs.length >= MIN_SAMPLE ? light(early.length, LIMITS.earlyRotation) : undefined
  const falls = (s: 'A' | 'B') => planted.filter(d => d.r.plant!.site === s).length
  return {
    id: 'ct', title: 'CT side', value: tries.length ? `${v} %` : '–', unit: 'retakes won', light: worst(lr, le), team: true,
    text: rs.length ? `Sites fell in ${planted.length}/${rs.length} CT rounds (A ${falls('A')}, B ${falls('B')}), retakes won ${wins.length}/${tries.length}.` : 'No CT rounds.',
    facts: [{ text: `A falls ${falls('A')}` }, { text: `B falls ${falls('B')}` }, { text: `Early rotations ${early.length}`, tone: early.length ? 'bad' : undefined }],
    rounds: top(tries.filter(d => !d.won).map(d => ({ d, ref: at(d, d.r.plant!.tick), why: `Retake lost on ${d.r.plant!.site ?? '?'}` })),
      early.filter(y => !y.d.won).map(y => ({ d: y.d, ref: at(y.d, y.d.r.freezeEndTick + y.x!.startSec * 64), why: `Rotated ${Math.round(-y.x!.vsHit)} s before the hit` }))),
    ...(le === 'bad' && lr !== 'bad'
      ? { goal: 'Rotations: rotate on confirmed info (bomb seen, 3+ players), not on sound.', focus: 'Rotate on info, not on sound' }
      : { goal: 'Retakes: wait for the team and go in together with utility, not one by one.', focus: 'Retake together with utility' }),
  }
}

/** 7 Utility: Flash-Wirkung, Flash-Assists, Teamflashes, Util-Schaden */
export function utilCard(P: Prepared, p?: string): Card {
  let flashes = 0, enemies = 0, team = 0, assists = 0, dmg = 0
  const tf: { d: RoundData; ref: Ref; why: string; c: number }[] = [], blank: typeof tf = []
  for (const d of P.rounds) {
    const mine = (id?: string) => !!id && d.ours.has(id) && (!p || id === p)
    const enemy = (id: string) => !d.ours.has(id) && d.r.tracks.some(t => t.steamid === id)
    const f = d.r.nades.filter(x => x.type === 'flash' && mine(x.thrower)).length
    const bl = d.r.blinds.filter(b => b.duration >= 0.7 && mine(b.attacker))
    const e = bl.filter(b => !b.team && enemy(b.victim)).length, t = bl.filter(b => b.team && b.victim !== b.attacker)
    flashes += f; enemies += e; team += t.length
    assists += d.r.kills.filter(k => k.tick <= d.r.endTick && k.flashAssist && mine(k.assister) && enemy(k.victim)).length
    dmg += d.r.damages.filter(x => x.utility && mine(x.attacker) && enemy(x.victim)).reduce((a, x) => a + x.dmg, 0)
    if (t.length) tf.push({ d, ref: at(d, t[0].tick), why: n(t.length, 'team flash', 'team flashes'), c: t.length })
    if (!d.won && f >= 2 && !e) blank.push({ d, ref: at(d, d.r.freezeEndTick), why: `${f} flashes, nobody blinded`, c: f })
  }
  const per = flashes ? enemies / flashes : 0, share = pct(team, enemies + team)
  const lt = flashes >= MIN_SAMPLE ? light(share, LIMITS.teamFlash) : undefined
  return {
    id: 'util', title: 'Utility', value: per.toFixed(1), unit: 'enemies blinded per flash', light: worst(lit(per, LIMITS.flash, flashes), lt), team: false,
    text: `${n(enemies, 'enemy', 'enemies')} blinded by ${n(flashes, 'flash', 'flashes')}, ${n(assists, 'flash assist')}.`,
    facts: [{ text: `Team flashes ${team}`, tone: lt === 'bad' ? 'bad' : undefined }, { text: `Util damage ${dmg}` }],
    rounds: top(tf.sort((a, b) => b.c - a.c), blank.sort((a, b) => b.c - a.c)),
    goal: 'Flashes: learn 2 pop-flashes per site, call them, never flash your own entry.', focus: 'Pop-flashes, no team flashes',
  }
}

export function cards(P: Prepared, player?: string): Card[] {
  return [openingCard(P, player), tradesCard(P, player), advantageCard(P, player), roundTypesCard(P), tCard(P), ctCard(P), utilCard(P, player)]
}

/** 3 Ziele fürs nächste Training: rote Karten zuerst, dann gelbe */
export const goals = (cs: Card[], k = 3): Card[] => [...cs.filter(c => c.light === 'bad'), ...cs.filter(c => c.light === 'warn')].slice(0, k)

// ---------------------------------------------------------------- Kopf, Runden, Spieler, Wirtschaft

/** Unser Team im Match: die meisten Mitglieder der Team-Seite (SteamIDs), sonst das Team, in dem „Exi“ spielt, sonst das erste */
export function ourTeam(m: MatchData, steamids: string[]): string {
  const best = m.teams.map(t => ({ t, n: m.players.filter(p => p.team === t && steamids.includes(p.steamid)).length })).sort((a, b) => b.n - a.n)[0]
  return best?.n ? best.t : m.players.find(p => p.name.toLowerCase() === 'exi')?.team ?? m.teams[0]
}

export interface RoundInfo {
  ref: Ref; side: Side; won: boolean; us: number; them: number; buyUs: BuyClass; buyThem: BuyClass; win: WinType; plant?: string
  opening?: { killer?: string; victim: string; ours: boolean }
}
export function roundInfos(P: Prepared): RoundInfo[] {
  const score = new Map<string, [number, number]>()
  return P.rounds.map(d => {
    const s = score.get(d.m.id) ?? [0, 0]
    s[d.won ? 0 : 1]++; score.set(d.m.id, s)
    const o = d.deaths.find(x => x.opening)
    return { ref: at(d, d.r.freezeEndTick), side: d.side, won: d.won, us: s[0], them: s[1], buyUs: d.buyUs, buyThem: d.buyThem, win: winType(d.r.reason),
      plant: d.r.plant ? d.r.plant.site ?? '?' : undefined, opening: o && { killer: o.k.attacker, victim: o.k.victim, ours: !o.ours } }
  })
}

export const sidesOf = (P: Prepared): Record<Side, WL> => {
  const wl = (s: Side) => { const rs = P.rounds.filter(d => d.side === s); return { won: rs.filter(d => d.won).length, total: rs.length } }
  return { T: wl('T'), CT: wl('CT') }
}

export interface PlayerRow { steamid: string; name: string; rating: number; openW: number; openL: number; untraded: number; kast: number; adr: number; flashAssists: number; clutchW: number; clutchN: number }
export function playerRows(P: Prepared): PlayerRow[] {
  return mergeStats(P.entries.map(e => computeStats(e.match).players.filter(p => p.team === e.team))).sort((a, b) => b.rating - a.rating).map(p => ({
    steamid: p.steamid, name: p.name, rating: p.rating, openW: p.openingKills, openL: p.openingDeaths, untraded: p.deaths - p.tradedDeaths,
    kast: p.kast, adr: p.adr, flashAssists: p.flashAssists, clutchW: p.clutchesWon, clutchN: p.clutchesPlayed,
  }))
}

export const BUY_ORDER: BuyClass[] = ['pistol', 'second', 'full', 'light', 'smg', 'deagle', 'eco']
export interface EcoRow { cls: BuyClass; us: WL; them: WL }
/** Buy-Typ × Sieg für beide Teams (them.won = Runden, die sie mit dieser Klasse gewonnen haben) */
export function economyRows(P: Prepared): EcoRow[] {
  const wl = (f: (d: RoundData) => boolean, won: (d: RoundData) => boolean) => { const rs = P.rounds.filter(f); return { won: rs.filter(won).length, total: rs.length } }
  return BUY_ORDER.map(cls => ({ cls, us: wl(d => d.buyUs === cls, d => d.won), them: wl(d => d.buyThem === cls, d => !d.won) })).filter(e => e.us.total + e.them.total)
}
