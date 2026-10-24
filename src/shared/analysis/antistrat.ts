// Anti-Strat eines Gegners aus allen Demos: setzt Runden (P3), Wirtschaft (P2), T-Playbook (P4) und CT-Seite (P5) zusammen
// und baut Keys, Roster, Gegner-Sicht, Gameplan, Rundenliste und Grenzen. Gliederung: methodik/beispiel-dust2.md (Spike proanalyse).
import type { MatchData, Round, Side } from '../model.ts'
import { computeStats } from '../stats.ts'
import { ctReport, openingLine } from './ctside.ts'
import { buyClass, economyLines } from './economy.ts'
import { buildGeo } from './geo.ts'
import { tPlaybook } from './playbook.ts'
import { mergeStats, type Entry } from './report.ts'
import { classifyCT, classifyT, teamSide, type CTRound, type Ref, type TRound } from './rounds.ts'
import type { AntiStrat, CTSide, Line, RosterRow, RoundRow, TagKind, TSide } from './types.ts'
import { clock, countBy, tagOf } from './util.ts'

const W: Record<TagKind, number> = { HABIT: 1, PATTERN: 0.6, ONCE: 0.2 }
const other = (s: Side): Side => (s === 'T' ? 'CT' : 'T')
const secOf = (r: Round, tick: number) => (tick - r.freezeEndTick) / 64
const span = (secs: number[]) => { const s = [...secs].sort((a, b) => a - b); return s.length > 1 && clock(s[0]) !== clock(s[s.length - 1]) ? `${clock(s[0])}–${clock(s[s.length - 1])}` : clock(s[0]) }

/** Keys-Score: n × Abstand(Siegquote im Muster, Gesamt-Siegquote des Teams) × Tag-Gewicht; nur Zeilen mit tag + stat */
export const keyScore = (l: Line, overall: number) =>
  l.tag && l.stat?.total ? l.tag.n * Math.abs(l.stat.won / l.stat.total - overall) * W[l.tag.kind] : 0

/** gleiche Beleg-Runden = gleicher Befund; ohne Beleg zaehlt der Text */
const sigOf = (l: Line) => (l.refs.length ? l.refs.map(r => `${r.matchId}:${r.round}`).sort().join() : l.text)

/** Top k nach keyScore, zuerst Zeilen mit Konter (ohne nur zum Auffuellen); gleiche Beleg-Runden = gleicher Befund (der mit Konter bleibt) */
export function rankKeys(lines: Line[], overall: number, k = 3): Line[] {
  const seen = new Set<string>(), out: Line[] = []
  const scored = lines.filter(l => keyScore(l, overall) > 0).sort((a, b) => keyScore(b, overall) - keyScore(a, overall))
  const ranked = [...scored.filter(l => l.counter), ...scored.filter(l => !l.counter)]
  for (const l of ranked) {
    const sig = sigOf(l)
    if (seen.has(sig)) continue
    seen.add(sig); out.push(l)
    if (out.length === k) break
  }
  return out
}

/** alle Line-Objekte in einem Abschnitt (Play/Block/Tabellen werden durchlaufen) */
export const linesIn = (v: unknown): Line[] =>
  Array.isArray(v) ? v.flatMap(linesIn)
  : v && typeof v === 'object' ? ('text' in v && 'refs' in v ? [v as Line] : Object.values(v).flatMap(linesIn)) : []

