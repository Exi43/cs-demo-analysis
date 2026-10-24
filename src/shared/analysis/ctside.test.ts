// CT-Seite: Util-Signatur synthetisch; mit CSDA_GT_CACHE (Ordner mit dust2.json, mirage.json, z1.json aus Spike erkennung/cache)
// zusaetzlich die Abnahme aus plan.json P5 gegen Dust2 Derdummbadss (methodik/beispiel-dust2.md) und Laufzeit auf allen Demos.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MatchData } from '../model.ts'
import { ctReport, openingLine, tradeLine } from './ctside.ts'
import { buildGeo } from './geo.ts'
import { utilSignature } from './patterns.ts'
import { classifyCT, classifyT, teamSide, type CTRound, type Ref, type TRound } from './rounds.ts'
import type { Util } from './types.ts'

const ref = (round: number): Ref => ({ matchId: 'm', round, tick: 0 })
const u = (type: Util['type'], name: string, sec: number, thrower = 'a'): Util =>
  ({ thrower, side: 'CT', type, sec, from: '', to: name, lane: '', name: `${name} ${type === 'molotov' ? 'molly' : type === 'he' ? 'HE' : type}`, named: true, land: [0, 0, 0] })

describe('utilSignature (synthetisch)', () => {
  it('Klasse + Ziel + Uhr ± 3 s, verschiedene Runden, Zeile ab 3 Runden', () => {
    const rows = utilSignature([
      { ref: ref(1), util: [u('smoke', 'Window', 5), u('smoke', 'Window', 6)] }, // 2 Smokes in einer Runde zaehlen einmal
      { ref: ref(2), util: [u('smoke', 'Window', 7)] },
      { ref: ref(3), util: [u('smoke', 'Window', 30), u('flash', 'Window', 6)] }, // anderes Timing / andere Klasse
      { ref: ref(4), util: [u('smoke', 'Window', 8, 'b')] },
    ], 'CT')
    expect(rows).toEqual([{ fromSec: 5, toSec: 8, nade: ['smoke'], target: 'Window', throwers: ['a', 'b'], tag: { kind: 'HABIT', n: 3, N: 4 }, refs: [ref(1), ref(2), ref(4)] }])
  })
  it('gleiches Ziel + ueberlappende Uhr: Smoke- und Molly-Runden werden eine Zeile; Rolle schlaegt Namen', () => {
    const rows = utilSignature([
      { ref: ref(1), util: [u('smoke', 'Tunnels', 6, 'a')] }, { ref: ref(2), util: [u('smoke', 'Tunnels', 7, 'b')] },
      { ref: ref(3), util: [u('molotov', 'Tunnels', 7, 'c')] }, { ref: ref(4), util: [u('molotov', 'Tunnels', 8, 'a')] },
    ], 'CT', id => id.toUpperCase(), () => 'B site')
    expect(rows.map(r => [r.target, r.tag.n, r.throwers, r.nade])).toEqual([['Tunnels', 4, ['B site player'], ['smoke', 'molly']]])
  })
  it('andere Seite und < 3 Runden: keine Zeile', () => {
    expect(utilSignature([{ ref: ref(1), util: [u('smoke', 'X', 5)] }, { ref: ref(2), util: [u('smoke', 'X', 5)] }], 'CT')).toEqual([])
    expect(utilSignature([1, 2, 3].map(i => ({ ref: ref(i), util: [u('smoke', 'X', 5)] })), 'T')).toEqual([])
  })
})

const DIR = process.env.CSDA_GT_CACHE ?? ''
const load = (f: string): MatchData | undefined => (DIR && existsSync(join(DIR, f)) ? JSON.parse(readFileSync(join(DIR, f), 'utf8')) : undefined)
const dust2 = load('dust2.json')

function report(m: MatchData, team: string) {
  const geo = buildGeo([m]), ct: CTRound[] = [], opp: TRound[] = []
  for (const r of m.rounds) if (teamSide(r, team) === 'CT') { const tr = classifyT(m, r, r.teamOnSide.T, geo); opp.push(tr); ct.push(classifyCT(m, r, team, geo, tr)) }
  const e = [{ match: m, team }]
  return { c: ctReport(e, ct, opp, geo), e }
}

