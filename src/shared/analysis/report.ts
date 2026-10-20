// Analyse eines Teams über eine oder mehrere Demos. Liefert strukturierte Daten; die UI zeigt sie als Kacheln/Icons.
import type { BuyType, MatchData, Side } from '../model.ts'
import { computeStats, finishStats, type PlayerStats } from '../stats.ts'
import { buildGeo, frameAtSec, prettyPlace } from './geo.ts'
import { classifyRounds, teamSide, type CTRound, type Ref, type TRound } from './rounds.ts'

export interface Entry { match: MatchData; team: string }
export type TipKind = 'site' | 'rush' | 'slow' | 'pistol' | 'push' | 'stack' | 'retake' | 'awp' | 'star' | 'force'
export interface Tip { kind: TipKind; text: string; refs: Ref[] }
export type RoleKind = 'awp' | 'entry' | 'lurk' | 'anchor' | 'mid' | 'support'
export interface PlayerCard {
  steamid: string; name: string; rating: number; swing: number; kills: number; deaths: number; adr: number; kast: number
  openingKills: number; openingDeaths: number
  roles: { kind: RoleKind; label: string }[]
  ctPos: [string, number][] // Callout, Anteil in %
  tPos: [string, number][]
}
export interface WL { won: number; total: number; refs: Ref[] }
export interface TGroup {
  key: string; label: string; won: number; total: number
  a: WL; b: WL; medianHit?: number; rushes: number; defaults: number
  utility: { type: string; place: string; n: number }[]
  lurkers: { name: string; n: number }[]
  rounds: TRound[]
}
export interface CTGroup {
  key: string; label: string; won: number; total: number
  setups: { setup: string; n: number; refs: Ref[] }[]
  stacks: { site: string; n: number; refs: Ref[] }[]
  pushes: { name: string; place: string; n: number; refs: Ref[] }[]
  retakes?: WL
  rounds: CTRound[]
}
export interface OpeningSide { side: Side; won: number; total: number; wonAfter: number; lostAfter: number; places: [string, number][] }
export interface TeamReport {
  team: string; map: string; matches: number; rounds: number
  results: { opponent: string; us: number; them: number }[]
  sides: Record<Side, WL>
  buys: Partial<Record<BuyType, WL>>
  tips: Tip[]
  players: PlayerCard[]
  tGroups: TGroup[]
  ctGroups: CTGroup[]
  openings: OpeningSide[]
  /** Pistolrunden im Detail (beide Seiten) */
  pistols: { t: TRound[]; ct: CTRound[] }
  names: Record<string, string>
}

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0)
export const roundClock = (sec: number) => { const l = Math.max(0, 115 - sec); return `${Math.floor(l / 60)}:${String(Math.floor(l % 60)).padStart(2, '0')}` }

function countBy<T>(arr: T[], key: (x: T) => string | undefined) {
  const m = new Map<string, number>()
  for (const x of arr) { const k = key(x); if (k) m.set(k, (m.get(k) ?? 0) + 1) }
  return [...m].sort((a, b) => b[1] - a[1])
}
const wl = <R extends { won: boolean; ref: Ref }>(rs: R[]): WL => ({ won: rs.filter(r => r.won).length, total: rs.length, refs: rs.map(r => r.ref) })

function mergeStats(list: PlayerStats[][]): PlayerStats[] {
  const by = new Map<string, PlayerStats>()
  for (const ps of list) for (const p of ps) {
    const a = by.get(p.steamid)
    if (!a) { by.set(p.steamid, { ...p, multi: [...p.multi] as PlayerStats['multi'] }); continue }
    for (const k of Object.keys(p) as (keyof PlayerStats)[]) if (typeof p[k] === 'number') (a as any)[k] += p[k]
    p.multi.forEach((v, i) => (a.multi[i] += v))
  }
  for (const p of by.values()) finishStats(p)
  return [...by.values()]
}

const GROUPS: [string, string, BuyType[]][] = [['pistol', 'Pistol', ['pistol']], ['ecoforce', 'Eco & Force', ['eco', 'force']], ['full', 'Full buy', ['full']]]

