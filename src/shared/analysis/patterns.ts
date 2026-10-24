// Muster-Suche ueber Runden: Util-Signatur = gleiche Granate (Klasse) aufs gleiche Ziel zur gleichen Uhr in vielen Runden.
// Regel (plan P5): Klasse smoke | molly/HE | flash + Lineup-Name/Callout + Uhr ± 3 s, verschiedene Runden zaehlen, Zeile ab 3 Runden.
import type { Side } from '../model.ts'
import type { Ref } from './rounds.ts'
import type { IconToken, Util, UtilRow } from './types.ts'
import { countBy, tagOf } from './util.ts'

const CLASS: Record<Util['type'], string> = { smoke: 'smoke', molotov: 'fire', he: 'fire', flash: 'flash' }
const ICON: Record<Util['type'], IconToken> = { smoke: 'smoke', molotov: 'molly', he: 'he', flash: 'flash' }
const WIN = 3 // ± s um den Anker
const MAX_ROWS = 8

/** Ziel = Lineup-Name ohne Typ-Wort ("Upper Tunnels molly" → "Upper Tunnels"), sonst Lande-Callout */
export const targetOf = (u: Util) => u.name.replace(/ (smoke|molly|flash|HE)$/, '') || u.to

type Throw = { u: Util; i: number } // i = Index der Runde
const spanOf = (ts: Throw[]) => (ts.length ? Math.max(...ts.map(t => t.u.sec)) - Math.min(...ts.map(t => t.u.sec)) : Infinity)
const roundsOf = (ts: Throw[]) => [...new Set(ts.map(t => t.i))].sort((a, b) => a - b)

/**
 * Util-Signatur einer Seite. Werfer: Anzeigename (name), oder die Rolle (role, z. B. Laufweg beim Wurf → "B site player"),
 * wenn eine Rolle mehr Runden deckt als der haeufigste Spieler. Ohne name/role bleiben Steam-IDs.
 */
export function utilSignature(rounds: { util: Util[]; ref: Ref }[], side: Side,
  name: (id: string) => string = id => id, role?: (u: Util, ref: Ref) => string): UtilRow[] {
  const groups = new Map<string, Throw[]>()
  rounds.forEach((r, i) => {
    for (const u of r.util) if (u.side === side) {
      const k = `${CLASS[u.type]}|${targetOf(u)}`
      groups.set(k, [...(groups.get(k) ?? []), { u, i }])
    }
  })
  // je Klasse + Ziel: Anker mit den meisten Runden in ± WIN s (Gleichstand: kleinste Spanne), herausnehmen, wiederholen
  let rows: { target: string; ts: Throw[] }[] = []
  for (const [k, list] of groups) {
    let rest = [...list].sort((a, b) => a.u.sec - b.u.sec)
    for (;;) {
      let best: Throw[] = [], bestN = 0
      for (const a of rest) {
        const w = rest.filter(x => Math.abs(x.u.sec - a.u.sec) <= WIN), n = roundsOf(w).length
        if (n > bestN || (n === bestN && spanOf(w) < spanOf(best))) { best = w; bestN = n }
      }
      if (bestN < 2) break
      rows.push({ target: k.slice(k.indexOf('|') + 1), ts: best })
      rest = rest.filter(x => !best.includes(x))
    }
  }
  // gleiches Ziel + ueberlappende Uhr → eine Zeile (Dust2 Upper Tunnels: je nach Runde Smoke oder Molly zur selben Zeit)
  const lo = (ts: Throw[]) => Math.min(...ts.map(t => t.u.sec)), hi = (ts: Throw[]) => Math.max(...ts.map(t => t.u.sec))
  for (let merged = true; merged;) {
    merged = false
    for (let a = 0; a < rows.length && !merged; a++) for (let b = a + 1; b < rows.length && !merged; b++) {
      const x = rows[a], y = rows[b]
      if (x.target !== y.target || lo(x.ts) > hi(y.ts) || lo(y.ts) > hi(x.ts)) continue
      rows = [...rows.filter(r => r !== x && r !== y), { target: x.target, ts: [...x.ts, ...y.ts] }]
      merged = true
    }
  }
  const out = rows.map(({ target, ts }): UtilRow => {
    const idx = roundsOf(ts)
    const first = idx.map(i => ts.filter(t => t.i === i).sort((a, b) => a.u.sec - b.u.sec)[0])
    const names = countBy(first, t => name(t.u.thrower)), roles = role ? countBy(first, t => role(t.u, rounds[t.i].ref)) : []
    return {
      fromSec: lo(ts), toSec: hi(ts), nade: countBy(first, t => ICON[t.u.type]).map(([n]) => n as IconToken), target,
      throwers: roles[0] && roles[0][1] > names[0][1] ? [`${roles[0][0]} player`] : names.slice(0, 3).map(([n]) => n),
      tag: tagOf(idx.length, rounds.length), refs: idx.map(i => rounds[i].ref),
    }
  })
  return out.filter(r => r.tag.n >= 3).sort((a, b) => b.tag.n - a.tag.n || a.fromSec - b.fromSec).slice(0, MAX_ROWS).sort((a, b) => a.fromSec - b.fromSec)
}
