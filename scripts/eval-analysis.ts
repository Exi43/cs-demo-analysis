// Mess-Skript der Pro-Analyse: alle Erkennungsregeln an den Test-Demos gegen die Labels in scripts/analysis-gt/ (Abnahme P1–P9).
// node scripts/eval-analysis.ts [demo …] [--lanes <ordner>] → Tabelle; Exit 1, wenn eine Schwelle unterschritten wird.
// MatchData-Cache unter ../Daten/csda-eval-cache: neu parsen bei anderer Datei, DATA_VERSION oder geändertem parse.ts/model.ts.
// Fehlende Module oder Felder (Stubs, alter Stand) ergeben 'n/a' statt Absturz. Gleiche Match-ID zählt nur einmal.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { DATA_VERSION, type MatchData, type Side } from '../src/shared/model.ts'
import { buildGeo, frameAtSec } from '../src/shared/analysis/geo.ts'
import { classifyRounds, type CTRound, type TRound } from '../src/shared/analysis/rounds.ts'

const t0 = performance.now()
const ROOT = resolve(import.meta.dirname, '..')
const CACHE = join(ROOT, '../Daten/csda-eval-cache')
const DEFAULT = [
  join(ROOT, 'demos/user-demo.dem'), join(ROOT, 'demos/faceit-de_mirage-6de46e85.dem'),
  join(ROOT, 'demos/1-22f4620d-72ff-4134-b107-a92d9dafc9ae-1-1.dem.zst'), // Ancient
  join(ROOT, 'demos/1-d5d5dc8c-599a-42c2-b962-7837157de6f9-1-1.dem.zst'), // Dust2, gleiche Match-ID wie user-demo.dem
]
/** Match-ID → Schlüssel in den Label-Dateien */
const KEY: Record<string, string> = { '4699fdaf49070d28': 'dust2', '6eb6fdc165673087': 'mirage', '640628b28569ee89': 'ancient' }

/** Untergrenzen aus den Abnahmen (n/N oder %); Zeilen mit ' · <map>' gelten je Demo */
const MIN: Record<string, string> = {
  'T plan': '67/70', 'T site': '61/63', 'T fake': '61/63', 'execute precision': '100%', 'rush precision': '100%', 'split precision': '15/18',
  'lurk rounds': '43/54', 'lurk player precision': '75%', 'CT push recall': '57/58', 'CT push precision': '57/59', 'CT push|forward rounds': '9/12',
  'retake': '33/34', 'cluster pair precision': '70%', 'cluster pair recall': '80%', 'buy': '133/140',
  'smokes named': '80%', 'smokes named · de_mirage': '72%', 'nades with name': '100%', 'lane coverage': '98%', 'lane coverage (local)': '95%', 'Dust2 facts': '16/20',
}
// Mirage 72 %: Spike-Messung offizielle Smokes 72,5 % (CT-Smokes Top Mid/Palace-Rand fehlen im Katalog); andere Maps 80 %
/** Obergrenzen in ms je Aufruf (ein Team einer Demo), geprüft am Median */
const MAX: Record<string, number> = { classifyRounds: 80, tPlaybook: 40, ctReport: 30, buildAntiStrat: 150, buyClass: 5, 'nadeName ×10k': 150 }

