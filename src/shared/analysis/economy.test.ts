// Buy-Klassen und Wirtschafts-Zeilen. Teil 1 synthetisch; Teil 2 gegen scripts/analysis-gt/buy.json, wenn CSDA_GT_CACHE auf einen Ordner
// mit den geparsten MatchData-JSONs zeigt (Spike erkennung/cache: dust2.json, mirage.json, z1.json), sonst uebersprungen.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { BuyType, MatchData, PlayerTrack, Round, Side } from '../model.ts'
import { buyClass, economyLines } from './economy.ts'
import type { CTRound, TRound } from './rounds.ts'

const N = 336 // Frames bis gut 20 s nach Freezetime-Ende (16 pro s)
function p(side: Side, inventory: string[], equipValue: number, late = 0): PlayerTrack {
  const fill = (v: number) => Array<number>(N).fill(v)
  return { steamid: side, side, x: [], y: [], z: [], yaw: [], hp: fill(100), armor: [], weapon: fill(late ? 1 : 0), place: [], flash: [],
    money: fill(5000).map((v, f) => (f ? v - late : v)), defuser: false, helmet: false, equipValue, inventory }
}
const five = (inv: string[], e: number) => Array.from({ length: 5 }, () => p('T', inv, e))
function round(num: number, T: PlayerTrack[], buy: BuyType = 'full', winner: Side = 'CT'): Round {
  return { num, buy: { T: buy, CT: 'full' }, tracks: T, weapons: ['Glock-18', 'M4A1-S'], frameTicks: Array.from({ length: N }, (_, f) => f * 4),
    freezeEndTick: 0, teamOnSide: { T: 'them', CT: 'us' }, winner } as unknown as Round
}
const cls = (T: PlayerTrack[], buy?: BuyType) => { const r = round(5, T, buy); return buyClass({ rounds: [r] } as MatchData, r, 'T') }

describe('buyClass (synthetisch)', () => {
  it('pistol, second', () => {
    const r1 = round(1, five(['Glock-18'], 850), 'pistol'), r2 = round(2, five(['Glock-18', 'AK-47'], 5000))
    const m = { rounds: [r1, r2] } as MatchData
    expect(buyClass(m, r1, 'T')).toBe('pistol')
    expect(buyClass(m, r2, 'T')).toBe('second')
  })
  it('full / light / smg nach Waffen und Team-Wert', () => {
    expect(cls(five(['Glock-18', 'AK-47'], 5000))).toBe('full')
    expect(cls(five(['Glock-18', 'Galil AR'], 3800))).toBe('light')
    expect(cls([...five(['MAC-10'], 3000).slice(1), p('T', ['AK-47'], 4000)])).toBe('smg')
  })
  it('deagle vs eco: Wert der Spieler ohne Gewehr', () => {
    expect(cls(five(['Desert Eagle'], 1400))).toBe('deagle')
    expect(cls(five(['Glock-18'], 200))).toBe('eco')
    // 2 gerettete Gewehre, 3 sparen → eco
    expect(cls([p('T', ['AK-47'], 5600), p('T', ['M4A1-S'], 5800), ...five(['USP-S'], 200).slice(2)])).toBe('eco')
  })
  it('Spaetkauf nach dem Inventar-Schnappschuss zaehlt', () => {
    const four = five(['AK-47'], 3800).slice(1)
    expect(cls([...four, p('T', ['USP-S'], 200, 4600)])).toBe('full')
    expect(cls([...four, p('T', ['USP-S'], 200)])).toBe('light')
  })
  it('leeres Inventar → Parser-Klasse', () => {
    expect(cls(five([], 3000), 'force')).toBe('light')
    expect(cls(five([], 200), 'eco')).toBe('eco')
  })
})

