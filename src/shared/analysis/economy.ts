// Buy-Klasse wie ein Analyst (aus den Waffen bei Freezetime-Ende statt nur aus dem Team-Wert) und die Wirtschafts-Zeilen.
// Schwellen an scripts/analysis-gt/buy.json justiert (70 Runden x 2 Seiten, Test: economy.test.ts).
import type { MatchData, PlayerTrack, Round, Side } from '../model.ts'
import { frameAtSec } from './geo.ts'
import type { Entry } from './report.ts'
import type { CTRound, TRound } from './rounds.ts'
import type { BuyClass, Line } from './types.ts'
import { countBy, tagOf } from './util.ts'

const RIFLE = new Set(['AK-47', 'M4A4', 'M4A1-S', 'AWP', 'Galil AR', 'FAMAS', 'AUG', 'SG 553', 'G3SG1', 'SCAR-20'])
const SMG = new Set(['MAC-10', 'MP9', 'MP7', 'MP5-SD', 'UMP-45', 'P90', 'PP-Bizon', 'Nova', 'XM1014', 'MAG-7', 'Sawed-Off', 'M249', 'Negev'])
// Plateaus auf buy.json (140/140): FULL 19 900–20 400 (±2000 noch >= 132), FORCE 800–1000, LATE 300–1000
const FULL = 20000 // Team-Wert ab dem ein Gewehr-Buy "full" ist (light bis 19 850, full ab 20 500)
const FORCE = 900 // $ im Schnitt pro Spieler ohne Gewehr: darueber Pistolen-Force (deagle ab 1050), darunter Save (eco bis 770)
const LATE = 1000 // $ zwischen Freezetime-Ende und 20 s ausgegeben = Kauf nach dem Inventar-Schnappschuss

type Gun = 'rifle' | 'smg'
const gunOf = (ws: (string | undefined)[]): Gun | undefined =>
  ws.some(w => w && RIFLE.has(w)) ? 'rifle' : ws.some(w => w && SMG.has(w)) ? 'smg' : undefined

/** Waffe + Wert eines Spielers. Spaetkaeufer: Gewehr, das er in den ersten 20 s haelt (nur mit Spaetkauf, sonst waere es aufgehoben) */
function playerBuy(r: Round, t: PlayerTrack, f0: number, f20: number): { gun?: Gun; value: number } {
  const gun = gunOf(t.inventory), late = t.money[f0] - t.money[f20] // Kill-Geld macht late kleiner, nie groesser
  if (gun || late < LATE) return { gun, value: t.equipValue }
  let held: Gun | undefined
  for (let f = f0; f <= f20 && !held; f++) if (t.hp[f] > 0) held = gunOf([r.weapons[t.weapon[f]]])
  return held ? { gun: held, value: t.equipValue + late } : { value: t.equipValue }
}

/** Klasse nur aus den Waffen (ohne pistol/second); leeres Inventar → Parser-Klasse */
function weaponClass(r: Round, side: Side): BuyClass {
  const ts = r.tracks.filter(t => t.side === side)
  if (!ts.some(t => t.inventory.length)) return r.buy[side] === 'force' ? 'light' : r.buy[side]
  const f0 = frameAtSec(r, 0), f20 = frameAtSec(r, 20)
  const ps = ts.map(t => playerBuy(r, t, f0, f20))
  const rifles = ps.filter(p => p.gun === 'rifle').length, smgs = ps.filter(p => p.gun === 'smg').length
  if (rifles + smgs >= Math.min(3, ps.length)) return smgs > rifles ? 'smg' : ps.reduce((a, p) => a + p.value, 0) >= FULL ? 'full' : 'light'
  const rest = ps.filter(p => !p.gun)
  return rest.reduce((a, p) => a + p.value, 0) / rest.length >= FORCE ? 'deagle' : 'eco'
}

export function buyClass(m: MatchData, r: Round, side: Side): BuyClass {
  if (r.buy[side] === 'pistol') return 'pistol'
  const i = m.rounds.findIndex(x => x.num === r.num)
  if (i > 0 && m.rounds[i - 1].buy[side] === 'pistol') return 'second'
  return weaponClass(r, side)
}