/** Modul laden; fehlt es (Stand vor P0/P1), undefined. Andere Fehler (Syntax, Laufzeit) brechen ab. */
async function opt<T>(p: string): Promise<T | undefined> {
  try { return await import(p) } catch (e) { if ((e as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') return undefined; throw e }
}
const eco = await opt<typeof import('../src/shared/analysis/economy.ts')>('../src/shared/analysis/economy.ts')
const maps = await opt<typeof import('../src/shared/analysis/maps/index.ts')>('../src/shared/analysis/maps/index.ts')
const lanes = await opt<typeof import('../src/shared/analysis/maps/lanes.ts')>('../src/shared/analysis/maps/lanes.ts')
const pb = await opt<typeof import('../src/shared/analysis/playbook.ts')>('../src/shared/analysis/playbook.ts')
const cs = await opt<typeof import('../src/shared/analysis/ctside.ts')>('../src/shared/analysis/ctside.ts')
const as = await opt<typeof import('../src/shared/analysis/antistrat.ts')>('../src/shared/analysis/antistrat.ts')
const md = await opt<typeof import('../src/shared/analysis/antistrat-text.ts')>('../src/shared/analysis/antistrat-text.ts')

const gt = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'analysis-gt', f), 'utf8'))
const GT_T: Record<string, Record<string, { site: string; cat: string[]; fake: string; lurk: string[] }>> = gt('groundtruth-t.json')
const GT_CT: Record<string, { pos: Record<string, string[]>; dc: Record<string, string[]>; forwardRounds?: [number, number]; forward?: Record<string, string[]> }> = gt('groundtruth-ct.json')
const GT_PLAYS: Record<string, Record<string, number[][]>> = gt('groundtruth-plays.json')
const GT_RETAKE: Record<string, Record<string, string>> = gt('groundtruth-retake.json')
const BUY: { matches: { id: string; rounds: Record<string, Record<Side, string>> }[] } = gt('buy.json')
const FACTS: { match: string; team: string; facts: { id: string; re: string }[] } = gt('dust2-facts.json')

// ---------- Cache ----------
const src = (f: string) => readFileSync(join(ROOT, f), 'utf8').replace(/\r/g, '') // CRLF/LF egal (git archive, autocrlf)
const PARSER = createHash('sha1').update(src('src/main/parse.ts') + src('src/shared/model.ts')).digest('hex').slice(0, 12)
let parsed = 0
async function load(file: string): Promise<{ m: MatchData; ms: number; cached: boolean }> {
  const st = statSync(file), s = performance.now()
  const key = [DATA_VERSION, PARSER, st.size, st.mtimeMs].join('|')
  const base = join(CACHE, `${basename(file).replace(/\.dem(\.gz|\.zst)?$/i, '')}-${createHash('sha1').update(resolve(file)).digest('hex').slice(0, 6)}`)
  let old = ''
  try { old = readFileSync(base + '.key', 'utf8') } catch { /* noch kein Cache */ }
  if (old === key) return { m: JSON.parse(readFileSync(base + '.json', 'utf8')), ms: performance.now() - s, cached: true }
  const { parseDemo } = await import('../src/main/parse.ts') // nur bei Cache-Miss: demoparser2 laden kostet Zeit
  const m = parseDemo(readFileSync(file), basename(file))
  mkdirSync(CACHE, { recursive: true }); writeFileSync(base + '.json', JSON.stringify(m)); writeFileSync(base + '.key', key)
  parsed++
  return { m, ms: performance.now() - s, cached: false }
}

// ---------- Zähler ----------
const C = new Map<string, [number, number]>() // Metrik → [richtig, gesamt]
const NOTE = new Map<string, string>()
const MS = new Map<string, number[]>()
const add = (k: string, a: number, n = 1) => { const c = C.get(k) ?? [0, 0]; c[0] += a; c[1] += n; C.set(k, c) }
function time<T>(k: string, f: () => T): T {
  const s = performance.now(), x = f()
  MS.set(k, [...(MS.get(k) ?? []), performance.now() - s])
  return x
}

/** Plan-Kategorien einer T-Runde aus den Tags */
function tCats(t: TRound): Set<string> {
  const s = new Set<string>()
  for (const x of t.tags) if (/^(no hit|save)/.test(x)) s.add('none'); else if (['rush', 'execute', 'split', 'default', 'hit'].includes(x)) s.add(x)
  if (t.site && !['rush', 'execute', 'split'].some(x => s.has(x))) s.add('hit')
  return s
}
/** Richtig, wenn eine Kategorie akzeptiert ist und "kein Hit" nicht der Label-Aussage widerspricht (wie Spike eval-t.ts) */
const okCat = (s: Set<string>, cat: string[]) =>
  [...s].some(x => cat.includes(x)) && !(s.has('none') !== (cat.length === 1 && cat[0] === 'none') && !(cat.includes('none') && cat.length > 1))