/** Gameplan einer Seite: Pistol-Call zuerst, dann Konter der ranghoechsten Befunde (wie Keys, sonst n × Gewicht), max. 5 */
function plan(side: TSide | CTSide, extra: Line[], overall: number): Line[] {
  const items: { l: Line; s: Line; pistol: boolean }[] = []
  // Ergebnis-Icons (:check:/:x: der Pistol-Zeilen) passen nicht zum Konter
  const add = (ls: Line[], pistol = false) => { for (const l of ls) if (l.counter) items.push({ s: l, l: { icon: l.icon === 'x' || l.icon === 'check' ? undefined : l.icon, text: l.counter, refs: l.refs, tag: l.tag }, pistol }) }
  add(linesIn(side.pistol), true)
  add([...linesIn(side), ...extra])
  if ('plays' in side) for (const p of side.plays) if (p.counter) items.push({ s: { ...p.counter, tag: p.tag, stat: { won: p.won, total: p.total } }, l: { ...p.counter, tag: p.counter.tag ?? p.tag }, pistol: false })
  const rank = (x: Line) => [keyScore(x, overall), x.tag ? x.tag.n * W[x.tag.kind] : 0]
  items.sort((a, b) => +b.pistol - +a.pistol || rank(b.s)[0] - rank(a.s)[0] || rank(b.s)[1] - rank(a.s)[1])
  // gleicher Text oder gleiche Beleg-Runden = derselbe Konter (wie rankKeys)
  const seen = new Set<string>()
  return items.filter(i => { const k = [i.l.text, sigOf(i.l)]; if (k.some(x => seen.has(x))) return false; k.forEach(x => seen.add(x)); return true }).slice(0, 5).map(i => i.l)
}

