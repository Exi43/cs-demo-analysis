// T-Playbook wie ein Stratbook: Spielzuege (Cluster ueber Runden), Rolle pro Spieler, Reads, Care, Konter, Timing-Heatmap, Pistol/2. Runde/Force.
// Cluster-Regel aus Spike proanalyse/erkennung (proto.ts clusterPlays, gemessen 73 % / 82 %), Texte nach methodik/gliederung-textbausteine.json.
import type { MatchData, Round } from '../model.ts'
import { buyClass } from './economy.ts'
import { frameAtSec } from './geo.ts'
import { calloutName, laneSite } from './maps/index.ts'
import type { Entry } from './report.ts'
import type { TRound } from './rounds.ts'
import type { Block, BuyClass, Heatmap, IconToken, Line, Play, PlayKind, TSide, Util } from './types.ts'
import { clock, countBy, median, tagOf } from './util.ts'

const ICON: Record<Util['type'], IconToken> = { smoke: 'smoke', flash: 'flash', molotov: 'molly', he: 'he' }
const PRI: Record<Util['type'], number> = { smoke: 0, molotov: 1, flash: 2, he: 3 }
const BUY: Record<BuyClass, string> = { pistol: 'pistol', second: '2nd', eco: 'eco', deagle: 'Deagle', smg: 'SMG', light: 'light', full: 'full' }
const KINDS: PlayKind[] = ['default', 'fake', 'rush', 'execute', 'split', 'hit']
/** Route-Stuetzpunkte (s): 5/10/15/20, dann alle 10 s bis Hit +5 s (max. 90), ohne Hit bis 30 s; spaete Hits (Mirage R1 0:59) brauchen den Weg bis zur Site */
function stops(x: TRound): number[] {
  const end = x.hitSec === undefined ? 30 : Math.min(x.hitSec + 5, 90), out = [5, 10, 15, 20].filter(s => s <= end)
  for (let s = 30; s <= end; s += 10) out.push(s)
  if (out.length && end > out[out.length - 1]) out.push(end)
  return out
}

/** Lineup-Name ohne Typ-Wort ("XBox smoke" → "XBox"); ? = Name nur aus dem Landeort */
const spot = (u: Util) => (u.name.replace(/(^| )(smoke|molly|flash|HE)\b/, '').trim() || u.to || 'unknown') + (u.named ? '' : '?')
const nade = (u: Util) => `:${ICON[u.type]}: ${spot(u)}`
const uk = (u: Util) => `${u.type}|${spot(u)}`
/** Uhr-Spanne, frueheste Uhr zuerst (1:52–1:40) */
const span = (secs: number[]) => { const s = [...secs].sort((a, b) => a - b), a = clock(s[0]), b = clock(s[s.length - 1]); return a === b ? a : `${a}–${b}` }
const mode = <T>(xs: T[], key: (x: T) => string | undefined) => countBy(xs, key)[0]
const jac = (a: string[], b: string[]) => { const A = new Set(a), B = new Set(b); let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i || 1) }
const sideTag = (r: TRound) => r.site ?? /\((A|B) side\)/.exec(r.tags[r.tags.length - 1] ?? '')?.[1]
/** Haupt-Lane eines Hits: haeufigste Eintritts-Lane bis Hit +12 s */
const entryLane = (r: TRound) => mode(r.entries.filter(e => e.sec <= (r.hitSec ?? 0) + 12 && e.lane !== '?'), e => e.lane)?.[0]
const laneTo = (lane: string, site: string) => (laneSite(lane) === site ? lane : `${lane} → ${site}`)

/** Single-Link-Cluster (Union-Find): gleiche Site und Signatur-Jaccard >= 0,3; Average-Link war an den Demos nicht besser */
export function clusterRounds(rs: TRound[], thr = 0.3): TRound[][] {
  const parent = rs.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++)
    if (rs[i].site === rs[j].site && jac(rs[i].sig, rs[j].sig) >= thr) parent[find(i)] = find(j)
  const groups = new Map<number, TRound[]>()
  rs.forEach((r, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), r]))
  return [...groups.values()]
}

/** 15-s-Spalten der Hit-Uhr: Index k = Restzeit in [15k, 15k+15) */
const bucketOf = (sec: number) => Math.floor(Math.max(0, 115 - sec) / 15)
const bucketLabel = (k: number) => `${clock(115 - 15 * (k + 1))}–${clock(115 - 15 * k)}`