const siteOf = (t: TRound) => t.site ?? /\((A|B) side\)/.exec(t.label)?.[1] ?? '-'

// ---------- Demos ----------
const args = process.argv.slice(2), li = args.indexOf('--lanes')
const lanesDir = li >= 0 ? args.splice(li, 2)[1] : undefined
const files = lanesDir ? readdirSync(lanesDir).filter(f => /\.dem(\.gz|\.zst)?$/i.test(f)).map(f => join(lanesDir, f)) : args.length ? args : DEFAULT
const seen = new Map<string, string>()
const demoLines: string[] = []

for (const file of files) {
  const { m, ms, cached } = await load(file)
  if (seen.has(m.id)) { demoLines.push(`dup  ${basename(file)} = ${seen.get(m.id)} (match ${m.id}), skipped`); continue }
  seen.set(m.id, basename(file))
  const key = lanesDir ? undefined : KEY[m.id], local = key ? '' : ' (local)' // --lanes: ohne Labels
  const name = new Map(m.players.map(p => [p.steamid, p.name]))
  const geo = buildGeo([m])
  const byTeam = new Map(m.teams.map(team => [team, time('classifyRounds', () => classifyRounds(m, team, geo))]))
  const tOf = (team: string) => (byTeam.get(team) ?? []).filter((x): x is TRound => x.kind === 'T')
  const ctOf = (team: string) => (byTeam.get(team) ?? []).filter((x): x is CTRound => x.kind === 'CT')
  const T = m.teams.flatMap(tOf), CT = m.teams.flatMap(ctOf)
  demoLines.push(`${m.map.padEnd(11)} ${m.id}  ${String(m.rounds.length).padStart(2)} R  load ${(ms / 1000).toFixed(1)} s${cached ? ' (cache)' : ' (parsed)'}  classify ${Math.round(Math.max(...MS.get('classifyRounds')!.slice(-2)))} ms  ${basename(file)}`)

  // T-Seite: Plan, Site, Fake, Tag-Präzision, Lurker, Retake
  for (const t of T) {
    const g = key && GT_T[key]?.[t.round]
    if (!g) continue
    const cats = tCats(t)
    add('T plan', +okCat(cats, g.cat))
    if (g.site !== '?') add('T site', +(siteOf(t) === g.site))
    if (g.fake !== '?') add('T fake', +(t.tags.some(x => x.startsWith('fake ')) === (g.fake === 'yes')))
    for (const x of ['execute', 'rush', 'split']) if (cats.has(x)) add(`${x} precision`, +g.cat.includes(x))
    // Lurker nur in Runden mit Hit laut Label (oder gelabeltem Lurker), = Spike-Nenner 54
    if (!g.cat.includes('none') || g.lurk.length) {
      const gl = new Set(g.lurk), pl = new Set(t.lurkersPro.map(s => name.get(s)))
      add('lurk rounds', +(gl.size === pl.size && [...gl].every(x => pl.has(x))))
      for (const x of pl) add('lurk player precision', +gl.has(x!))
    }
    const rt = GT_RETAKE[key]?.[t.round]
    if (rt && rt !== '?' && 'plantInfo' in t) add('retake', +(t.plantInfo?.retake === rt))
  }

  // CT-Seite: Push (T-Hälfte) je Spieler, Push|Forward je Runde
  const gc = key ? GT_CT[key] : undefined
  if (gc) {
    // Runden mit Push oder Forward = Push-Quote der Anti-Strat (ctReport, inkl. Forward vor dem üblichen CT-Halt)
    const pushed = new Set(cs ? m.teams.flatMap(team => cs.ctReport([{ match: m, team }], ctOf(team), tOf(m.teams.find(x => x !== team) ?? ''), geo)
      .overview.filter(l => l.icon === 'arrow').flatMap(l => l.refs.map(r => r.round))) : [])
    const wrong: number[] = [], missed: number[] = []
    let labeled = 0
    for (const c of CT) {
      const pos = new Set(gc.pos[c.round] ?? []), dc = new Set(gc.dc[c.round] ?? [])
      const got = new Set(c.aggression.filter(a => a.level === 'push').map(a => name.get(a.id)!))
      for (const x of got) if (pos.has(x)) add('CT push precision', 1); else if (!dc.has(x)) add('CT push precision', 0)
      for (const x of pos) add('CT push recall', +got.has(x))
      const [r0, r1] = gc.forwardRounds ?? [1, 0]
      if (c.round < r0 || c.round > r1) continue
      const want = pos.size > 0 || !!gc.forward?.[c.round], det = pushed.has(c.round)
      add('CT push|forward rounds', +(det && want))
      if (want) labeled++
      if (det !== want) (det ? wrong : missed).push(c.round)
    }
    if (gc.forwardRounds) NOTE.set('CT push|forward rounds', `label ${labeled}; missed ${missed.map(r => 'R' + r).join(' ') || '-'}; extra ${wrong.map(r => 'R' + r).join(' ') || '-'}`)
  }

  // Wirtschaft gegen buy.json
  const gb = BUY.matches.find(x => x.id === m.id)
  if (eco) {
    const cls = time('buyClass', () => m.rounds.map(r => ({ T: eco.buyClass(m, r, 'T'), CT: eco.buyClass(m, r, 'CT') })))
    if (gb && key) m.rounds.forEach((r, i) => { for (const s of ['T', 'CT'] as const) add('buy', +(cls[i][s] === gb.rounds[r.num]?.[s])) })
  }

  // Granaten-Namen und Laufweg-Abdeckung (lebende Spieler 0–60 s)
  if (maps) {
    const inp = m.rounds.flatMap(r => r.nades.map(n => maps.nadeInput(n, r.tracks.find(t => t.steamid === n.thrower)?.side)))
    inp.forEach(x => maps.nadeName(m.map, x)) // Aufwärmen: der erste Lauf misst sonst vor allem den JIT (kalt ~2×)
    const s = performance.now(), out = inp.map(x => maps.nadeName(m.map, x))
    if (inp.length) MS.set('nadeName ×10k', [...(MS.get('nadeName ×10k') ?? []), ((performance.now() - s) * 10000) / inp.length])
    inp.forEach((x, i) => { if (x.type === 'smoke') add(`smokes named${local} · ${m.map}`, +out[i].named); add('nades with name', +!!out[i].name) })
  }
  if (lanes) {
    const L = lanes.LANES[m.map] ?? {}, miss = new Map<string, number>(), k = `lane coverage${local} · ${m.map}`
    let a = 0, n = 0
    for (const r of m.rounds) {
      const f60 = frameAtSec(r, 60)
      for (const t of r.tracks) for (let f = frameAtSec(r, 0); f <= f60 && f < t.hp.length; f++) {
        if (t.hp[f] <= 0) continue
        const p = r.places[t.place[f]] ?? ''
        n++; if (L[p]) a++; else miss.set(p, (miss.get(p) ?? 0) + 1)
      }
    }
    add(k, a, n)
    NOTE.set(k, [...miss].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([p, c]) => `${p || "''"} ${c}`).join(', '))
  }

  // Spielzug-Cluster paarweise gegen groundtruth-plays.json (Runden ohne Spielzug = eigener Cluster)
  for (const team of m.teams) {
    const tr = tOf(team), ct = ctOf(team), opp = m.teams.find(x => x !== team) ?? ''
    if (cs) time('ctReport', () => cs.ctReport([{ match: m, team }], ct, tOf(opp)))
    if (!pb) continue
    const plays = time('tPlaybook', () => pb.tPlaybook([{ match: m, team }], tr)).plays
    const groups = key ? GT_PLAYS[key]?.[team] : undefined
    if (!groups || !plays.length) continue
    const g = new Map<number, number>(), c = new Map<number, number>()
    groups.forEach((gr, i) => gr.forEach(r => g.set(r, i)))
    plays.forEach((p, i) => p.refs.forEach(r => c.set(r.round, i)))
    const rs = [...g.keys()], cl = (r: number) => c.get(r) ?? -r
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const sg = g.get(rs[i]) === g.get(rs[j]), sc = cl(rs[i]) === cl(rs[j])
      if (sc) add('cluster pair precision', +sg)
      if (sg) add('cluster pair recall', +sc)
    }
  }

  // Anti-Strat: Laufzeit je Team, Fakten-Check gegen den Text-Export
  if (as) for (const team of m.teams) {
    const a = time('buildAntiStrat', () => as.buildAntiStrat([{ match: m, team }]))
    if (!key || m.id !== FACTS.match || team !== FACTS.team || !md) continue
    const text = md.toMarkdown(a), miss = FACTS.facts.filter(f => !new RegExp(f.re, 'i').test(text))
    add('Dust2 facts', FACTS.facts.length - miss.length, FACTS.facts.length)
    NOTE.set('Dust2 facts', text ? (miss.length ? `missing ${miss.slice(0, 5).map(f => f.id).join(', ')}${miss.length > 5 ? ' …' : ''}` : '') : 'export empty')
  }
}

