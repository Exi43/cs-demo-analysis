// CT-Seite wie ein Anti-Strat: Opening-Konversion, Trades, Setups bei 1:40, Spots, Util-Signatur, AWP, Pushes, Rotationen, Retakes,
// Pistol / 2.-3. Runde / Forces. Ziel-Text: methodik/beispiel-dust2.md (Spike proanalyse). Test: ctside.test.ts.
import type { PlayerTrack, Round, Side } from '../model.ts'
import { buyClass } from './economy.ts'
import { buildGeo, frameAtSec, type Geo } from './geo.ts'
import { calloutName, laneSite } from './maps/index.ts'
import { targetOf, utilSignature } from './patterns.ts'
import type { Entry } from './report.ts'
import { pushEnd, type CTRound, type Ref, type TRound } from './rounds.ts'
import type { Block, BuyClass, CTSide, IconToken, Line, PushRow } from './types.ts'
import { clock, countBy, median, pct, tagOf } from './util.ts'

const BUY: Record<BuyClass, string> = { pistol: 'Pistol', second: '2nd round', eco: 'Eco', deagle: 'Deagle', smg: 'SMG', light: 'Light buy', full: 'Full buy' }
const NADE: Record<string, IconToken> = { smoke: 'smoke', molotov: 'molly', he: 'he', flash: 'flash' }
const FORWARD_AHEAD = 300 // u naeher am T-Spawn als der uebliche CT-Halt des Laufwegs = forward (Dust2 Catwalk 405, Pit 652)
const secOf = (r: Round, tick: number) => (tick - r.freezeEndTick) / 64
const keyOf = (x: { matchId: string; round: number }) => `${x.matchId}:${x.round}`
const span = (secs: number[]) => { const a = clock(Math.min(...secs)), b = clock(Math.max(...secs)); return a === b ? a : `${a}–${b}` }
const ctsOf = (r: Round) => r.tracks.filter(t => t.side === 'CT')

/** Opening-Konversion einer Seite des Teams (erster Kill mit Taeter wie rounds.ts). Key-Kandidat (tag + stat) bei <= 15 % nach verlorenem Opening, n >= 5 */
export function openingLine(entries: Entry[], side: Side): Line | undefined {
  const win: { ref: Ref; won: boolean }[] = [], loss: typeof win = []
  for (const { match: m, team } of entries) for (const r of m.rounds) {
    const k = r.kills.find(k => k.attacker)
    if (r.teamOnSide[side] !== team || !k) continue
    const forUs = r.tracks.find(t => t.steamid === k.victim)?.side !== side
    ;(forUs ? win : loss).push({ ref: { matchId: m.id, round: r.num, tick: k.tick }, won: r.winner === side })
  }
  if (!win.length && !loss.length) return undefined
  const a = win.filter(x => x.won).length, b = loss.filter(x => x.won).length, key = loss.length >= 5 && b <= 0.15 * loss.length
  return {
    icon: 'target', text: `Opening duel won ${win.length}/${win.length + loss.length} → round won ${a}/${win.length}. Opening lost → **${b}/${loss.length}**`,
    refs: loss.map(x => x.ref),
    ...(key && { tag: tagOf(loss.length - b, loss.length), stat: { won: b, total: loss.length }, counter: `Win the first duel on their ${side}: after losing it they won ${b}/${loss.length}.` }),
  }
}

/** Trade-Disziplin: Anteil der Tode, die das Team in 5 s raecht (Parser-Flag traded), ohne Welt-Tode; wir = Gegner in der Demo */
export function tradeLine(entries: Entry[]): Line | undefined {
  let tn = 0, tt = 0, un = 0, ut = 0
  for (const { match: m, team } of entries) for (const r of m.rounds) for (const k of r.kills) {
    const side = r.tracks.find(t => t.steamid === k.victim)?.side
    if (!k.attacker || !side) continue
    if (r.teamOnSide[side] === team) { tn++; if (k.traded) tt++ } else { un++; if (k.traded) ut++ }
  }
  if (!tn) return undefined
  return {
    icon: 'target', text: `They trade **${pct(tt, tn)} %** of their deaths [${tt}/${tn}] · we trade ${pct(ut, un)} % [${ut}/${un}]`, refs: [],
    counter: pct(tt, tn) < pct(ut, un) ? `Take the 1v1s: they trade only ${pct(tt, tn)} % of their deaths.` : undefined,
  }
}