export function buildAntiStrat(input: Entry[]): AntiStrat {
  const entries = input.filter((e, i) => input.findIndex(x => x.match.id === e.match.id) === i)
  const team = entries[0].team, matches = entries.map(e => e.match)
  const geo = buildGeo(matches)
  const names: Record<string, string> = {}
  for (const m of matches) for (const p of m.players) names[p.steamid] = p.name
  const N = (id?: string) => (id && names[id]) || '?'

  // Runden: ihre T-Runden, ihre CT-Runden + die T-Analyse des Gegners derselben Runde (Retakes, Rotationen)
  const tRounds: TRound[] = [], ctRounds: CTRound[] = [], oppT: TRound[] = []
  const at = new Map<string, { m: MatchData; r: Round; side: Side }>()
  for (const { match: m } of entries) for (const r of m.rounds) {
    const side = teamSide(r, team)
    at.set(`${m.id}:${r.num}`, { m, r, side })
    if (side === 'T') { tRounds.push(classifyT(m, r, team, geo)); continue }
    const tr = classifyT(m, r, r.teamOnSide.T, geo)
    oppT.push(tr); ctRounds.push(classifyCT(m, r, team, geo, tr))
  }
  // Demo-Reihenfolge, dann Runde: Beleg-Runden stehen überall sortiert
  const all = [...tRounds, ...ctRounds].sort((a, b) => matches.findIndex(m => m.id === a.matchId) - matches.findIndex(m => m.id === b.matchId) || a.round - b.round)
  const won = all.filter(r => r.won).length, overall = won / Math.max(1, all.length)
  const info = (x: { matchId: string; round: number }) => at.get(`${x.matchId}:${x.round}`)!
  const tp = tPlaybook(entries, tRounds), ct = ctReport(entries, ctRounds, oppT, geo)
  const tOpen = openingLine(entries, 'T') // Opening-Konversion je Seite; die CT-Zeile setzt ctReport selbst
  const t: TSide = tOpen ? { ...tp, overview: [...tp.overview, tOpen] } : tp

  // Wirtschaft (P2); Sammelzeilen ohne Beleg bekommen die Runden ihrer Seite
  const sideRefs = (s: Side) => (s === 'T' ? tRounds : ctRounds).map(r => r.ref)
  const economy = economyLines(entries, all).map(l => (l.tag || l.refs.length ? l : { ...l, refs: sideRefs(l.text.startsWith('T:') ? 'T' : 'CT') }))

  // ---------- What worked for us (Gegner-Sicht) ----------
  const worked: { side: Side; l: Line }[] = []
  for (const site of ['A', 'B'] as const) {
    const rs = ctRounds.filter(c => info(c).r.plant?.site === site); if (!rs.length) continue
    const w = rs.filter(c => !c.won), secs = w.map(c => { const { r } = info(c); return secOf(r, r.plant!.tick) })
    worked.push({ side: 'CT', l: {
      icon: 'c4', text: `**${site}** plants ${rs.length}, we won ${w.length}${w.length ? ` · plant ${span(secs)}` : ''}`,
      tag: w.length ? tagOf(w.length, rs.length) : undefined, refs: (w.length ? w : rs).map(c => c.ref), stat: { won: rs.length - w.length, total: rs.length },
      counter: w.length >= 2 && w.length * 2 >= rs.length ? `Hit ${site} and plant: won ${w.length}/${rs.length}.` : undefined,
    } })
  }
  // Retake-Held steht schon unter CT side "Retake wins" (ctside.ts) mit Konter; hier keine zweite Zeile
  // Picks: unser erster Kill der Runde am selben Ort >= 2x
  const picks = all.filter(r => r.opening && !r.opening.forUs)
  for (const [key, n] of countBy(picks, r => `${r.kind}|${r.opening!.place}`)) {
    if (n < 2) continue
    const [side, place] = key.split('|') as [Side, string], rs = picks.filter(r => `${r.kind}|${r.opening!.place}` === key)
    const range = span(rs.map(r => r.opening!.sec))
    worked.push({ side, l: {
      icon: 'target', text: `Opening picks on **${place}** (their ${side}): ${countBy(rs, r => N(r.opening!.victim)).map(([v, k]) => (k > 1 ? `${v} ×${k}` : v)).join(', ')} at ${range}`,
      tag: tagOf(n, (side === 'T' ? tRounds : ctRounds).length), refs: rs.map(r => r.ref), stat: { won: rs.filter(r => r.won).length, total: n },
      counter: `Keep it: pick ${place} at ${range}.`,
    } })
  }

  // ---------- Roster ----------
  const stats = mergeStats(entries.map(e => computeStats(e.match).players.filter(p => p.team === e.team))).sort((a, b) => b.rating - a.rating)
  const plants = tRounds.filter(r => r.plantInfo?.site)
  const openings = all.filter(r => r.opening)
  const roster: RosterRow[] = stats.map(p => {
    const id = p.steamid, n = (f: (r: TRound) => boolean | undefined) => tRounds.filter(f).length, NT = tRounds.length
    const tr: string[] = []
    const awp = n(r => r.awp.includes(id)), entry = n(r => r.entry === id), lurk = n(r => r.lurkersPro.includes(id)), sup = n(r => r.support.includes(id))
    if (awp >= 2) tr.push(`:awp: [${awp}/${NT}]`)
    if (entry >= 2) tr.push(`entry [${entry}/${NT}]`)
    if (lurk >= 2) tr.push(`:knife: lurk [${lurk}/${NT}]`)
    if (sup >= 2) tr.push(`support [${sup}/${NT}]`)
    for (const s of ['A', 'B'] as const) {
      const ps = plants.filter(r => r.plantInfo!.site === s), k = ps.filter(r => r.plantInfo!.player === id).length
      if (k) tr.push(`:c4: ${s} [${k}/${ps.length}]`)
    }
    const pos = countBy(ctRounds, r => r.pos15[id]), here = pos.reduce((a, x) => a + x[1], 0)
    const aw = countBy(ctRounds, r => r.awpSpot.find(a => a.id === id)?.place)
    const ctr = [pos[0] && pos[0][1] * 2 >= here ? `${pos[0][0]} [${pos[0][1]}/${ctRounds.length}]` : 'flex', aw[0] && `:awp: ${aw[0][0]} [${aw[0][1]}/${ctRounds.length}]`].filter(Boolean)
    // Watch: erster Kontakt am selben Ort (Kill oder Tod) >= 2x, sonst die staerkste Zeile ueber ihn
    const op = [...countBy(openings, r => (r.opening!.killer === id ? `kills|${r.opening!.place}` : r.opening!.victim === id ? `deaths|${r.opening!.place}` : undefined))]
    let watch: Line | undefined
    if (op[0] && op[0][1] >= 2) {
      const [kind, place] = op[0][0].split('|'), rs = openings.filter(r => (kind === 'kills' ? r.opening!.killer : r.opening!.victim) === id && r.opening!.place === place)
      watch = { icon: kind === 'kills' ? 'target' : 'x', text: `opening ${kind} on ${place}`, tag: tagOf(rs.length, all.length), refs: rs.map(r => r.ref), stat: { won: rs.filter(r => r.won).length, total: rs.length } }
    } else watch = [...linesIn(t), ...linesIn(ct)].filter(l => l.text.includes(`**${p.name}**`) && l.tag && l.text.length <= 80).sort((a, b) => b.tag!.n * W[b.tag!.kind] - a.tag!.n * W[a.tag!.kind])[0]
    return { steamid: id, name: p.name, rating: Math.round(p.rating * 100) / 100, kills: p.kills, deaths: p.deaths, adr: Math.round(p.adr), t: tr.join(' · ') || 'flex', ct: ctr.join(' · '), watch }
  })

  // ---------- Rundenliste ----------
  const playOf = (r: TRound) => t.plays.find(p => p.refs.some(x => x.matchId === r.matchId && x.round === r.round))
  const roundList: RoundRow[] = all.map(x => {
    const { m, r, side } = info(x), p = x.kind === 'T' ? playOf(x) : undefined
    const play = x.kind === 'T' ? (p ? `**${p.id}** ${p.name}` : x.label)
      : [...x.awpSpot.map(a => `:awp: ${a.place}`), ...countBy(x.aggression, a => `${a.place} ${a.level}`).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)), x.setup15].filter(Boolean).join(' · ')
    return { ref: x.ref, side, buyThem: buyClass(m, r, side), buyUs: buyClass(m, r, other(side)), play, plant: r.plant ? `${r.plant.site ?? '?'} ${clock(secOf(r, r.plant.tick))}` : undefined, won: x.won }
  })

  // ---------- Keys, Gameplan, Grenzen ----------
  const wT = worked.filter(w => w.side === 'T').map(w => w.l), wCT = worked.filter(w => w.side === 'CT').map(w => w.l)
  const ecoOf = (s: Side) => economy.filter(l => l.text.startsWith(`${s}:`))
  const keys = rankKeys([...linesIn(t), ...linesIn(ct), ...economy, ...worked.map(w => w.l)], overall)
  const utils = [...tRounds, ...oppT].flatMap(r => r.util), unnamed = utils.filter(u => !u.named).length
  const faceit = matches.some(m => /faceit/i.test(m.serverName))
  const limits = [
    `**${matches.length} demo${matches.length > 1 ? 's' : ''}.** Every tag means "seen in ${matches.length > 1 ? 'these matches' : 'this match'}", not a long-term habit.${faceit ? ' A FACEIT pug team changes plays more than a pro team.' : ''}`,
    `Positions are the demo's callout names (\`last_place_name\`). ${unnamed} of ${utils.length} grenade names come from the landing zone only (marked \`?\`).`,
    '"Traded" = the killer died within 5 s (parser rule). Buy classes come from the weapons at freeze end.',
    'Rating is our rebuild of the FACEIT rating, not the official value.',
  ]
  const wl = (rs: { won: boolean }[]) => ({ won: rs.filter(r => r.won).length, total: rs.length })
  return {
    team, map: matches[0].map, demos: matches.length, rounds: all.length,
    results: entries.map(e => { const opp = e.match.teams.find(x => x !== e.team)!; return { opponent: opp, us: e.match.finalScore[e.team], them: e.match.finalScore[opp] } }),
    sides: { T: wl(tRounds), CT: wl(ctRounds) },
    keys, roster, t, ct, economy, worked: worked.map(w => w.l),
    gameplan: { ourT: plan(ct, [...ecoOf('CT'), ...wCT], overall), ourCT: plan(t, [...ecoOf('T'), ...wT], overall) },
    roundList, limits, names,
  }
}