export function analyzeTeam(entries: Entry[]): TeamReport {
  const geo = buildGeo(entries.map(e => e.match))
  const nameOf = new Map<string, string>()
  for (const e of entries) for (const p of e.match.players) nameOf.set(p.steamid, p.name)
  const N = (s?: string) => (s ? nameOf.get(s) ?? '?' : 'World')
  const ourIds = new Set(entries.flatMap(e => e.match.players.filter(p => p.team === e.team).map(p => p.steamid)))

  const all = entries.flatMap(e => classifyRounds(e.match, e.team, geo))
  const tRounds = all.filter((x): x is TRound => x.kind === 'T')
  const ctRounds = all.filter((x): x is CTRound => x.kind === 'CT')
  const roundOf = (ref: Ref) => entries.find(e => e.match.id === ref.matchId)!.match.rounds[ref.round - 1]
  const stats = mergeStats(entries.map(e => computeStats(e.match).players.filter(p => p.team === e.team))).sort((a, b) => b.rating - a.rating)

  // ---------- Überblick ----------
  const results = entries.map(e => {
    const opp = e.match.teams.find(t => t !== e.team)!
    return { opponent: opp, us: e.match.finalScore[e.team], them: e.match.finalScore[opp] }
  })
  const buys: TeamReport['buys'] = {}
  for (const b of ['pistol', 'eco', 'force', 'full'] as BuyType[]) { const rs = all.filter(r => r.buy === b); if (rs.length) buys[b] = wl(rs) }

  // ---------- Spieler ----------
  const fullRounds = entries.flatMap(e => e.match.rounds.filter(r => r.buy[teamSide(r, e.team)] === 'full'))
  const tOpen = countBy(tRounds.filter(r => r.opening && (ourIds.has(r.opening.killer ?? '') || ourIds.has(r.opening.victim))), r => (ourIds.has(r.opening!.killer ?? '') ? r.opening!.killer : r.opening!.victim))
  const tWithHit = tRounds.filter(r => r.site)
  const maxUtil = Math.max(...stats.map(q => q.flashesThrown + q.smokesThrown + q.molliesThrown))
  const players: PlayerCard[] = stats.map(p => {
    const roles: PlayerCard['roles'] = []
    const awp = fullRounds.filter(r => r.tracks.find(t => t.steamid === p.steamid)?.inventory.includes('AWP')).length
    if (awp >= Math.max(2, fullRounds.length * 0.4)) roles.push({ kind: 'awp', label: `AWP ${pct(awp, fullRounds.length)}%` })
    const entry = tOpen.find(([s]) => s === p.steamid)?.[1] ?? 0
    if (entry >= Math.max(2, tRounds.length * 0.25) && tOpen[0]?.[0] === p.steamid) roles.push({ kind: 'entry', label: 'Entry' })
    const lurk = tWithHit.filter(r => r.lurkers.includes(p.steamid)).length
    if (lurk >= Math.max(2, tWithHit.length * 0.3)) roles.push({ kind: 'lurk', label: 'Lurker' })
    const ctZones = countBy(ctRounds, r => r.positions[p.steamid] && zoneOfPretty(geo, r.positions[p.steamid]))
    const ctN = ctZones.reduce((a, b) => a + b[1], 0)
    if (ctZones[0] && ctZones[0][1] >= ctN * 0.6 && (ctZones[0][0] === 'A' || ctZones[0][0] === 'B')) roles.push({ kind: 'anchor', label: `${ctZones[0][0]} anchor` })
    else if (ctZones[0]?.[0] === 'Mid' && ctZones[0][1] >= ctN * 0.5) roles.push({ kind: 'mid', label: 'Mid / rotator' })
    if (p.flashesThrown + p.smokesThrown + p.molliesThrown === maxUtil) roles.push({ kind: 'support', label: 'Support' })
    const ctPos = countBy(ctRounds, r => r.positions[p.steamid])
    const tPos = countBy(tRounds, r => {
      const rr = roundOf(r.ref); const tr = rr.tracks.find(t => t.steamid === p.steamid); if (!tr) return undefined
      const fi = Math.min(tr.x.length - 1, frameAtSec(rr, 20)); return tr.hp[fi] > 0 ? prettyPlace(rr.places[tr.place[fi]]) : undefined
    })
    const top = (l: [string, number][], n: number) => l.slice(0, 3).map(([k, c]) => [k, pct(c, n)] as [string, number])
    return {
      steamid: p.steamid, name: p.name, rating: p.rating, swing: p.swingPct, kills: p.kills, deaths: p.deaths, adr: p.adr, kast: p.kast,
      openingKills: p.openingKills, openingDeaths: p.openingDeaths, roles, ctPos: top(ctPos, ctRounds.length), tPos: top(tPos, tRounds.length),
    }
  })

  // ---------- T-Seite ----------
  const tGroups: TGroup[] = GROUPS.flatMap(([key, label, bs]) => {
    const rs = tRounds.filter(r => bs.includes(r.buy)); if (!rs.length) return []
    const hits = rs.filter(r => r.hitSec !== undefined).map(r => r.hitSec!).sort((x, y) => x - y)
    const util = countBy(rs.flatMap(r => r.utility.filter(u => r.hitSec === undefined || u.sec <= r.hitSec + 3)), u => `${u.type}|${u.place}`)
    return [{
      key, label, won: rs.filter(r => r.won).length, total: rs.length,
      a: wl(rs.filter(r => r.site === 'A')), b: wl(rs.filter(r => r.site === 'B')),
      medianHit: hits.length ? hits[Math.floor(hits.length / 2)] : undefined,
      rushes: rs.filter(r => r.style === 'rush').length, defaults: rs.filter(r => r.style === 'default').length,
      utility: util.slice(0, 6).map(([k, n]) => { const [type, place] = k.split('|'); return { type, place, n } }),
      lurkers: countBy(rs.flatMap(r => r.lurkers), s => N(s)).map(([name, n]) => ({ name, n })),
      rounds: rs,
    }]
  })

  // ---------- CT-Seite ----------
  const ctGroups: CTGroup[] = GROUPS.flatMap(([key, label, bs]) => {
    const rs = ctRounds.filter(r => bs.includes(r.buy)); if (!rs.length) return []
    const refsWhere = (f: (r: CTRound) => boolean) => rs.filter(f).map(r => r.ref)
    const retakes = rs.filter(r => r.retake)
    return [{
      key, label, won: rs.filter(r => r.won).length, total: rs.length,
      setups: countBy(rs, r => r.setup).slice(0, 4).map(([setup, n]) => ({ setup, n, refs: refsWhere(r => r.setup === setup) })),
      stacks: countBy(rs.filter(r => r.stack), r => r.stack).map(([site, n]) => ({ site, n, refs: refsWhere(r => r.stack === site) })),
      pushes: countBy(rs.flatMap(r => r.aggressive), a => `${a.steamid}|${a.place}`).slice(0, 5).map(([k, n]) => {
        const [s, place] = k.split('|')
        return { name: N(s), place, n, refs: refsWhere(r => r.aggressive.some(a => a.steamid === s && a.place === place)) }
      }),
      retakes: retakes.length ? { won: retakes.filter(r => r.retake === 'won').length, total: retakes.length, refs: retakes.map(r => r.ref) } : undefined,
      rounds: rs,
    }]
  })

  // ---------- Opening Duels ----------
  const openings: OpeningSide[] = (['T', 'CT'] as Side[]).flatMap(side => {
    const op = (side === 'T' ? tRounds : ctRounds as (TRound | CTRound)[]).filter(r => r.opening)
    if (!op.length) return []
    const w = op.filter(r => r.opening!.forUs)
    return [{ side, won: w.length, total: op.length, wonAfter: w.filter(r => r.won).length, lostAfter: op.filter(r => !r.opening!.forUs && r.won).length, places: countBy(op, r => r.opening!.place).slice(0, 4) }]
  })

  // ---------- Tipps ----------
  const tips: Tip[] = []
  const full = tRounds.filter(r => r.buy === 'full' && r.site)
  if (full.length >= 3) {
    const a = full.filter(r => r.site === 'A').length, site = a * 2 >= full.length ? 'A' : 'B', share = pct(Math.max(a, full.length - a), full.length)
    if (share >= 65) tips.push({ kind: 'site', refs: full.filter(r => r.site === site).map(r => r.ref), text: `Full buys on T: **${share}% ${site}**. Stack ${site} or get early info.` })
  }
  const rush = tRounds.filter(r => r.style === 'rush')
  if (rush.length >= Math.max(2, tRounds.length * 0.25)) tips.push({ kind: 'rush', refs: rush.map(r => r.ref), text: `Rushes often (**${rush.length}/${tRounds.length}**, ${countBy(rush, r => r.site).map(([s, c]) => `${s} ${c}×`).join(', ')}). Save molly/HE for the first push.` })
  const hits = tRounds.filter(r => r.hitSec !== undefined).map(r => r.hitSec!).sort((x, y) => x - y)
  if (hits.length >= 4 && hits[Math.floor(hits.length / 2)] > 55) tips.push({ kind: 'slow', refs: [], text: `Slow T side, hits at **${roundClock(hits[Math.floor(hits.length / 2)])}**. Take early map control and look for picks.` })
  const ADVICE: Partial<Record<TRound['style'], (r: TRound) => string>> = {
    fake: r => `Don't over-rotate on early ${r.plan.split(' ')[1]} contact, the real hit comes late on ${r.site}.`,
    rush: r => `Expect the fast ${r.site} push: utility and a crossfire on ${r.site} early.`,
    execute: r => `Utility-heavy ${r.site} hit: stay back and retake instead of dying to the execute.`,
    default: () => 'Slow default: take info early and punish lone players.',
    hit: r => `Straight ${r.site} hit without much utility: hold tight angles on ${r.site}.`,
  }
  for (const r of tRounds.filter(r => r.buy === 'pistol')) {
    const s = r.start, startTxt = [s.A && `${s.A} A`, s.Mid && `${s.Mid} mid`, s.B && `${s.B} B`].filter(Boolean).join(' · ')
    const rot = r.rotators.length ? ` ${r.rotators.map(N).join(', ')} rotate${r.rotators.length === 1 ? 's' : ''} to ${r.site}.` : ''
    tips.push({ kind: 'pistol', refs: [r.ref], text: `Pistol T: starts **${startTxt}** → **${r.plan}**${r.hitSec !== undefined ? ` at ${roundClock(r.hitSec)}` : ''}.${rot} ${ADVICE[r.style]?.(r) ?? ''}` })
  }
  for (const r of ctRounds.filter(r => r.buy === 'pistol')) {
    const push = r.aggressive.length ? ` + early push ${r.aggressive.map(a => `**${N(a.steamid)}** ${a.place}`).join(', ')}` : ''
    const advice = r.aggressive.length ? 'Clear those spots with a flash before walking out.'
      : r.stack ? `Stack on ${r.stack}: hit ${r.stack === 'A' ? 'B' : 'A'}.`
      : r.zones.Mid >= 2 ? 'Heavy mid: avoid mid fights, go straight to a site.'
      : r.zones.A === r.zones.B ? 'Even split: hit fast before they can rotate.'
      : `Spread setup: hit ${r.zones.A < r.zones.B ? 'A' : 'B'} (fewer players).`
    tips.push({ kind: 'pistol', refs: [r.ref], text: `Pistol CT: **A${r.zones.A} · Mid ${r.zones.Mid} · B${r.zones.B}**${push}. ${advice}` })
  }
  for (const [k, c] of countBy(ctRounds.flatMap(r => r.aggressive), a => `${a.steamid}|${a.place}`)) {
    if (c < Math.max(2, ctRounds.length * 0.2)) continue
    const [s, place] = k.split('|')
    tips.push({ kind: 'push', refs: ctRounds.filter(r => r.aggressive.some(a => a.steamid === s && a.place === place)).map(r => r.ref), text: `**${N(s)}** pushes **${place}** early on CT (${c}×). Pre-aim or flash it.` })
  }
  const stack = countBy(ctRounds.filter(r => r.stack), r => r.stack)
  if (stack[0] && stack[0][1] >= ctRounds.length * 0.35) tips.push({ kind: 'stack', refs: ctRounds.filter(r => r.stack === stack[0][0]).map(r => r.ref), text: `Stacks **${stack[0][0]}** on CT (${stack[0][1]}/${ctRounds.length}). Hit the other site.` })
  const retakes = ctRounds.filter(r => r.retake)
  if (retakes.length >= 3 && pct(retakes.filter(r => r.retake === 'won').length, retakes.length) <= 35) tips.push({ kind: 'retake', refs: retakes.map(r => r.ref), text: `Weak retakes (**${retakes.filter(r => r.retake === 'won').length}/${retakes.length}**). Plant fast and play post-plant.` })
  for (const p of stats) {
    const awpRounds = ctRounds.filter(r => roundOf(r.ref).tracks.find(t => t.steamid === p.steamid)?.inventory.includes('AWP'))
    if (awpRounds.length < 4) continue
    const pos = countBy(awpRounds, r => r.positions[p.steamid]).slice(0, 2)
    if (pos.length) tips.push({ kind: 'awp', refs: awpRounds.map(r => r.ref), text: `AWP **${p.name}** on CT: ${pos.map(([pl, c]) => `**${pl}** ${c}×`).join(', ')}. Smoke or flash before peeking.` })
  }
  const star = stats[0]
  if (star && star.rating >= 1.15) tips.push({ kind: 'star', refs: [], text: `Most dangerous: **${star.name}** (rating ${star.rating.toFixed(2)}). Don't take him 1v1, always play for the trade.` })
  const forces = all.filter(r => r.buy === 'force').length
  if (forces >= Math.max(3, all.length * 0.15)) tips.push({ kind: 'force', refs: [], text: `Force buys a lot (**${forces}×**). Expect a force after their lost round, don't push into SMG/shotgun range.` })

  return {
    team: entries[0].team, map: entries[0].match.map, matches: entries.length, rounds: all.length,
    results, sides: { T: wl(tRounds), CT: wl(ctRounds) }, buys, tips, players, tGroups, ctGroups, openings,
    pistols: { t: tRounds.filter(r => r.buy === 'pistol'), ct: ctRounds.filter(r => r.buy === 'pistol') },
    names: Object.fromEntries(nameOf),
  }
}

function zoneOfPretty(geo: ReturnType<typeof buildGeo>, pretty: string) {
  const m = /^([AB])-Site$/.exec(pretty); if (m) return m[1]
  const raw = pretty === 'T-Spawn' ? 'TSpawn' : pretty === 'CT-Spawn' ? 'CTSpawn' : pretty.replace(/ of /g, 'of').replace(/\s+/g, '')
  return geo.zoneOf(raw)
}