describe.skipIf(!dust2)('ctReport (echte Demos, CSDA_GT_CACHE)', () => {
  // Body laeuft beim Einsammeln auch bei Skip: ohne Cache kein report()
  const { c, e } = dust2 ? report(dust2, 'Derdummbadss') : ({} as ReturnType<typeof report>)
  const rounds = (rs: Ref[]) => rs.map(r => r.round)
  it('Dust2 Util-Signatur: Upper Tunnels 1:48–1:45 [8/12 ± 1], Long Doors ab 1:47 [7/12 ± 1]', () => {
    const up = c.utilSignature.find(r => r.target === 'Upper Tunnels')!, ld = c.utilSignature.find(r => r.target === 'Long Doors')!
    expect(Math.abs(up.tag.n - 8)).toBeLessThanOrEqual(1)
    expect([Math.floor(up.fromSec), Math.floor(up.toSec)]).toEqual([6, 9]) // 1:48–1:45
    expect(up.throwers).toEqual(['B site player'])
    expect(Math.abs(ld.tag.n - 7)).toBeLessThanOrEqual(1)
    expect(Math.floor(ld.fromSec)).toBe(7) // 1:47
  })
  it('Opening exakt (CT 0/7 und 3/5, T 2/4 und 3/5), Trades 5/82 vs. 18/73', () => {
    expect(c.overview[0].text).toBe('Opening duel won 5/12 → round won 3/5. Opening lost → **0/7**')
    expect(c.overview[0].stat).toEqual({ won: 0, total: 7 })
    expect(openingLine(e, 'T')!.text).toBe('Opening duel won 5/9 → round won 3/5. Opening lost → **2/4**')
    expect(openingLine(e, 'T')!.tag).toBeUndefined() // n = 4 < 5: kein Key-Kandidat
    expect(tradeLine(e)!.text).toBe('They trade **6 %** of their deaths [5/82] · we trade 25 % [18/73]')
  })
  it('Spots nur bei 1:40: kein fester Spieler (wie beispiel-dust2.md), B ohne festen Spieler mit Zaehlung', () => {
    // bei 1:45 auf A Long / Mid Doors, bei 1:40 Under A / B Doors (R9 R12) zaehlt nicht als Halten
    expect(c.spots.filter(l => l.text.includes(' holds ')).map(l => l.text)).toEqual([])
    expect(c.spots.map(l => l.text)).toContain('No fixed **B** player: stakson 4×, sk1nnex 3×, DiiiDiii 3×, Criminal_Boy 3×, Derdummbadss 2×')
    expect(c.setups.find(l => l.text === 'At 1:40 **1–2 on B**')!.tag!.n).toBe(12)
  })
  it('AWP A Long [3/5], Mid Doors [2/5]; Push oder forward in >= 9/12 Runden', () => {
    const awp = (p: string) => c.awp.find(l => l.text.startsWith(`**${p}**`))!.tag
    expect(awp('A Long')).toMatchObject({ n: 3, N: 5 })
    expect(awp('Mid Doors')).toMatchObject({ n: 2, N: 5 })
    const pushed = new Set(c.pushes.flatMap(p => rounds(p.refs)))
    expect(pushed.size).toBeGreaterThanOrEqual(9)
    for (const r of [3, 9, 11, 12]) expect(pushed, `R${r}`).toContain(r) // forward laut groundtruth-ct.json
    // Kills zaehlen, solange er dort bleibt: R11 sk1nnex 3 Kills auf Catwalk (21/23/27 s)
    expect(c.pushes.find(p => p.level === 'forward' && p.place.startsWith('Catwalk'))!.kills).toBeGreaterThanOrEqual(3)
  })
  it('Retakes nur Versuche: 2/8 (A 2/6, B 0/2), gestaffelt R8 R9 R10, Held DiiiDiii', () => {
    expect(c.retakes.map(l => l.text)).toEqual([
      'Retakes **2/8** (A 2/6, B 0/2)', 'Retakers come one at a time: deaths 3–14 s apart', 'Retake wins: **DiiiDiii** 2/2',
    ])
    expect(rounds(c.retakes[1].refs)).toEqual([8, 9, 10])
    expect(c.pistol.map(b => rounds(b.refs))).toEqual([[1]])
    expect(rounds(c.second!.refs)).toEqual([2, 3])
    expect(c.forces.map(b => b.title)).toEqual(['Deagle forces · 1/3'])
  })
  // Laufzeit (ctReport <= 30 ms) prüft scripts/eval-analysis.ts am Median; hier liefe sie parallel zu anderen Tests
  it('alle Demos und Teams: jede Zeile mit Beleg', () => {
    for (const m of [dust2!, load('mirage.json'), load('z1.json')].filter((x): x is MatchData => !!x)) for (const team of m.teams) {
      const { c } = report(m, team)
      for (const l of [...c.overview, ...c.setups, ...c.spots, ...c.awp, ...c.rotations, ...c.retakes]) expect(l.refs.length || /\[\d+\/\d+\]/.test(l.text), l.text).toBeTruthy()
      for (const r of c.utilSignature) expect(r.tag.n).toBeGreaterThanOrEqual(3)
    }
  })
})