/** tRoundsOfOpponent = T-Analyse derselben Runden (Hit, Plant, Retake); geo wie in buildAntiStrat, sonst neu gebaut (~8 ms je Demo) */
export function ctReport(entries: Entry[], rounds: CTRound[], tRoundsOfOpponent: TRound[], geo?: Geo): CTSide {
  const empty: CTSide = { overview: [], utilSignature: [], setups: [], spots: [], awp: [], pushes: [], rotations: [], retakes: [], pistol: [], forces: [] }
  if (!rounds.length) return empty
  const g = geo ?? buildGeo(entries.map(e => e.match))
  const matches = new Map(entries.map(e => [e.match.id, e.match]))
  const names: Record<string, string> = {}
  for (const m of matches.values()) for (const p of m.players) names[p.steamid] = p.name
  const name = (id: string) => names[id] ?? '?'
  const N = rounds.length
  const mr = (c: { matchId: string; round: number }) => { const m = matches.get(c.matchId)!; return { m, r: m.rounds.find(r => r.num === c.round)! } }
  const opp = new Map(tRoundsOfOpponent.map(t => [keyOf(t), t]))
  const rawAt = (r: Round, t: PlayerTrack, f: number) => r.places[t.place[f]] || g.nearestPlace(t.x[f], t.y[f])
  const track = (r: Round, id: string) => r.tracks.find(t => t.steamid === id)
  const laneOfThrow = (u: { thrower: string; sec: number }, ref: Ref) => {
    const { r } = mr(ref), t = track(r, u.thrower)
    return t ? g.lane(rawAt(r, t, frameAtSec(r, Math.max(0, u.sec)))) : ''
  }
  const refsOf = (cs: CTRound[]) => cs.map(c => c.ref)
  const wonOf = (cs: CTRound[]) => ({ won: cs.filter(c => c.won).length, total: cs.length })
  const buy = new Map(rounds.map(c => { const { m, r } = mr(c); return [keyOf(c), buyClass(m, r, 'CT')] }))
  const buyOf = (c: CTRound) => buy.get(keyOf(c))!

  // ---------- Util-Signatur ----------
  const util = utilSignature(rounds, 'CT', name, (u, ref) => laneOfThrow(u, ref))

  // ---------- Setups bei 1:40 (15 s): Spieler je Bereich A / Mid / B (CT-Spawn zaehlt zu Mid) ----------
  const area = rounds.map(c => {
    const { r } = mr(c), f = frameAtSec(r, 15), a = { A: 0, Mid: 0, B: 0 }
    for (const t of ctsOf(r)) if (t.hp[f] > 0) { const s = laneSite(g.lane(rawAt(r, t, f))); a[s === 'A' || s === 'B' ? s : 'Mid']++ }
    return a
  })
  const setups: Line[] = []
  for (const s of ['A', 'B'] as const) {
    const xs = area.map(a => a[s])
    let lo = 0, n = 0
    for (let l = 0; l <= 4; l++) { const k = xs.filter(x => x === l || x === l + 1).length; if (k > n) { n = k; lo = l } }
    const ins = rounds.filter((_, i) => xs[i] === lo || xs[i] === lo + 1)
    if (n * 2 < N) continue
    const a = Math.min(...ins.map(c => xs[rounds.indexOf(c)])), b = Math.max(...ins.map(c => xs[rounds.indexOf(c)]))
    setups.push({ icon: 'layers', text: `At 1:40 **${a === b ? a : `${a}–${b}`} on ${s}**`, tag: tagOf(n, N), refs: refsOf(ins) })
    const stack = rounds.filter((_, i) => xs[i] > b)
    if (stack.length) setups.push({ icon: 'layers', text: `Stack **${s}** (${b + 1}+ at 1:40)`, tag: tagOf(stack.length, N), refs: refsOf(stack), stat: wonOf(stack) })
  }
  const sig = (i: number) => `A${area[i].A} M${area[i].Mid} B${area[i].B}`
  for (const [cls, k] of countBy(rounds, buyOf).slice(0, 3)) {
    if (k < 2) continue
    const rs = rounds.filter(c => buyOf(c) === cls), top = countBy(rs, c => sig(rounds.indexOf(c))).slice(0, 3)
    setups.push({ icon: 'layers', text: `**${BUY[cls as BuyClass]}**: ${top.map(([s, n]) => (n > 1 ? `**${s}** ×${n}` : s)).join(' · ')}`, tag: tagOf(top[0][1], rs.length), refs: refsOf(rs) })
  }

  // ---------- Spots: haeufigster Callout je Spieler bei 1:40 (pos15 wie Roster, nicht 10 s: Durchlaufen ist kein Halten) in >= 50 % der Runden ----------
  const at = new Map<string, Map<string, CTRound[]>>() // Spieler → Callout → Runden
  for (const c of rounds) for (const [id, p] of Object.entries(c.pos15)) {
    const pm = at.get(id) ?? new Map<string, CTRound[]>()
    if (p) pm.set(p, [...(pm.get(p) ?? []), c])
    at.set(id, pm)
  }
  const spots: Line[] = [], fixed = new Set<string>()
  for (const [id, pm] of at) {
    const [place, rs] = [...pm].sort((a, b) => b[1].length - a[1].length)[0] ?? []
    if (!rs || rs.length * 2 < N) continue
    fixed.add(id)
    spots.push({ text: `**${name(id)}** holds **${place}** (1:40)`, tag: tagOf(rs.length, N), refs: refsOf(rs) })
  }
  // Site-Spieler = Laufweg "<Site> site" bei 1:40; ohne Spieler >= 50 % → "No fixed" mit Zaehlung
  for (const s of ['A', 'B'] as const) {
    const per = rounds.map(c => { const { r } = mr(c), f = frameAtSec(r, 15); return ctsOf(r).filter(t => t.hp[f] > 0 && g.lane(rawAt(r, t, f)) === `${s} site`).map(t => t.steamid) })
    const held = rounds.filter((_, i) => per[i].length), cnt = countBy(per.flat(), id => id)
    if (held.length * 2 < N || !cnt.length) continue
    const [id, n] = cnt[0]
    if (n * 2 >= N) { if (!fixed.has(id)) spots.push({ text: `**${name(id)}** anchors **${s}**`, tag: tagOf(n, N), refs: refsOf(rounds.filter((_, i) => per[i].includes(id))) }) }
    else spots.push({ text: `No fixed **${s}** player: ${cnt.map(([p, k]) => `${name(p)} ${k}×`).join(', ')}`, refs: refsOf(held),
      counter: util.length ? 'Read them from their utility instead.' : undefined })
  }

  // ---------- AWP ----------
  const awp: Line[] = [], awpR = rounds.filter(c => c.awpSpot.length)
  if (awpR.length) {
    awp.push({ icon: 'awp', text: `AWP in **${awpR.length}/${N}** rounds: ${countBy(awpR, c => BUY[buyOf(c)]).map(([b, n]) => `${b} ${n}`).join(' · ')}`, tag: tagOf(awpR.length, N), refs: refsOf(awpR) })
    const uses = awpR.flatMap(c => c.awpSpot.map(a => ({ c, ...a })))
    for (const [place, n] of countBy(uses, u => u.place).slice(0, 3)) {
      if (n < 2 && awp.length > 1) break // einzelne AWP-Spots nur, wenn es sonst keinen gibt
      const us = uses.filter(u => u.place === place), rs = [...new Set(us.map(u => u.c))]
      const kills = us.reduce((n, u) => n + mr(u.c).r.kills.filter(k => k.attacker === u.id && k.weapon === 'awp').length, 0)
      awp.push({ icon: 'awp', text: `**${place}**: ${countBy(us, u => name(u.id)).map(([p, n]) => (n > 1 ? `${p} ×${n}` : p)).join(', ')} · ${kills} kill${kills === 1 ? '' : 's'}`, tag: tagOf(rs.length, awpR.length), refs: refsOf(rs) })
    }
  }

  // ---------- Pushes: rounds.ts aggression (push / forward ueber Besitzkarte) + forward vor dem ueblichen CT-Halt des Laufwegs ----------
  // Ueblicher Halt = haeufigster CT-Place bei 15 s je Laufweg (alle CT-Runden aller Demos); Catwalk/Pit liegen auf Dust2 davor, haben aber T-Anteil < 0,4
  const hold = new Map<string, Map<string, number>>()
  for (const m of matches.values()) for (const r of m.rounds) {
    const f = frameAtSec(r, 15)
    for (const t of ctsOf(r)) if (t.hp[f] > 0) { const p = rawAt(r, t, f), l = g.lane(p), h = hold.get(l) ?? new Map<string, number>(); h.set(p, (h.get(p) ?? 0) + 1); hold.set(l, h) }
  }
  const home = new Map([...hold].map(([l, h]) => { const [p, n] = [...h].sort((a, b) => b[1] - a[1])[0]; return [l, n >= 2 ? p : ''] }))
  const dT = (p: string) => { const c = g.place.get(p); return c ? Math.hypot(c.x - g.tSpawn[0], c.y - g.tSpawn[1]) : Infinity }
  const ahead = (p: string, l: string) => {
    const s = laneSite(l), h = home.get(l)
    return (s === 'A' || s === 'B' || s === 'Mid') && !l.endsWith(' site') && !!h && p !== h && dT(p) < dT(h) - FORWARD_AHEAD
  }
  type Agg = { c: CTRound; id: string; place: string; lane: string; sec: number; level: 'push' | 'forward'; kills: number; died: boolean }
  const aggs: Agg[] = []
  for (const c of rounds) {
    const { m, r } = mr(c)
    for (const a of c.aggression) { const t = track(r, a.id); aggs.push({ c, ...a, lane: t ? g.lane(rawAt(r, t, frameAtSec(r, a.sec))) : a.place }) }
    for (const t of ctsOf(r)) {
      if (c.aggression.some(a => a.id === t.steamid)) continue
      for (let s = 2; s <= 25; s++) {
        const f = frameAtSec(r, s); if (t.hp[f] <= 0) break
        const p = rawAt(r, t, f), l = g.lane(p)
        if (!ahead(p, l)) continue
        const end = pushEnd(r, t, s, f => { const q = rawAt(r, t, f); return g.lane(q) === l && ahead(q, l) })
        const ks = r.kills.filter(k => secOf(r, k.tick) <= end)
        aggs.push({ c, id: t.steamid, place: calloutName(m.map, p), lane: l, sec: s, level: 'forward', kills: ks.filter(k => k.attacker === t.steamid).length, died: ks.some(k => k.victim === t.steamid) })
        break
      }
    }
  }
  const pushR = rounds.filter(c => aggs.some(a => a.c === c))
  const pushes: PushRow[] = countBy(aggs, a => `${a.level}|${a.lane}`).map(([k]) => {
    const as = aggs.filter(a => `${a.level}|${a.lane}` === k)
    return { level: as[0].level, place: countBy(as, a => a.place).slice(0, 2).map(([p]) => p).join(' / '), players: countBy(as, a => name(a.id)).map(([p]) => p),
      refs: refsOf([...new Set(as.map(a => a.c))]), kills: as.reduce((n, a) => n + a.kills, 0), deaths: as.filter(a => a.died).length }
  }).sort((a, b) => b.refs.length - a.refs.length).slice(0, 6)

  // ---------- Overview: Opening, Trades, Push-Quote ----------
  const overview = [openingLine(entries, 'CT'), tradeLine(entries)].filter((l): l is Line => !!l)
  if (pushR.length) overview.push({
    icon: 'arrow', text: `Early push or forward in **${pushR.length}/${N}** rounds`, tag: tagOf(pushR.length, N), refs: refsOf(pushR), stat: wonOf(pushR),
    counter: `Expect early contact on ${countBy(aggs, a => a.place).slice(0, 2).map(([p]) => `**${p}**`).join(' and ')} (${span(aggs.map(a => a.sec))}). Util first, then trade the pusher.`,
  })

  // ---------- Rotationen (nur Runden mit Hit) ----------
  const rotations: Line[] = []
  const hitR = rounds.filter(c => { const t = opp.get(keyOf(c)); return !!t?.site && t.hitSec !== undefined })
  const rotR = hitR.filter(c => c.rotations.length)
  if (rotR.length) {
    const first = rotR.map(c => ({ c, ...[...c.rotations].sort((a, b) => a.startSec - b.startSec)[0] }))
    const [id, n] = countBy(first, x => x.id)[0], med = Math.round(median(first.map(x => x.vsHit))!)
    rotations.push({ icon: 'shuffle', text: `Rotate on the hit · first: **${name(id)}** ${n}× · starts ${med ? `${Math.abs(med)} s ${med < 0 ? 'before' : 'after'} the hit` : 'at the hit'} (median)`,
      tag: tagOf(rotR.length, hitR.length), refs: refsOf(rotR) })
    const early = hitR.filter(c => c.rotations.some(x => x.vsHit < -10))
    if (early.length) rotations.push({ icon: 'shuffle', text: 'Early rotation (> 10 s before the hit)', tag: tagOf(early.length, hitR.length), refs: refsOf(early),
      counter: 'Show one site, then hit the other: they leave early.' })
  }

  // ---------- Retakes: nur echte Versuche (Saves und "kein CT lebt" getrennt) ----------
  const retakes: Line[] = []
  const planted = rounds.map(c => ({ c, p: opp.get(keyOf(c))?.plantInfo })).filter((x): x is { c: CTRound; p: NonNullable<TRound['plantInfo']> } => !!x.p)
  const tries = planted.filter(x => x.p.retake !== 'save' && x.p.retake !== 'no-ct'), wins = tries.filter(x => x.p.retake.startsWith('won'))
  if (tries.length) {
    const site = (s: 'A' | 'B') => { const t = tries.filter(x => x.p.site === s); return t.length ? `${s} ${t.filter(x => wins.includes(x)).length}/${t.length}` : '' }
    // Tag = verlorene Versuche (Schwaeche), bei >= 50 % gewonnen die gewonnenen
    retakes.push({ icon: 'kit', text: `Retakes **${wins.length}/${tries.length}** (${[site('A'), site('B')].filter(Boolean).join(', ')})`,
      tag: tagOf(wins.length * 2 >= tries.length ? wins.length : tries.length - wins.length, tries.length),
      refs: refsOf(tries.map(x => x.c)), stat: { won: wins.length, total: tries.length },
      counter: wins.length * 2 < tries.length ? 'Plant and play post-plant: they lose most retakes.' : undefined })
    // gestaffelt: >= 2 CT-Tode nach dem Plant, alle >= 3 s auseinander
    const gaps = tries.filter(x => !wins.includes(x)).map(x => {
      const { r } = mr(x.c), pt = r.plant!.tick
      const ds = r.kills.filter(k => k.tick >= pt && track(r, k.victim)?.side === 'CT').map(k => secOf(r, k.tick)).sort((a, b) => a - b)
      return { x, gaps: ds.slice(1).map((d, i) => d - ds[i]) }
    }).filter(y => y.gaps.length && Math.min(...y.gaps) >= 3)
    if (gaps.length) {
      const all = gaps.flatMap(y => y.gaps)
      retakes.push({ icon: 'kit', text: `Retakers come one at a time: deaths ${Math.round(Math.min(...all))}–${Math.round(Math.max(...all))} s apart`, tag: tagOf(gaps.length, tries.length),
        refs: refsOf(gaps.map(y => y.x.c)), counter: 'Hold the post-plant crossfire: they arrive one by one.' })
    }
    // Retake-Held: Entschaerfer, sonst CT mit den meisten Kills nach dem Plant
    const hero = wins.map(x => {
      const { r } = mr(x.c), pt = r.plant!.tick
      return { x, id: r.defuse?.player ?? countBy(r.kills.filter(k => k.tick > pt && k.attacker && track(r, k.attacker)?.side === 'CT'), k => k.attacker)[0]?.[0] }
    })
    const [hid, hn] = countBy(hero, h => h.id)[0] ?? []
    if (hid) retakes.push({ icon: 'kit', text: `Retake wins: **${name(hid)}** ${hn}/${wins.length}`, tag: tagOf(hn, wins.length), refs: refsOf(hero.filter(h => h.id === hid).map(h => h.x.c)),
      counter: `Find **${name(hid)}** before the defuse.` })
  }
  const lost = planted.filter(x => !tries.includes(x))
  const sv = lost.filter(x => x.p.retake === 'save').length, none = lost.length - sv
  if (lost.length) retakes.push({ icon: 'kit', text: `No retake: ${[sv && `saved ${sv}`, none && `no CT alive ${none}`].filter(Boolean).join(' · ')}`, refs: refsOf(lost.map(x => x.c)) })

  // ---------- Bloecke: Pistol, 2./3. Runde, Forces (Buy-Klasse aus P2) ----------
  const aggOf = (c: CTRound) => aggs.filter(a => a.c === c)
  const roundLine = (c: CTRound, pistol = false): Line => {
    const as = aggOf(c), us = c.util.filter(u => u.sec <= 15).slice(0, 2), o = c.opening
    const parts = [`**${BUY[buyOf(c)]}**`, sig(rounds.indexOf(c)),
      ...countBy(as, a => a.place).slice(0, 2).map(([p]) => { const x = as.filter(a => a.place === p); return `:arrow: ${p} (${x.map(a => name(a.id)).join(' + ')}) ${span(x.map(a => a.sec))}` }),
      ...c.awpSpot.map(a => `:awp: ${a.place}`),
      ...us.map(u => `:${NADE[u.type]}: ${targetOf(u)} ${clock(u.sec)}`),
      o ? `first duel ${o.forUs ? ':check:' : ':x:'} ${o.place}` : '']
    const counter = !pistol ? undefined : as[0] ? `Expect the ${as[0].place} push at ${clock(as[0].sec)}.` : us[0] ? `Expect :${NADE[us[0].type]}: ${targetOf(us[0])} at ${clock(us[0].sec)}.` : undefined
    return { icon: c.won ? 'check' : 'x', text: parts.filter(Boolean).join(' · '), refs: [c.ref], counter }
  }
  const pistol: Block[] = rounds.filter(c => buyOf(c) === 'pistol').map(c => ({ title: `Pistol CT ${c.won ? ':check:' : ':x:'}`, lines: [roundLine(c, true)], refs: [c.ref] }))
  const after = (c: CTRound) => { const { m } = mr(c), i = m.rounds.findIndex(r => r.num === c.round); return i > 0 && buy.get(keyOf({ matchId: m.id, round: m.rounds[i - 1].num })) === 'second' }
  const opens = rounds.filter(c => buyOf(c) === 'second' || after(c))
  const second: Block | undefined = opens.length ? { title: `2nd / 3rd round CT · ${wonOf(opens).won}/${opens.length}`, lines: opens.map(c => roundLine(c)), refs: refsOf(opens) } : undefined
  const forces: Block[] = (['deagle', 'smg'] as const).map(cls => rounds.filter(c => buyOf(c) === cls && !opens.includes(c))).filter(rs => rs.length)
    .map(rs => ({ title: `${BUY[buyOf(rs[0])]} forces · ${wonOf(rs).won}/${rs.length}`, lines: rs.map(c => roundLine(c)), refs: refsOf(rs) }))

  return { overview, utilSignature: util, setups, spots, awp, pushes, rotations, retakes, pistol, second, forces }
}