export function tPlaybook(entries: Entry[], rounds: TRound[]): TSide {
  const at = new Map<string, { m: MatchData; r: Round }>()
  for (const { match: m } of entries) for (const r of m.rounds) at.set(`${m.id}:${r.num}`, { m, r })
  const ctx = (x: TRound) => at.get(`${x.matchId}:${x.round}`)!
  const names = new Map(entries.flatMap(e => e.match.players.map(p => [p.steamid, p.name] as const)))
  const B = (id: string) => `**${names.get(id) ?? '?'}**`
  const demo = entries.map(e => e.match.id)
  const rn = (x: TRound) => (demo.length > 1 ? `D${demo.indexOf(x.matchId) + 1}·R${x.round}` : `R${x.round}`)
  const marks = (xs: TRound[], all: TRound[]) => (all.length > 1 && xs.length < all.length ? ` (${[...new Set(xs)].map(rn).join(' ')})` : '')
  const buy = (x: TRound) => { const { m, r } = ctx(x); return buyClass(m, r, 'T') }
  const NT = rounds.length
  const wl = (xs: TRound[]) => ({ won: xs.filter(x => x.won).length, total: xs.length })
  const plantTxt = (x: TRound) => (x.plantInfo ? ` · :c4: ${x.plantInfo.site ?? '?'} ${clock(x.plantInfo.sec)}` : '')
  /** bis Hit +3 s geworfen (ohne Hit: alles) */
  const preHit = (x: TRound) => x.util.filter(u => u.sec >= -1 && (x.hitSec === undefined || u.sec <= x.hitSec + 3))

  /** Rollen-Zeile eines Spielers ueber Runden: Granaten (gleicher Name zusammengefasst) → Route → Ende (Plant, Tod, Kills) */
  function role(id: string, xs: TRound[]): Line | undefined {
    const parts: string[] = []
    const nades = xs.flatMap(x => preHit(x).filter(u => u.thrower === id).map(u => ({ x, u })))
    const groups = new Map<string, typeof nades>()
    for (const n of nades) { const k = uk(n.u); groups.set(k, [...(groups.get(k) ?? []), n]) }
    // max. 4 Gruppen: Smokes/Mollys vor Flashes/HE, dann nach Uhr
    const gs = [...groups.values()].sort((a, b) => PRI[a[0].u.type] - PRI[b[0].u.type] || b.length - a.length).slice(0, 4).sort((a, b) => a[0].u.sec - b[0].u.sec)
    for (const g of gs) {
      const from = PRI[g[0].u.type] < 2 ? mode(g, n => n.u.from)?.[0] : undefined
      parts.push(`${nade(g[0].u)} ${[...new Set(g.map(n => clock(n.u.sec)))].join(' / ')}${from && from !== spot(g[0].u) ? ` from ${from}` : ''}${marks(g.map(n => n.x), xs)}`)
    }
    // Route: Callouts an den Stuetzpunkten ohne Duplikate, haeufigste ueber die Runden
    const route = mode(xs, x => {
      const { m, r } = ctx(x), t = r.tracks.find(t => t.steamid === id)
      if (!t) return undefined
      const cs: string[] = []
      for (const s of stops(x)) { const f = frameAtSec(r, s); if (t.hp[f] <= 0) break; const c = calloutName(m.map, r.places[t.place[f]] ?? ''); if (c && !cs.includes(c)) cs.push(c) }
      return cs.join(' → ')
    })?.[0]
    const end: string[] = []
    const plants = xs.filter(x => x.plantInfo?.player === id)
    if (plants.length) end.push(`:c4: ${[...new Set(plants.map(x => x.plantInfo!.site ?? '?'))].join('/')}${marks(plants, xs)}`)
    const deaths = xs.flatMap(x => { const { m, r } = ctx(x), k = r.kills.find(k => k.victim === id); return k ? [{ x, place: calloutName(m.map, k.victimPlace), sec: (k.tick - r.freezeEndTick) / 64 }] : [] })
    for (const [place] of countBy(deaths, d => d.place || '?').slice(0, 2)) {
      const ds = deaths.filter(d => (d.place || '?') === place)
      end.push(`:x: ${place} ${span(ds.map(d => d.sec))}${marks(ds.map(d => d.x), xs)}`)
    }
    const kills = xs.reduce((a, x) => a + ctx(x).r.kills.filter(k => k.attacker === id && k.victim !== id).length, 0)
    if (kills) end.push(`${kills} kill${kills > 1 ? 's' : ''}`)
    const text = [parts.join(' · '), route, end.join(' · ')].filter(Boolean).join(' → ')
    return text ? { text: `${B(id)} ${text}`, refs: xs.map(x => x.ref) } : undefined
  }
  const roles = (xs: TRound[]) => {
    const ids = [...new Set(xs.flatMap(x => ctx(x).r.tracks.filter(t => t.side === 'T').map(t => t.steamid)))]
    const nadeN = (id: string) => xs.reduce((a, x) => a + preHit(x).filter(u => u.thrower === id).length, 0)
    return ids.sort((a, b) => nadeN(b) - nadeN(a)).map(id => role(id, xs)).filter((l): l is Line => !!l)
  }

  // ---------- Reads: Util der ersten 15 s (gleicher Typ, Landeort < 350 u, Uhr ± 3 s) → Site/Lane danach, ab 3 Faellen und >= 75 % gleicher Folge ----------
  // Landeort statt Name: derselbe T-Spawn-Smoke heisst im Katalog je nach Landepunkt "XBox" oder "Mid Doors" (Dust2 R14/R18/R20)
  const ind: { x: TRound; u: Util }[][] = []
  for (const x of rounds) for (const u of x.util) {
    if (u.sec < -1 || u.sec > 15) continue
    const g = ind.find(g => g[0].u.type === u.type && Math.abs(g[0].u.sec - u.sec) <= 3 && Math.hypot(g[0].u.land[0] - u.land[0], g[0].u.land[1] - u.land[1]) < 350)
    if (!g) ind.push([{ x, u }]); else if (!g.some(n => n.x === x)) g.push({ x, u })
  }
  // Folge: Lane des ersten Eintritts bzw. ohne Hit die volle Lane der Seite bei 20 s
  const outcome = (x: TRound) => {
    const site = sideTag(x)
    const lane = x.site ? x.entries.find(e => e.lane !== '?')?.lane : Object.entries(x.lanes20).filter(([l]) => laneSite(l) === site).sort((a, b) => b[1].length - a[1].length)[0]?.[0]
    return { site, lane }
  }
  const reads: { l: Line; xs: TRound[]; site: string }[] = []
  for (const keep of ind) {
    if (keep.length < 3) continue
    const med = median(keep.map(n => n.u.sec))!, xs = keep.map(n => n.x), out = xs.map(outcome)
    const cue = `:${ICON[keep[0].u.type]}: ${countBy(keep, n => spot(n.u)).slice(0, 2).map(([s]) => s).join(' / ')}`
    const lane = mode(out, o => o.lane), site = mode(out, o => o.site)
    const [what, n] = lane && lane[1] / xs.length >= 0.75 ? lane : site && site[1] / xs.length >= 0.75 ? site : []
    if (!what) continue
    const s = laneSite(what) === 'A' || laneSite(what) === 'B' ? laneSite(what) : what
    reads.push({ xs: xs.filter((_, i) => out[i].lane === what || out[i].site === what), site: s, l: {
      icon: 'target', text: `${cue} at ~${clock(med)} means **${what}**`, tag: tagOf(n as number, xs.length), refs: xs.map(x => x.ref), stat: wl(xs),
      counter: `${cue} by ${clock(med)} → rotate 1 to ${s} early.`,
    } })
  }
  // gleiche Runden + gleiche Folge = ein Read (der mit mehr Faellen)
  reads.sort((a, b) => b.l.tag!.n - a.l.tag!.n || a.l.text.localeCompare(b.l.text))
  const uniq = reads.filter((r, i) => !reads.slice(0, i).some(o => o.site === r.site && r.xs.every(x => o.xs.includes(x))))

  // ---------- Spielzuege ----------
  const hits = rounds.filter(x => x.site && x.buy !== 'eco')
  const clusters = clusterRounds(hits).filter(c => c.length >= 2)
    .sort((a, b) => b.length - a.length || Math.min(...a.map(x => x.ref.tick)) - Math.min(...b.map(x => x.ref.tick)))
  const plays: Play[] = clusters.map((xs, i) => {
    const site = xs[0].site!, lane = mode(xs, entryLane)?.[0]
    // Schluessel-Util: Smoke/Molly bis Hit +3 s in >= 60 % der Runden, die haeufigste (bei Gleichstand die fruehste)
    const util = xs.flatMap(x => [...new Map(preHit(x).filter(u => PRI[u.type] < 2).map(u => [uk(u), u])).values()])
    const when = (k: string) => median(util.filter(u => uk(u) === k).map(u => u.sec))!
    const key = countBy(util, uk).filter(([, n]) => n >= Math.max(2, Math.ceil(xs.length * 0.6))).sort((a, b) => b[1] - a[1] || when(a[0]) - when(b[0]))[0]
    const keyU = key && util.find(u => uk(u) === key[0])
    const name = [keyU && `${keyU.name}${keyU.named ? '' : '?'}`, lane ? laneTo(lane, site) : site].filter(Boolean).join(' → ')
    const kinds = KINDS.filter(k => xs.filter(x => x.tags.some(t => t === k || t.startsWith(`${k} `))).length * 2 >= xs.length)
    const hitSecs = xs.map(x => x.hitSec!), id = `T${i + 1}`

    // Timeline: erste Util → erster Kontakt → Hit → Plant
    const first = mode(xs, x => { const u = preHit(x)[0]; return u && uk(u) })
    const firstU = first && xs.flatMap(x => preHit(x).slice(0, 1)).filter(u => uk(u) === first[0])
    const fc = mode(xs, x => x.firstContact?.place), fcs = xs.filter(x => fc && x.firstContact?.place === fc[0])
    const pl = xs.filter(x => x.plantInfo)
    const timeline: Line = { icon: 'clock', refs: xs.map(x => x.ref), text: [
      firstU?.length && `${nade(firstU[0])} ${span(firstU.map(u => u.sec))}`,
      fc && `contact ${fc[0]} ${span(fcs.map(x => x.firstContact!.sec))}`,
      `hit ${span(hitSecs)}`, pl.length && `:c4: ${span(pl.map(x => x.plantInfo!.sec))}`,
    ].filter(Boolean).join(' → ') }

    // Care: Lurker oder zweite Lane zur gleichen Zeit, >= 2x
    const lurk = countBy(xs.flatMap(x => x.lurkersPro), id => id)[0]
    const second = countBy(xs.flatMap(x => [...new Set(x.entries.filter(e => e.sec <= x.hitSec! + 12 && e.lane !== '?' && e.lane !== lane).map(e => e.lane))]), l => l)[0]
    let care: Line | undefined
    if (lurk && lurk[1] >= 2) {
      const ls = xs.filter(x => x.lurkersPro.includes(lurk[0]))
      const where = mode(ls, x => Object.entries(x.lanes20).find(([, v]) => v.includes(lurk[0]))?.[0])?.[0]
      care = { icon: 'warn', text: `${B(lurk[0])} lurks${where ? ` ${where}` : ''}`, tag: tagOf(lurk[1], xs.length), refs: ls.map(x => x.ref) }
    } else if (second && second[1] >= 2) {
      const ls = xs.filter(x => x.entries.some(e => e.sec <= x.hitSec! + 12 && e.lane === second[0]))
      care = { icon: 'warn', text: `**${second[0]}** at the same time`, tag: tagOf(second[1], xs.length), refs: ls.map(x => x.ref) }
    }
    // Konter: spaeter Hit (Median >= 60 s) → Site bis zum Median halten, sonst Lane vor dem Hit mit Util treffen; Spanne nur, wenn alle Hits spaet sind
    const hm = median(hitSecs)!, h0 = Math.min(...hitSecs)
    const counter: Line = { refs: xs.map(x => x.ref), text: hm >= 60
      ? `Hold ${site} until ${clock(hm)}: their ${site} comes late${h0 >= 60 ? ` (${span(hitSecs)})` : ''}.`
      : `:molly:/:he: ${lane ?? site} at ${span([h0 - 8, h0 - 3])}, before the hit.` }
    const read = uniq.filter(r => r.site === site && r.xs.filter(x => xs.includes(x)).length * 2 >= r.xs.length).sort((a, b) => b.l.tag!.n - a.l.tag!.n)[0]
    if (read) read.site = '' // an den Spielzug gehaengt, nicht mehr unter Reads
    return {
      id, name, site, kinds, ...wl(xs), tag: tagOf(xs.length, NT), refs: xs.map(x => x.ref), buys: xs.map(buy), hitSecs,
      timeline, roles: roles(xs), read: read?.l, care, counter,
    }
  })
  const tReads = uniq.filter(r => r.site).slice(0, 4).map(r => r.l)

  // ---------- Heatmap: Zeilen = Spielzuege + Einzel-Hits (gleiches Label zusammen), Spalten = 15-s-Buckets der Hit-Uhr ----------
  const rows: { play: string; xs: TRound[] }[] = plays.map((p, i) => ({ play: `${p.id} ${p.name}`, xs: clusters[i] }))
  for (const x of hits) if (!clusters.some(c => c.includes(x))) {
    const label = x.label, row = rows.find(r => r.play === label)
    if (row) row.xs.push(x); else rows.push({ play: label, xs: [x] })
  }
  const ks = hits.map(x => bucketOf(x.hitSec!)), kMax = Math.max(...ks), kMin = Math.min(...ks)
  const heatmap: Heatmap = hits.length ? {
    buckets: Array.from({ length: kMax - kMin + 1 }, (_, i) => bucketLabel(kMax - i)),
    rows: rows.map(r => ({ play: r.play, cells: Array.from({ length: kMax - kMin + 1 }, (_, i) => r.xs.filter(x => bucketOf(x.hitSec!) === kMax - i).map(x => x.ref)) })),
  } : { buckets: [], rows: [] }

  // ---------- Overview ----------
  const overview: Line[] = []
  const planted = rounds.filter(x => x.plantInfo?.site)
  for (const s of ['A', 'B'] as const) {
    const ps = planted.filter(x => x.plantInfo!.site === s); if (!ps.length) continue
    const [who, n] = mode(ps, x => x.plantInfo!.player)!
    overview.push({ icon: 'c4', text: `**${s}** plants ${ps.length} · planter ${B(who)}`, tag: tagOf(n, ps.length), refs: ps.map(x => x.ref), stat: wl(ps) })
  }
  const fcR = rounds.filter(x => x.firstContact), fcL = mode(fcR, x => x.firstContact!.lane)
  if (fcL) {
    const xs = fcR.filter(x => x.firstContact!.lane === fcL[0])
    overview.push({ icon: 'clock', text: `First contact in **${fcL[0]}** (${countBy(xs, x => x.firstContact!.place).slice(0, 4).map(([p]) => p).join(', ')}), ${span(xs.map(x => x.firstContact!.sec))}`,
      tag: tagOf(fcL[1], fcR.length), refs: xs.map(x => x.ref), stat: wl(xs) })
  }
  const mc = rounds.filter(x => x.midT !== undefined)
  if (mc.length >= 2) overview.push({ icon: 'clock', text: `Mid control ${span(mc.map(x => x.midT!))} (median ~${clock(median(mc.map(x => x.midT!))!)})`, tag: tagOf(mc.length, rounds.length), refs: mc.map(x => x.ref) })
  const hr = rounds.filter(x => x.hitSec !== undefined)
  if (hr.length) {
    const pt = hr.filter(x => x.plantInfo).map(x => x.plantInfo!.sec)
    overview.push({ icon: 'clock', text: `Hit ${span(hr.map(x => x.hitSec!))}${pt.length ? `, plant ${span(pt)} (median ~${clock(median(pt)!)})` : ''}`, refs: hr.map(x => x.ref) })
  }
  for (const [id, n] of countBy(hr.flatMap(x => x.lurkersPro), id => id).filter(([, n]) => n >= 2).slice(0, 2)) {
    const xs = hr.filter(x => x.lurkersPro.includes(id)), where = mode(xs, x => Object.entries(x.lanes20).find(([, v]) => v.includes(id))?.[0])?.[0]
    overview.push({ icon: 'knife', text: `${B(id)} lurks${where ? ` **${where}**` : ''}`, tag: tagOf(n, hr.length), refs: xs.map(x => x.ref), stat: wl(xs) })
  }

  // ---------- AWP: Spot bei 5/15 s, erster AWP-Kill ----------
  const awp: Line[] = []
  const ar = rounds.filter(x => x.awp.length).map(x => {
    const { m, r } = ctx(x), id = x.awp[0], t = r.tracks.find(t => t.steamid === id)!
    const c = (s: number) => calloutName(m.map, r.places[t.place[frameAtSec(r, s)]] ?? '')
    const k = r.kills.find(k => /awp/i.test(k.weapon) && x.awp.includes(k.attacker ?? ''))
    return { x, id, c5: c(5), c15: c(15), kill: k && { victim: k.victim, place: calloutName(m.map, k.victimPlace), sec: (k.tick - r.freezeEndTick) / 64 } }
  })
  const top = mode(ar, a => a.c5)
  if (top) {
    // 15-s-Spot nur, wenn er in > der Haelfte der Runden gleich und anders als bei 5 s ist
    const g = ar.filter(a => a.c5 === top[0]), c15 = mode(g, a => a.c15), to = c15 && c15[0] !== top[0] && c15[1] * 2 > g.length ? c15[0] : undefined
    const ks = g.filter(a => a.kill), who = [...new Set(g.map(a => B(a.id)))].join(', '), cross = mode(ks, a => a.kill!.place)?.[0] ?? to
    awp.push({ icon: 'awp', text: `${who} on **${top[0]}** at ${clock(5)}${to ? `, **${to}** at ${clock(15)}` : ''}`, tag: tagOf(top[1], ar.length), refs: g.map(a => a.x.ref), stat: wl(g.map(a => a.x)),
      counter: `Never cross ${cross ?? top[0]} without a smoke or flash at ${ks.length ? span(ks.map(a => a.kill!.sec)) : clock(5)}: ${who} :awp: it.` })
  }
  const kr = ar.filter(a => a.kill)
  if (kr.length) awp.push({ icon: 'target', refs: kr.map(a => a.x.ref), tag: tagOf(kr.length, ar.length), stat: wl(kr.map(a => a.x)),
    text: `First :awp: kill: ${countBy(kr, a => a.kill!.place || '?').slice(0, 3).map(([p, n]) => { const ks = kr.filter(a => (a.kill!.place || '?') === p); return `**${p}** ${span(ks.map(a => a.kill!.sec))}${n > 1 ? ` ×${n}` : ` (${names.get(ks[0].kill!.victim) ?? '?'})`}` }).join(' · ')}` })

  // ---------- Pistol, 2. Runde, Force/Eco (Buy-Klasse aus P2) ----------
  const by = (c: BuyClass[]) => rounds.filter(x => c.includes(buy(x)))
  const playOf = (x: TRound) => plays.find(p => p.refs.includes(x.ref))
  const what = (x: TRound) => { const p = playOf(x); return p ? `**${p.id}** ${p.name}` : x.label }
  const pistol: Block[] = by(['pistol']).map(x => {
    const n = preHit(x), lane = x.site && entryLane(x)
    return { title: `Pistol T · ${rn(x)} ${x.won ? ':check:' : ':x:'}`, refs: [x.ref], lines: [
      { text: `**${x.label}**${plantTxt(x)}`, refs: [x.ref], counter: x.site ? `Pistol: hold ${lane ?? x.site} for their ${x.site} hit at ${clock(x.hitSec!)}.` : undefined },
      { text: n.length ? `${n.length} grenades: ${countBy(n, u => u.type).map(([t, k]) => `:${ICON[t as Util['type']]}: ×${k}`).join(' ')}` : '**0 grenades** thrown', refs: [x.ref] },
      ...roles([x]),
    ] }
  })
  const block = (title: string, xs: TRound[]): Block | undefined => xs.length ? {
    title: `${title} · ${wl(xs).won}/${xs.length}`, refs: xs.map(x => x.ref),
    lines: xs.map(x => ({ text: `${rn(x)} ${BUY[buy(x)]}: ${what(x)}${plantTxt(x)} ${x.won ? ':check:' : ':x:'}`, refs: [x.ref] })),
  } : undefined
  const force = [block('Force T', by(['deagle', 'smg', 'light'])), block('Eco T', by(['eco']))].filter((b): b is Block => !!b)

  return { overview, heatmap, plays, reads: tReads, awp, pistol, second: block('2nd round T', by(['second'])), force }
}