const ORDER: BuyClass[] = ['full', 'light', 'smg', 'deagle', 'eco', 'second', 'pistol']
const NAME: Record<BuyClass, string> = { full: 'full buy', light: 'light buy', smg: 'SMG force', deagle: 'Deagle force', eco: 'eco', second: '2nd round', pistol: 'pistol' }
const LOW: BuyClass[] = ['eco', 'deagle', 'smg']

/** [economy] je Seite: Siegquote je Klasse, Full-Save ja/nein, Kauf nach verlorener Runde, erster Kauf nach verlorenem Pistol */
export function economyLines(entries: Entry[], rounds: (TRound | CTRound)[]): Line[] {
  const byId = new Map(entries.map(e => [e.match.id, e]))
  const rs = rounds.flatMap(x => {
    const e = byId.get(x.matchId), i = e ? e.match.rounds.findIndex(r => r.num === x.round) : -1
    if (!e || i < 0) return []
    const m = e.match, prev = m.rounds[i - 1]
    return [{ x, m, i, cls: buyClass(m, m.rounds[i], x.kind), lostPrev: !!prev && prev.teamOnSide[prev.winner] !== e.team }]
  })
  type R = (typeof rs)[number]
  const won = (s: R[]) => s.filter(r => r.x.won).length
  const refs = (s: R[]) => s.map(r => r.x.ref)
  const times = (s: R[]) => countBy(s, r => r.cls).map(([c, n]) => `${NAME[c as BuyClass]} ${n}×`).join(', ')
  const lines: Line[] = []

  for (const side of ['CT', 'T'] as const) {
    const s = rs.filter(r => r.x.kind === side)
    if (!s.length) continue
    const of = (c: BuyClass) => s.filter(r => r.cls === c)
    lines.push({ text: `${side}: ` + ORDER.filter(c => of(c).length).map(c => `${NAME[c]} ${won(of(c))}/${of(c).length}`).join(' · '), refs: [] })

    const eco = of('eco')
    lines.push(eco.length
      ? { text: `${side}: Full save in ${eco.length} of ${s.length} rounds.`, tag: tagOf(eco.length, s.length), refs: refs(eco), stat: { won: won(eco), total: eco.length } }
      : { text: `${side}: No full save in ${s.length} rounds.`, refs: [] })

    const after = s.filter(r => r.lostPrev && r.cls !== 'pistol' && r.cls !== 'second')
    const low = after.filter(r => LOW.includes(r.cls)), rich = after.filter(r => !LOW.includes(r.cls))
    if (low.length) {
      // Tag und "otherwise" ueber alle Runden nach Niederlage, nicht nur die Spar-Runden
      const [c, n] = countBy(low, r => r.cls)[0], hit = low.filter(r => r.cls === c), rest = after.filter(r => r.cls !== c)
      lines.push({ icon: 'deagle', text: `${side}: After a lost round: **${NAME[c as BuyClass]}**${rest.length ? ` · otherwise ${times(rest)}` : ''}`,
        tag: tagOf(n, after.length), refs: refs(hit), stat: { won: won(hit), total: hit.length } })
    } else if (rich.length) lines.push({ icon: 'deagle', text: `${side}: After a lost round they still buy rifles: ${times(rich)}`, tag: tagOf(rich.length, after.length), refs: refs(rich) })

    // 'first force': was nach verlorenem Pistol in Runde 2 und 3 gekauft wird (Runde 2 nach Waffen statt 'second')
    const firsts = of('pistol').filter(r => !r.x.won && r.m.rounds[r.i + 2]?.teamOnSide[side] === r.m.rounds[r.i].teamOnSide[side]).map(r => {
      const r2 = r.m.rounds[r.i + 1]
      return { r, key: `${weaponClass(r2, side)}|${buyClass(r.m, r.m.rounds[r.i + 2], side)}`, ref: { matchId: r.m.id, round: r2.num, tick: r2.freezeEndTick } }
    })
    if (firsts.length) {
      const [key, n] = countBy(firsts, f => f.key)[0], [c2, c3] = key.split('|') as BuyClass[]
      lines.push({ icon: 'bolt', text: `${side}: Lost pistol → 2nd round **${NAME[c2]}** → 3rd round **${NAME[c3]}**`, tag: tagOf(n, firsts.length), refs: firsts.filter(f => f.key === key).map(f => f.ref) })
    }
  }
  return lines
}
