// Anti-Strat: Keys-Ranking und Text-Export gegen das Dust2-Fixture; mit CSDA_GT_CACHE (Ordner mit dust2.json, z2.json, mirage.json, z1.json
// aus Spike erkennung/cache) zusaetzlich echte Demos: alle Abschnitte, keine Zeile ohne Beleg, <= 250 Zeilen, Duplikat-Demo, Laufzeit.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MatchData } from '../model.ts'
import { buildAntiStrat, keyScore, linesIn, rankKeys } from './antistrat.ts'
import { toMarkdown } from './antistrat-text.ts'
import { DUST2_FIXTURE as F } from './fixture-dust2.ts'
import { tagOf } from './util.ts'

const SECTIONS = ['# Anti-strat', '## :star: Keys', '## Roster', '## T side', '## CT side', '## Economy', '## What worked for us', '## Game plan', '## Round list', '## Limits']
/** Befund-Zeilen (Keys bis Rundenliste) ohne Tag [n/N] und ohne Runden-Ref */
const bare = (md: string) => md.slice(md.indexOf('## :star: Keys'), md.indexOf('## Limits')).split('\n')
  .filter(l => /^(- |\d+\. |:|\*\*Counter)/.test(l) && !/\[\d+\/\d+\]/.test(l) && !/\bR\d+\b/.test(l))

describe('Keys-Ranking', () => {
  it('waehlt mit Fixture-Eingaben Opening 0/7, Retakes, AWP Top Mid', () => {
    const pool = linesIn([F.t, F.ct, F.economy, F.worked, F.keys]).reverse()
    expect(rankKeys(pool, 8 / 21).map(l => l.text)).toEqual(F.keys.map(l => l.text))
  })
  it('Score = n × Abstand zur Gesamtquote × Gewicht; ohne stat oder ohne Abstand kein Key', () => {
    const l = (n: number, N: number, won: number, total: number) => ({ text: `${n}/${N}`, refs: [], tag: tagOf(n, N), stat: { won, total } })
    expect(keyScore(l(4, 8, 0, 4), 0.5)).toBeCloseTo(2)
    expect(keyScore(l(2, 8, 0, 2), 0.5)).toBeCloseTo(0.6)
    expect(keyScore({ text: 'x', refs: [], tag: tagOf(5, 5) }, 0.5)).toBe(0)
    expect(rankKeys([l(6, 6, 3, 6), l(1, 6, 1, 1)], 0.5).map(k => k.text)).toEqual(['1/6'])
  })
  it('Zeilen mit Konter zuerst, ohne Konter nur zum Auffuellen', () => {
    const l = (n: number, counter?: string) => ({ text: `${n}/6`, refs: [], tag: tagOf(n, 6), stat: { won: 0, total: n }, counter })
    expect(rankKeys([l(6), l(2, 'x'), l(5), l(4)], 0.5).map(k => k.text)).toEqual(['2/6', '6/6', '5/6'])
  })
})

describe('toMarkdown (Fixture)', () => {
  const md = toMarkdown(F)
  it('alle Abschnitte, Spielzuege, Tabellen, <= 250 Zeilen', () => {
    for (const s of SECTIONS) expect(md).toContain(s)
    expect(md).toContain('### T1 · Xbox → short A · 2/3 · **HABIT** [3/9] (R14 :check: 2nd · R18 :x: full · R20 :check: light)')
    expect(md).toContain('| T3 B | ■ R21 |  | ■■ R13 R16 |')
    expect(md).toContain('| 1:48–1:45 | :molly:/:smoke: | upper tunnel | B player | **HABIT** [8/12] R1 R5 R7 R8 R9 R10 R11 R12 |')
    expect(md.split('\n').length).toBeLessThanOrEqual(250)
  })
})

const DIR = process.env.CSDA_GT_CACHE ?? ''
const load = (f: string): MatchData | undefined => (DIR && existsSync(join(DIR, f)) ? JSON.parse(readFileSync(join(DIR, f), 'utf8')) : undefined)
const dust2 = load('dust2.json')

describe.skipIf(!dust2)('buildAntiStrat (echte Demos, CSDA_GT_CACHE)', () => {
  const games = [dust2!, load('z2.json'), load('mirage.json'), load('z1.json')].filter((m): m is MatchData => !!m)
  // Laufzeit (buildAntiStrat <= 150 ms) prüft scripts/eval-analysis.ts am Median; hier liefe sie parallel zu anderen Tests
  it('je Team: alle Abschnitte, 0 Zeilen ohne Beleg, <= 250 Zeilen', () => {
    for (const m of games) for (const team of m.teams) {
      const a = buildAntiStrat([{ match: m, team }]), md = toMarkdown(a)
      for (const s of SECTIONS) expect(md, `${m.map} ${team}`).toContain(s)
      expect(bare(md), `${m.map} ${team}`).toEqual([])
      expect(md.split('\n').length).toBeLessThanOrEqual(250)
      expect(a.roundList.length).toBe(m.rounds.length)
      expect(a.sides.T.won + a.sides.CT.won).toBe(m.finalScore[team])
      // Gameplan: gleiche Beleg-Runden = ein Konter
      for (const g of [a.gameplan.ourT, a.gameplan.ourCT]) { const sig = g.filter(l => l.refs.length).map(l => l.refs.map(r => r.round).sort().join()); expect(new Set(sig).size, `${m.map} ${team}`).toBe(sig.length) }
    }
  })
  it('dieselbe Demo zweimal (user-demo + FACEIT-Download) ergibt denselben Text', () => {
    const z2 = load('z2.json')
    if (!z2) return
    const one = toMarkdown(buildAntiStrat([{ match: dust2!, team: 'Derdummbadss' }]))
    expect(toMarkdown(buildAntiStrat([{ match: dust2!, team: 'Derdummbadss' }, { match: z2, team: 'Derdummbadss' }]))).toBe(one)
  })
  it('Dust2 Derdummbadss: Gegner-Sicht wie beispiel-dust2.md', () => {
    const a = buildAntiStrat([{ match: dust2!, team: 'Derdummbadss' }])
    expect(a.worked.map(l => l.text)).toEqual(expect.arrayContaining([
      '**A** plants 6, we won 4 · plant 0:57–0:22', expect.stringContaining('Opening picks on **Mid Doors** (their CT): Criminal_Boy ×2'),
    ]))
    expect(a.keys).toHaveLength(3)
    expect(a.roster.find(p => p.name === 'DiiiDiii')!.t).toContain(':c4: A [2/3]')
  })
})