describe('economyLines (synthetisch)', () => {
  it('Deagles nach Niederlage, kein Full-Save, erster Kauf nach verlorenem Pistol', () => {
    const rs = [
      round(1, five(['Glock-18'], 850), 'pistol', 'CT'), round(2, five(['Glock-18'], 200), 'eco', 'CT'), round(3, five(['AK-47'], 3800), 'force', 'CT'),
      round(4, five(['Desert Eagle'], 1400), 'force', 'T'), round(5, five(['AK-47'], 5000), 'full', 'CT'), round(6, five(['Desert Eagle'], 1400), 'force', 'CT'),
    ]
    const m = { id: 'm', rounds: rs } as MatchData
    const ours = rs.map(r => ({ kind: 'T', matchId: 'm', round: r.num, won: r.winner === 'T', ref: { matchId: 'm', round: r.num, tick: 0 } }) as TRound)
    const lines = economyLines([{ match: m, team: 'them' }], ours)
    expect(lines.map(l => l.text)).toEqual([
      'T: full buy 0/1 · light buy 0/1 · Deagle force 1/2 · 2nd round 0/1 · pistol 0/1',
      'T: No full save in 6 rounds.',
      'T: After a lost round: **Deagle force** · otherwise light buy 1×',
      'T: Lost pistol → 2nd round **eco** → 3rd round **light buy**',
    ])
    expect(lines[2].tag).toEqual({ kind: 'PATTERN', n: 2, N: 3 }) // N = alle Runden nach Niederlage (R3 light, R4, R6)
    expect(lines[2].refs.map(r => r.round)).toEqual([4, 6])
  })
})

const DIR = process.env.CSDA_GT_CACHE
interface GtMatch { id: string; map: string; cache: string; rounds: Record<string, Record<Side, string>> }
const GT = JSON.parse(readFileSync(new URL('../../../scripts/analysis-gt/buy.json', import.meta.url), 'utf8')).matches as GtMatch[]
const matches = DIR ? GT.map(g => ({ g, m: JSON.parse(readFileSync(`${DIR}/${g.cache}`, 'utf8')) as MatchData })) : []
const roundsOf = (m: MatchData, team: string) => m.rounds.map(r => {
  const kind: Side = r.teamOnSide.CT === team ? 'CT' : 'T'
  return { kind, matchId: m.id, round: r.num, won: r.winner === kind, ref: { matchId: m.id, round: r.num, tick: r.freezeEndTick } } as TRound | CTRound
})

describe.skipIf(!DIR)('buy.json (echte Demos)', () => {
  it('>= 95 % der 140 Team-Runden', () => {
    const miss: string[] = []
    let n = 0
    for (const { g, m } of matches) for (const r of m.rounds) for (const side of ['T', 'CT'] as const) {
      n++
      const got = buyClass(m, r, side)
      if (got !== g.rounds[r.num][side]) miss.push(`${g.map} R${r.num} ${side}: ${g.rounds[r.num][side]} → ${got}`)
    }
    expect(n).toBe(140)
    expect(n - miss.length, miss.join('\n')).toBeGreaterThanOrEqual(133)
  })
  it('Dust2 Derdummbadss: R2/R14 second, R3 + R9 light, R4/R6/R10 deagle', () => {
    const m = matches.find(x => x.g.map === 'de_dust2')!.m
    const side = (n: number) => (m.rounds[n - 1].teamOnSide.CT === 'Derdummbadss' ? 'CT' : 'T')
    const c = (n: number) => buyClass(m, m.rounds[n - 1], side(n))
    expect([2, 14, 3, 9, 4, 6, 10].map(c)).toEqual(['second', 'second', 'light', 'light', 'deagle', 'deagle', 'deagle'])
  })
  it('economyLines Dust2: kein Full-Save, Deagles nach Niederlage [3/7]', () => {
    const m = matches.find(x => x.g.map === 'de_dust2')!.m
    const lines = economyLines([{ match: m, team: 'Derdummbadss' }], roundsOf(m, 'Derdummbadss'))
    expect(lines.some(l => l.text.includes('No full save in 12 rounds'))).toBe(true)
    const deagle = lines.find(l => l.text.startsWith('CT: After a lost round: **Deagle force**'))
    expect(deagle?.tag).toEqual({ kind: 'HABIT', n: 3, N: 7 }) // R3 R9 light, R7 R11 full
    expect(deagle?.refs.map(r => r.round)).toEqual([4, 6, 10])
  })
  it('< 5 ms pro Demo (beide Teams)', () => {
    for (const { m } of matches) {
      const t0 = performance.now()
      for (const team of m.teams) economyLines([{ match: m, team }], roundsOf(m, team))
      expect(performance.now() - t0).toBeLessThan(5)
    }
  })
})
