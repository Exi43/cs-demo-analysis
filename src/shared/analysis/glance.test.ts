// At a glance (Sicht unser Team): synthetische Runden für Vorteil verspielt, Opening ungetradet, Konversion, Rundentypen, Ampel;
// mit CSDA_GT_CACHE zusätzlich echte Demos (alle 7 Karten, Bilanz = Endstand).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Kill, MatchData, Round, Side } from '../model.ts'
import { rankKeys } from './antistrat.ts'
import { advantageCard, cards, deathsOf, economyRows, goals, openingCard, ourTeam, prepare, roundInfos, roundTypesCard, sidesOf, tradesCard, winType, type Prepared, type RoundData } from './glance.ts'
import { LIMITS, light, worst } from './lights.ts'
import type { BuyClass } from './types.ts'
import { tagOf } from './util.ts'

const US = ['u1', 'u2', 'u3', 'u4', 'u5'], THEM = ['t1', 't2', 't3', 't4', 't5']
/** Kill: [Täter, Opfer, Sekunde, getradet] */
type K = [string | undefined, string, number, boolean?]
const M = { id: 'm' } as MatchData
function rd(num: number, ks: K[], winner: Side, buyUs: BuyClass = 'full', buyThem: BuyClass = 'full'): RoundData {
  const kills = ks.map(([attacker, victim, s, traded]) => ({ attacker, victim, tick: s * 64, traded: !!traded }) as Kill)
  const r = { num, freezeEndTick: 0, endTick: 200 * 64, winner, reason: 'ct_killed', teamOnSide: { CT: 'us', T: 'them' }, kills,
    tracks: [...US.map(steamid => ({ steamid, side: 'CT' })), ...THEM.map(steamid => ({ steamid, side: 'T' }))] } as unknown as Round
  return { m: M, r, side: 'CT', won: winner === 'CT', buyUs, buyThem, ours: new Set(US), deaths: deathsOf(r, 'CT') }
}
const P = (rounds: RoundData[]): Prepared => ({ us: 'us', them: 'them', entries: [], rounds, names: { u1: 'Exi', t1: 'Foe' } })

describe('Vorteil verspielt', () => {
  it('5v4 verloren zählt, Gegner-Überzahl nicht; schlimmste Runde zuerst', () => {
    const p = P([
      rd(1, [['u1', 't1', 10], ['t2', 'u1', 20], ['t2', 'u2', 30], ['t2', 'u3', 40], ['t2', 'u4', 50], ['t2', 'u5', 60]], 'T'), // 5v4 verloren
      rd(2, [['u1', 't1', 10], ['u1', 't2', 12], ['t3', 'u1', 20], ['t3', 'u2', 30], ['t3', 'u3', 40], ['t3', 'u4', 50], ['t3', 'u5', 60]], 'T'), // 5v3 verloren
      rd(3, [['t1', 'u1', 10], ['t1', 'u2', 12]], 'T'), // nie in Überzahl
      rd(4, [['u1', 't1', 10], ['u1', 't2', 11], ['u1', 't3', 12], ['u1', 't4', 13], ['u1', 't5', 14]], 'CT'), // Überzahl gewonnen
    ])
    const c = advantageCard(p)
    expect(c.value).toBe('2/3')
    expect(c.rounds.map(r => [r.ref.round, r.why])).toEqual([[2, 'Lost a 5v3'], [1, 'Lost a 5v4']])
    expect(c.light).toBe(light(67, LIMITS.advantage)) // 2/3 = 67 % → rot
    expect(c.light).toBe('bad')
    // Spieler-Filter: u1 stirbt in R1 und R2 nach der ersten Überzahl; u5 stirbt nur in R1/R2, hat aber die Überzahl erlebt
    expect(advantageCard(p, 'u1').value).toBe('2/3')
    expect(advantageCard(p, 't1').value).toBe('0/0') // kein Spieler von uns
  })
})

describe('Trades', () => {
  it('Opening ungetradet extra; Tod als Letzter zählt nicht', () => {
    const c = tradesCard(P([
      rd(1, [['t1', 'u1', 5], ['u2', 't1', 7], ['t2', 'u2', 20, true], ['u3', 't2', 22], ['t3', 'u3', 30], ['t3', 'u4', 31], ['t3', 'u5', 32]], 'T'),
    ]))
    // u1 (Opening, ungetradet), u2 (getradet), u3, u4 ungetradet; u5 war der Letzte
    expect(c.value).toBe('75 %')
    expect(c.facts[0]).toEqual({ text: 'Opening death untraded 1/1', tone: 'bad' })
    expect(c.rounds[0].why).toBe('Opening death not traded: Exi')
    expect(c.rounds[0].ref.tick).toBe(5 * 64 - 4 * 64) // 4 s vorher
  })
})

describe('Opening-Konversion', () => {
  it('gewonnen + Runde verloren ist die schlimmste Runde', () => {
    const c = openingCard(P([
      rd(1, [['u1', 't1', 5]], 'T'), // Opening gewonnen, Runde verloren
      rd(2, [['u1', 't1', 5]], 'CT'),
      rd(3, [['t1', 'u2', 5]], 'T'),
      rd(4, [[undefined, 'u3', 2], ['t1', 'u2', 5]], 'CT'), // Welt-Tod ist kein Opening
    ]))
    expect(c.value).toBe('50 %')
    expect(c.facts.map(f => f.text)).toEqual(['CT 2/4', 'Won it → round 1/2', 'Lost it → round 1/2'])
    expect(c.rounds.map(r => [r.ref.round, r.why])).toEqual([[1, 'Won the opening, lost the round'], [3, 'Opening death: ?']])
    expect(c.light).toBe('warn')
  })
})

