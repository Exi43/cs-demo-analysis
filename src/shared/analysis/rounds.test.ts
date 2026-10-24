// Runden-Erkennung (classifyT/classifyCT). Teil 1 synthetisch; Teil 2 gegen scripts/analysis-gt/groundtruth-t/ct.json, wenn CSDA_GT_CACHE
// auf den Ordner mit den MatchData-JSONs zeigt (Spike erkennung/cache: dust2.json, mirage.json, z1.json), sonst uebersprungen.
// Laufzeit (classifyRounds <= 80 ms) prüft scripts/eval-analysis.ts am Median; hier liefe sie parallel zu anderen Tests.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { MatchData, PlayerTrack, Round, Side } from '../model.ts'
import { buildGeo } from './geo.ts'
import { classifyCT, classifyRounds, classifyT } from './rounds.ts'

// ---------- synthetisch: Dust2-Places, A-Site (1000,2000), B-Site (-1500,2000), T-Spawn (0,-1000), 16 Frames/s, 60 s ----------
const PLACES = ['TSpawn', 'LongDoors', 'BombsiteA', 'BombsiteB', 'CTSpawn', 'UpperTunnel']
const N = 960
type Pos = (s: number) => [number, number, string]
function track(steamid: string, side: Side, pos: Pos, diesAt = Infinity): PlayerTrack {
  const at = Array.from({ length: N }, (_, f) => pos(f / 16))
  return { steamid, side, x: at.map(p => p[0]), y: at.map(p => p[1]), z: at.map(() => 0), yaw: [], hp: at.map((_, f) => (f / 16 < diesAt ? 100 : 0)), armor: [],
    weapon: at.map(() => 0), place: at.map(p => PLACES.indexOf(p[2])), flash: [], money: [], defuser: false, helmet: false, equipValue: 0, inventory: [] }
}
const still = (x: number, y: number, place: string): Pos => () => [x, y, place]
// T-Spawn → A-Site in 20 s, über Long
const toA: Pos = s => { const k = Math.min(1, s / 20); return [1000 * k, -1000 + 3000 * k, s < 4 ? 'TSpawn' : k > 0.77 ? 'BombsiteA' : 'LongDoors'] }
function round(T: PlayerTrack[], CT: PlayerTrack[]): Round {
  return { num: 1, startTick: 0, freezeEndTick: 0, endTick: N * 4, winner: 'T', reason: 'ct_killed', teamOnSide: { T: 'them', CT: 'us' },
    buy: { T: 'full', CT: 'full' }, frameTicks: Array.from({ length: N }, (_, f) => f * 4), tracks: [...T, ...CT], weapons: ['Glock-18'], places: PLACES,
    kills: [], damages: [], blinds: [], nades: [] } as unknown as Round
}
const cts = () => [track('c1', 'CT', still(-1500, 2000, 'BombsiteB')), track('c2', 'CT', still(-1450, 2050, 'BombsiteB')),
  track('c3', 'CT', still(0, 2500, 'CTSpawn')), track('c4', 'CT', still(50, 2500, 'CTSpawn')), track('c5', 'CT', still(0, -600, 'TSpawn'))]
const rush = round([1, 2, 3, 4].map(i => track(`t${i}`, 'T', toA)).concat(track('lurk', 'T', still(-1500, 0, 'UpperTunnel'))), cts())
const lone = round([track('t1', 'T', toA), ...[2, 3, 4, 5].map(i => track(`t${i}`, 'T', still(0, -1000, 'TSpawn'), 1))], cts())
const match = { id: 'm', map: 'de_dust2', teams: ['them', 'us'], players: [], rounds: [rush, lone] } as unknown as MatchData
const geo = buildGeo([match])

describe('Runden-Erkennung (synthetisch)', () => {
  it('Rush über Long, Lurker in Tunnels', () => {
    const t = classifyT(match, rush, 'them', geo)
    expect(t.site).toBe('A')
    expect(t.tags).toEqual(['rush'])
    expect(t.label).toBe('A rush via A long')
    expect(t.entries.map(e => e.lane)).toEqual(['A long', 'A long', 'A long', 'A long'])
    expect(t.lurkersPro).toEqual(['lurk'])
  })
  it('Hit-Fix: ein einzelner Überlebender auf der Site ist kein Hit', () => {
    const t = classifyT(match, lone, 'them', geo)
    expect(t.site).toBeUndefined()
    expect(t.tags).toEqual(['no hit (A side)'])
    expect(t.entries).toEqual([])
  })
  it('CT: Push in die T-Hälfte, Setup über Lanes', () => {
    const c = classifyCT(match, rush, 'us', geo)
    expect(c.aggression).toEqual([{ id: 'c5', place: expect.any(String), sec: 2, level: 'push', kills: 0, died: false }])
    expect(c.setup15).toBe('B site 2 · CT 2 · T spawn 1')
    expect(classifyRounds(match, 'us', geo).map(x => x.kind)).toEqual(['CT', 'CT'])
  })
})

