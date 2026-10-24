// Anti-Strat als Markdown (Text-Export, report-cli). Icons bleiben :name:-Tokens; jede Zeile traegt Tag [n/N] und Runden-Refs.
import type { Ref } from './rounds.ts'
import type { AntiStrat, Block, BuyClass, Line, Tag } from './types.ts'
import { clockSpan } from './util.ts'

const BUY: Record<BuyClass, string> = { pistol: 'pistol', second: '2nd', eco: 'eco', deagle: 'Deagle', smg: 'SMG', light: 'light', full: 'full' }
const cell = (s: string) => s.replace(/\|/g, '\\|')
const tagTxt = (t: Tag) => `**${t.kind}** [${t.n}/${t.N}]`
const pretty = (map: string) => map.replace(/^de_/, '').replace(/^./, c => c.toUpperCase())

export function toMarkdown(a: AntiStrat): string {
  // Runden-Ref: R5, bei mehreren Demos D2·R5 (Demo-Nummer in Reihenfolge der Rundenliste)
  const demo = [...new Set(a.roundList.map(r => r.ref.matchId))]
  const R = (r: Ref) => (a.demos > 1 ? `D${demo.indexOf(r.matchId) + 1}·R${r.round}` : `R${r.round}`)
  const refs = (rs: Ref[]) => [...new Set(rs.map(R))].join(' ')
  const line = (l: Line, counter = true) =>
    [l.icon && `:${l.icon}:`, l.text, l.tag && tagTxt(l.tag), l.refs.length > 0 && `(${refs(l.refs)})`, counter && l.counter && `→ ${l.counter}`].filter(Boolean).join(' ')
  const out: string[] = []
  const push = (...xs: string[]) => out.push(...xs)
  const bullets = (title: string, ls: Line[]) => { if (ls.length) push('', `**${title}**`, ...ls.map(l => `- ${line(l)}`)) }
  const numbered = (ls: Line[]) => (ls.length ? ls.map((l, i) => `${i + 1}. ${line(l)}`) : ['_No findings._'])
  const block = (b: Block) => push('', `### ${b.title}${b.refs.length ? ` (${refs(b.refs)})` : ''}`, ...b.lines.map(l => `- ${line(l)}`))
  const table = (head: string[], rows: string[][]) => { if (rows.length) push('', `| ${head.join(' | ')} |`, `|${head.map(() => ' --- |').join('')}`, ...rows.map(r => `| ${r.map(cell).join(' | ')} |`)) }
  const wonOf = (r: Ref) => a.roundList.find(x => x.ref.matchId === r.matchId && x.ref.round === r.round)?.won

  // ---------- Header ----------
  const res = a.results.map(r => `**${r.us} : ${r.them}** vs ${r.opponent}`).join(' · ')
  push(`# Anti-strat · ${a.team} · ${pretty(a.map)}`, '',
    `> **Source:** ${a.demos} demo${a.demos > 1 ? 's' : ''}, ${a.rounds} rounds. ${a.team} ${res}.`,
    `> Their CT **${a.sides.CT.won}/${a.sides.CT.total}** · their T **${a.sides.T.won}/${a.sides.T.total}**`,
    '> **Tags:** `[n/N]` = seen in n of N rounds that fit. **HABIT** ≥ 3× · **PATTERN** 2× · **ONCE** 1×. **Clock** = round timer (1:55 → 0:00). A grenade name with `?` comes only from where it landed.',
    '> **Icons:** :smoke: :flash: :molly: :he: :awp: :deagle: :c4: plant · :kit: retake · :knife: lurk · :target: duel/pick · :arrow: push · :shuffle: rotate · :layers: setup · :clock: timing · :warn: care · :check: won · :x: lost')

  push('', '## :star: Keys (read first)', '', ...numbered(a.keys))

  push('', '## Roster')
  table(['Player', 'Rating*', 'K–D', 'ADR', 'T', 'CT', ':warn: Watch'], a.roster.map(p =>
    [`**${p.name}**`, p.rating.toFixed(2), `${p.kills}–${p.deaths}`, String(p.adr), p.t, p.ct, p.watch ? line(p.watch, false) : '–']))
  push('', '\\* Rating is our rebuild of the FACEIT rating, not the official value.')

  // ---------- T side ----------
  const t = a.t
  const none = (n: number) => { if (out.length === n) push('', '_No findings._') }
  push('', `## T side (their attack) · ${a.sides.T.won}/${a.sides.T.total}`)
  const t0 = out.length
  bullets('Overview', t.overview)
  if (t.heatmap.rows.length) {
    push('', '**Timing heatmap** (hit time; ■ = 1 round)')
    table(['Play', ...t.heatmap.buckets], t.heatmap.rows.map(r => [r.play, ...r.cells.map(c => (c.length ? `${'■'.repeat(c.length)} ${refs(c)}` : ''))]))
  }
  for (const p of t.plays) {
    const chips = p.refs.map((r, i) => `${R(r)} ${wonOf(r) ? ':check:' : ':x:'} ${BUY[p.buys[i]] ?? ''}`.trim()).join(' · ')
    push('', `### ${p.id} · ${p.name} · ${p.won}/${p.total} · ${tagTxt(p.tag)} (${chips})`, '', line(p.timeline), '', ...p.roles.map(l => `- ${line(l)}`))
    if (p.read) push('', line({ ...p.read, icon: p.read.icon ?? 'target', text: `**Read:** ${p.read.text}` }))
    if (p.care) push('', line({ ...p.care, icon: 'warn', text: `**Care:** ${p.care.text}` }))
    if (p.counter) push('', line({ ...p.counter, icon: undefined, text: `**Counter:** ${p.counter.text}` }))
  }
  bullets('Reads', t.reads)
  bullets('AWP', t.awp)
  for (const b of [...t.pistol, ...(t.second ? [t.second] : []), ...t.force]) block(b)
  none(t0)

  // ---------- CT side ----------
  const c = a.ct
  push('', `## CT side (their defence) · ${a.sides.CT.won}/${a.sides.CT.total}`)
  const c0 = out.length
  bullets('Overview', c.overview)
  bullets('Setups', c.setups)
  bullets('Spots', c.spots)
  if (c.utilSignature.length) push('', '**Utility signature**')
  table([':clock:', 'Util', 'Target', 'From', 'Rounds'], c.utilSignature.map(u =>
    [clockSpan(u.fromSec, u.toSec), u.nade.map(n => `:${n}:`).join('/'), u.target, u.throwers.join(', '), `${tagTxt(u.tag)} ${refs(u.refs)}`]))
  bullets('AWP', c.awp)
  if (c.pushes.length) push('', '**Early pushes**')
  table(['', 'Where', 'Who', 'Rounds', 'Result'], c.pushes.map(p =>
    [p.level === 'push' ? ':arrow: push' : 'forward', p.place, p.players.join(', '), refs(p.refs), `${p.kills} kill${p.kills === 1 ? '' : 's'} · ${p.deaths} dead`]))
  bullets('Rotations', c.rotations)
  bullets('Retakes', c.retakes)
  for (const b of [...c.pistol, ...(c.second ? [c.second] : []), ...c.forces]) block(b)
  none(c0)

  push('', '## Economy', '', ...(a.economy.length ? a.economy.map(l => `- ${line(l)}`) : ['_No findings._']))
  push('', '## What worked for us', '', ...(a.worked.length ? a.worked.map(l => `- ${line(l)}`) : ['_No findings._']))
  push('', '## Game plan (next match)', '', '**Our T (against their CT)**', ...numbered(a.gameplan.ourT), '', '**Our CT (against their T)**', ...numbered(a.gameplan.ourCT))

  push('', '## Round list')
  table(['R', 'Side', 'Buy them / us', 'Their play / setup', ':c4:', 'Them'], a.roundList.map(r =>
    [R(r.ref), r.side, `${BUY[r.buyThem]} / ${BUY[r.buyUs]}`, r.play || '–', r.plant ?? '–', r.won ? ':check:' : ':x:']))

  push('', '## Limits', '', ...a.limits.map(l => `- ${l}`))
  return out.join('\n') + '\n'
}