// ---------- Tabelle ----------
const ratio = (s: string) => { const [a, b] = s.split('/').map(Number); return b ? a / b : parseFloat(s) / 100 }
const rows: string[][] = []
let fail = 0
const verdict = (ok: boolean) => (ok ? 'ok' : (fail++, 'FAIL'))
for (const k of Object.keys(MIN)) {
  if (k.includes(' · ')) continue // Map-Ausnahme, gilt über die Basis-Metrik
  const ks = [...C.keys()].filter(x => x === k || x.startsWith(k + ' · '))
  if (!ks.length) { if (!lanesDir) rows.push([k, 'n/a', '', MIN[k], '', '']); continue }
  for (const x of ks) {
    const [a, n] = C.get(x)!
    const min = MIN[x] ?? MIN[k]
    rows.push([x, `${a}/${n}`, `${Math.round((100 * a) / n)}%`, min, verdict(a / n >= ratio(min) - 1e-9), NOTE.get(x) ?? ''])
  }
}
// Zeilen ohne Schwelle (z. B. Granaten-Namen auf lokalen Demos) nur zur Info
for (const [x, [a, n]] of C) if (!rows.some(r => r[0] === x)) rows.push([x, `${a}/${n}`, `${Math.round((100 * a) / n)}%`, '', '', NOTE.get(x) ?? ''])
for (const [k, max] of Object.entries(MAX)) {
  const v = [...(MS.get(k) ?? [])].sort((a, b) => a - b)
  if (!v.length) { rows.push([`${k} ms`, 'n/a', '', `<= ${max}`, '', '']); continue }
  const med = v[v.length >> 1]
  rows.push([`${k} ms`, med.toFixed(1), '', `<= ${max}`, verdict(med <= max), `median of ${v.length}, max ${v[v.length - 1].toFixed(1)}`])
}
const total = performance.now() - t0, limit = parsed ? 60000 : 30000
rows.push(['total runtime s', (total / 1000).toFixed(1), '', `<= ${limit / 1000}`, verdict(total <= limit), `${seen.size} matches, ${parsed} parsed`])

const w = [0, 1, 2, 3, 4].map(i => Math.max(...rows.map(r => r[i].length)))
console.log(demoLines.join('\n') + '\n')
console.log(['metric', 'value', '%', 'min/max', 'ok'].map((h, i) => h.padEnd(w[i])).join('  '))
for (const r of rows) console.log(r.map((c, i) => (i < 5 ? c.padEnd(w[i]) : c)).join('  ').trimEnd())
console.log(fail ? `\n${fail} below threshold` : '\nall thresholds met')
process.exitCode = fail ? 1 : 0