// ---------- echte Demos gegen die Spike-Labels (Abnahme P3) ----------
const DIR = process.env.CSDA_GT_CACHE
const gt = (f: string) => JSON.parse(readFileSync(new URL(`../../../scripts/analysis-gt/${f}`, import.meta.url), 'utf8'))
const DEMOS = [['dust2', 'dust2.json'], ['mirage', 'mirage.json'], ['ancient', 'z1.json']] as const

describe.skipIf(!DIR)('groundtruth-t/ct.json (echte Demos)', () => {
  const GT = gt('groundtruth-t.json')
  const GC = gt('groundtruth-ct.json')
  const tot: Record<string, [number, number]> = {}
  const add = (k: string, ok: boolean) => { const t = (tot[k] ??= [0, 0]); t[1]++; if (ok) t[0]++ }
  const lurk = { tp: 0, fp: 0 }, push = { tp: 0, fp: 0, fn: 0 }
  for (const [key, file] of DIR ? DEMOS : []) {
    const m = JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8')) as MatchData
    const name = new Map(m.players.map(p => [p.steamid, p.name]))
    const g = buildGeo([m])
    for (const r of m.rounds) {
      const t = classifyT(m, r, r.teamOnSide.T, g), c = classifyCT(m, r, r.teamOnSide.CT, g, t)
      const pos = new Set<string>(GC[key].pos[r.num] ?? []), dc = new Set<string>(GC[key].dc[r.num] ?? [])
      const got = new Set(c.aggression.filter(a => a.level === 'push').map(a => name.get(a.id)!))
      for (const x of got) if (pos.has(x)) push.tp++; else if (!dc.has(x)) push.fp++
      for (const x of pos) if (!got.has(x)) push.fn++
      const gt = GT[key][r.num]; if (!gt) continue
      const cat = new Set(t.tags.flatMap(x => x.startsWith('no hit') || x.startsWith('save') ? ['none'] : ['rush', 'execute', 'split', 'default', 'hit'].includes(x) ? [x] : []))
      const onlyNone = gt.cat.length === 1 && gt.cat[0] === 'none'
      add('plan', [...cat].some(x => gt.cat.includes(x)) && (cat.has('none') === onlyNone || (gt.cat.includes('none') && gt.cat.length > 1)))
      if (gt.site !== '?') add('site', (t.site ?? /\((A|B) side\)/.exec(t.label)?.[1] ?? '-') === gt.site)
      if (gt.fake !== '?') add('fake', t.tags.some(x => x.startsWith('fake')) === (gt.fake === 'yes'))
      if (cat.has('rush')) add('rush', gt.cat.includes('rush'))
      if (cat.has('execute') || gt.cat.includes('execute')) add('execute', cat.has('execute') && gt.cat.includes('execute'))
      if (cat.has('split')) add('split', gt.cat.includes('split'))
      if (t.site || gt.lurk.length) {
        const pl = new Set(t.lurkersPro.map(s => name.get(s)!)), gl = new Set<string>(gt.lurk)
        add('lurk', pl.size === gl.size && [...pl].every(x => gl.has(x)))
        for (const x of pl) gl.has(x) ? lurk.tp++ : lurk.fp++
      }
      if (t.plantInfo) {
        const p = t.plantInfo // plausibel: Ergebnis passt zu Sieger, Entschärfung und lebenden CT
        add('retake', p.retake === 'no-ct' ? p.ctAlive === 0 : p.retake === 'won-defuse' ? !!r.defuse : p.retake === 'won-kills' ? r.winner === 'CT' : r.winner === 'T')
      }
    }
  }
  const n = (k: string) => tot[k]?.[0] ?? 0
  it('T: Plan-Typ >= 67/70, Site >= 61/63, Fake >= 61/63', () => {
    expect(tot.plan).toEqual([expect.any(Number), 70]); expect(n('plan')).toBeGreaterThanOrEqual(67)
    expect(tot.site[1]).toBe(63); expect(n('site')).toBeGreaterThanOrEqual(61)
    expect(tot.fake[1]).toBe(63); expect(n('fake')).toBeGreaterThanOrEqual(61)
  })
  it('Lurker >= 43/54 Runden, Spieler-Präzision >= 75 %', () => {
    expect(tot.lurk[1]).toBe(54); expect(n('lurk')).toBeGreaterThanOrEqual(43)
    expect(lurk.tp / (lurk.tp + lurk.fp)).toBeGreaterThanOrEqual(0.75)
  })
  it('CT-Push: Recall >= 57/58, Präzision >= 57/59', () => {
    expect(push.tp + push.fn).toBe(58); expect(push.tp).toBeGreaterThanOrEqual(57)
    expect(push.tp / (push.tp + push.fp)).toBeGreaterThanOrEqual(57 / 59)
  })
  it('Execute 11/11, Rush ohne Fehltreffer, Split-Präzision >= 15/18, Retake plausibel >= 33/34', () => {
    expect(tot.execute).toEqual([11, 11])
    expect(n('rush')).toBe(tot.rush[1])
    expect(n('split') / tot.split[1]).toBeGreaterThanOrEqual(15 / 18)
    expect(n('retake') / tot.retake[1]).toBeGreaterThanOrEqual(33 / 34)
  })
})
