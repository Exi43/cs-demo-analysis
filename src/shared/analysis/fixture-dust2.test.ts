// Prueft, dass das handgebaute Dust2-Fixture in sich stimmig ist (P6/P7 bauen dagegen).
import { describe, expect, it } from 'vitest'
import { DUST2_FIXTURE as F, DUST2_MATCH } from './fixture-dust2.ts'
import type { Ref } from './rounds.ts'
import type { IconToken, Tag } from './types.ts'
import { tagOf } from './util.ts'

const ICONS: IconToken[] = ['smoke', 'flash', 'molly', 'he', 'awp', 'deagle', 'c4', 'kit', 'knife', 'target', 'arrow', 'shuffle', 'layers', 'clock', 'bolt', 'star', 'check', 'x', 'warn']
const refs: Ref[] = [], tags: Tag[] = [], texts: string[] = []
const walk = (v: unknown): void => {
  if (typeof v === 'string') texts.push(v)
  else if (Array.isArray(v)) v.forEach(walk)
  else if (v && typeof v === 'object') {
    if ('matchId' in v) refs.push(v as Ref)
    else if ('kind' in v && 'N' in v) tags.push(v as Tag)
    Object.values(v).forEach(walk)
  }
}
walk(F)

describe('fixture-dust2', () => {
  it('refs zeigen auf Runden des Matches', () => {
    expect(refs.length).toBeGreaterThan(100)
    for (const r of refs) expect(r.matchId === DUST2_MATCH && r.round >= 1 && r.round <= 21 && r.tick > 0).toBe(true)
  })
  it('Tags passen zu n/N', () => {
    for (const t of tags) { expect(t.kind).toBe(tagOf(t.n, t.N).kind); expect(t.n).toBeLessThanOrEqual(t.N) }
  })
  it('nur bekannte :icon:-Tokens', () => {
    const used = texts.flatMap(s => [...s.matchAll(/:([a-z]+):/g)].map(m => m[1]))
    expect(used.length).toBeGreaterThan(50)
    expect(used.filter(u => !ICONS.includes(u as IconToken))).toEqual([])
  })
  it('Rundenliste und Seiten-Bilanz stimmen', () => {
    expect(F.roundList.map(r => r.ref.round)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1))
    for (const side of ['T', 'CT'] as const) {
      const rs = F.roundList.filter(r => r.side === side)
      expect({ won: rs.filter(r => r.won).length, total: rs.length }).toEqual(F.sides[side])
    }
    expect(F.rounds).toBe(21)
  })
  it('Spielzuege, Heatmap, Keys, Roster', () => {
    for (const p of F.t.plays) { expect(p.buys.length).toBe(p.refs.length); expect(p.total).toBe(p.refs.length); expect(p.won).toBeLessThanOrEqual(p.total) }
    for (const row of F.t.heatmap.rows) expect(row.cells.length).toBe(F.t.heatmap.buckets.length)
    expect(F.keys).toHaveLength(3)
    for (const p of F.roster) expect(F.names[p.steamid]).toBe(p.name)
  })
})