describe('Rundentypen', () => {
  it('2. Runde nach Pistol-Sieg verloren + Anti-Eco verloren = 2 teure Niederlagen (rot)', () => {
    const c = roundTypesCard(P([rd(1, [], 'CT', 'pistol', 'pistol'), rd(2, [], 'T', 'second', 'second'), rd(3, [], 'T', 'full', 'eco'), rd(4, [], 'CT', 'smg', 'full')]))
    expect(c.value).toBe('2')
    expect(c.light).toBe('bad')
    expect(c.facts).toEqual([{ text: 'Round 2 after pistol lost', tone: 'bad' }, { text: 'Anti-eco lost 1/1', tone: 'bad' }])
    expect(c.text).toBe('Pistols 1/1, anti-ecos lost 1/1, forces won 1/1.')
  })
})

describe('Ampel', () => {
  it('Grenzen wie vorgegeben (Opening >= 55 grün, < 45 rot; ungetradet < 70 grün, > 85 rot)', () => {
    expect([55, 54, 45, 44].map(v => light(v, LIMITS.opening))).toEqual(['good', 'warn', 'warn', 'bad'])
    expect([69, 70, 85, 86].map(v => light(v, LIMITS.untraded))).toEqual(['good', 'warn', 'warn', 'bad'])
    expect([0, 1, 2].map(v => light(v, LIMITS.roundTypes))).toEqual(['good', 'warn', 'bad'])
    expect(worst('good', undefined, 'warn')).toBe('warn')
    expect(worst(undefined)).toBeUndefined()
  })
  it('Ziele: rot vor gelb, max. 3', () => {
    const c = (id: string, l?: 'good' | 'warn' | 'bad') => ({ id, light: l }) as never
    expect(goals([c('a', 'warn'), c('b', 'bad'), c('c'), c('d', 'warn'), c('e', 'bad')]).map((x: { id: string }) => x.id)).toEqual(['b', 'e', 'a'])
  })
  it('unser Team: Team-Mitglieder vor Exi vor erstem Team', () => {
    const m = { teams: ['a', 'b'], players: [{ steamid: '1', name: 'x', team: 'a' }, { steamid: '2', name: 'Exi', team: 'b' }, { steamid: '3', name: 'y', team: 'b' }] } as MatchData
    expect(ourTeam(m, ['1'])).toBe('a')
    expect(ourTeam(m, [])).toBe('b')
    expect(ourTeam({ ...m, players: [] }, [])).toBe('a')
  })
  it('Siegart', () => {
    expect(['bomb_exploded', 'bomb_defused', 'target_saved', 't_killed'].map(winType)).toEqual(['bomb', 'defuse', 'time', 'elim'])
  })
})

describe('Keys ohne Duplikate', () => {
  it('gleiche Befund-Art (T- und CT-Opening) nur einmal, auch mit anderen Runden', () => {
    const ref = (round: number) => ({ matchId: 'm', round, tick: 0 })
    const l = (side: string, refs: number[], n: number) => ({ text: `Opening duel won 9/15 → round won ${n}/9. Opening lost → **0/6**`, refs: refs.map(ref), tag: tagOf(6, 6), stat: { won: 0, total: 6 }, counter: `Win the first duel on their ${side}: after losing it they won 0/6.` })
    const other = { text: 'Retakes **1/7**', refs: [ref(20)], tag: tagOf(6, 7), stat: { won: 1, total: 7 }, counter: 'Plant.' }
    expect(rankKeys([l('T', [1, 2], 6), l('CT', [13, 14], 8), other], 0.5).map(k => k.counter)).toEqual(['Win the first duel on their T: after losing it they won 0/6.', 'Plant.'])
  })
})

const DIR = process.env.CSDA_GT_CACHE ?? ''
const load = (f: string): MatchData | undefined => (DIR && existsSync(join(DIR, f)) ? JSON.parse(readFileSync(join(DIR, f), 'utf8')) : undefined)
const dust2 = load('dust2.json')

describe.skipIf(!dust2)('prepare + Karten (echte Demos, CSDA_GT_CACHE)', () => {
  it('je Team: 7 Karten, Bilanz = Endstand, Chips nur auf eigene Runden, Wirtschaft vollständig', () => {
    for (const m of [dust2!, load('mirage.json'), load('z1.json')].filter((x): x is MatchData => !!x)) for (const team of m.teams) {
      const t0 = performance.now(), p = prepare([{ match: m, team }], m.teams.find(t => t !== team)!), ms = performance.now() - t0
      const s = sidesOf(p), cs = cards(p)
      expect(s.T.won + s.CT.won, `${m.map} ${team}`).toBe(m.finalScore[team])
      expect(cs.map(c => c.id)).toEqual(['opening', 'trades', 'advantage', 'rounds', 't', 'ct', 'util'])
      for (const c of cs) { expect(c.rounds.length).toBeLessThanOrEqual(3); for (const r of c.rounds) expect(r.ref.round).toBeGreaterThan(0) }
      expect(roundInfos(p).at(-1)).toMatchObject({ us: m.finalScore[team] })
      expect(economyRows(p).reduce((a, e) => a + e.us.total, 0)).toBe(m.rounds.length)
      expect(cards(p, p.rounds[0].r.tracks.find(t => t.side === p.rounds[0].side)!.steamid)).toHaveLength(7)
      expect(ms, 'prepare').toBeLessThan(2000)
    }
  })
})
