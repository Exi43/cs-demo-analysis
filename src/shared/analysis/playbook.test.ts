// T-Playbook. Teil 1 synthetisch (Cluster-Regel); Teil 2 gegen groundtruth-plays.json und methodik/beispiel-dust2.md, wenn CSDA_GT_CACHE
// auf den Ordner mit den MatchData-JSONs zeigt (Spike erkennung/cache: dust2.json, mirage.json, z1.json), sonst uebersprungen.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { MatchData } from '../model.ts'
import { buildGeo } from './geo.ts'
import { clusterRounds, tPlaybook } from './playbook.ts'
import { classifyT, teamSide, type TRound } from './rounds.ts'
import type { TSide } from './types.ts'

describe('clusterRounds (synthetisch)', () => {
  const r = (round: number, site: 'A' | 'B', sig: string[]) => ({ round, site, sig }) as TRound
  it('Single-Link ueber Jaccard >= 0,3, nur gleiche Site', () => {
    const a = r(1, 'A', ['site:A', 'in:A long', 'smoke:Cross']), b = r(2, 'A', ['site:A', 'in:A long', 'molotov:Pit'])
    const c = r(3, 'A', ['site:A', 'molotov:Pit', 'l20:Mid:2', 'l20:B:1']), d = r(4, 'B', ['site:A', 'in:A long', 'smoke:Cross'])
    const e = r(5, 'A', ['site:A', 'x1', 'x2', 'x3', 'x4', 'x5'])
    const out = clusterRounds([a, b, c, d, e]).map(g => g.map(x => x.round).sort())
    expect(out).toEqual(expect.arrayContaining([[1, 2, 3], [4], [5]])) // a–b 0,5 und b–c 0,4 verketten a mit c (0,17)
    expect(out).toHaveLength(3)
  })
})

const DIR = process.env.CSDA_GT_CACHE
const GT: Record<string, Record<string, number[][]>> = JSON.parse(readFileSync(new URL('../../../scripts/analysis-gt/groundtruth-plays.json', import.meta.url), 'utf8'))
const FILES: [string, string][] = [['dust2.json', 'dust2'], ['mirage.json', 'mirage'], ['z1.json', 'ancient']]
const runs = DIR ? FILES.flatMap(([f, key]) => {
  const m = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')) as MatchData, geo = buildGeo([m])
  return m.teams.map(team => {
    const tr = m.rounds.filter(r => teamSide(r, team) === 'T').map(r => classifyT(m, r, team, geo))
    const ms: number[] = []
    let t!: TSide
    for (let i = 0; i < 5; i++) { const s = performance.now(); t = tPlaybook([{ match: m, team }], tr); ms.push(performance.now() - s) }
    return { key, team, tr, t, ms: ms.sort((a, b) => a - b)[2] }
  })
}) : []
const derdumm = runs.find(r => r.team === 'Derdummbadss')!
/** Uhr '1:23' → Sekunden ab Freeze-Ende */
const sec = (c: string) => { const [m, s] = c.split(':').map(Number); return 115 - (60 * m + s) }

describe.skipIf(!DIR)('tPlaybook (echte Demos, CSDA_GT_CACHE)', () => {
  it('Cluster-Paare gegen groundtruth-plays.json: Praezision >= 70 %, Recall >= 80 %', () => {
    let tp = 0, fp = 0, fn = 0
    for (const { key, team, t } of runs) {
      const groups = GT[key]?.[team]; if (!groups) continue
      const g = new Map<number, number>(), c = new Map<number, number>()
      groups.forEach((gr, i) => gr.forEach(r => g.set(r, i)))
      t.plays.forEach((p, i) => p.refs.forEach(r => c.set(r.round, i)))
      const rs = [...g.keys()], cl = (r: number) => c.get(r) ?? -r // Runde ohne Spielzug = eigener Cluster
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
        const sg = g.get(rs[i]) === g.get(rs[j]), sc = cl(rs[i]) === cl(rs[j])
        if (sg && sc) tp++; else if (sc) fp++; else if (sg) fn++
      }
    }
    expect(tp / (tp + fp)).toBeGreaterThanOrEqual(0.7)
    expect(tp / (tp + fn)).toBeGreaterThanOrEqual(0.8)
  })

  it('jede Hit-Runde ohne Eco genau 1x in der Heatmap; <= 40 ms pro Team', () => {
    for (const { tr, t, ms } of runs) {
      const hits = tr.filter(x => x.site && x.buy !== 'eco').map(x => x.round).sort((a, b) => a - b)
      expect(t.heatmap.rows.flatMap(r => r.cells.flat().map(x => x.round)).sort((a, b) => a - b)).toEqual(hits)
      expect(ms).toBeLessThanOrEqual(40)
    }
  })

  it('Konter "Hold X until": nur bei Median-Hit >= 60 s, Uhr = Median, Spanne nur wenn alle Hits >= 60 s', () => {
    for (const { t } of runs) for (const p of t.plays) {
      const m = /until (\d:\d\d): their . comes late( \(.*\))?\./.exec(p.counter!.text)
      if (!m) continue
      const s = [...p.hitSecs].sort((a, b) => a - b), med = (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2
      expect(med, p.counter!.text).toBeGreaterThanOrEqual(60)
      expect(Math.abs(sec(m[1]) - med)).toBeLessThan(1)
      expect(!!m[2]).toBe(s[0] >= 60)
    }
  })

  it('Dust2 Derdummbadss: XBox-Read ~1:52 → A short [3/3], kein Long-Flash-Read', () => {
    const t = derdumm.t, reads = [...t.reads, ...t.plays.flatMap(p => (p.read ? [p.read] : []))]
    const xbox = reads.find(l => /:smoke: .*XBox.* at ~1:5[1-3] means \*\*A short\*\*/.test(l.text))
    expect(xbox?.tag).toMatchObject({ n: 3, N: 3 })
    expect(reads.filter(l => /:flash:/.test(l.text) && /long/i.test(l.text))).toEqual([])
  })

  it('Dust2 Derdummbadss: Planter DiiiDiii A [2/3], stakson B [2/3]; T-AWP Top Mid [4/4]', () => {
    const t = derdumm.t
    expect(t.overview.find(l => l.text.startsWith('**A** plants 3 · planter **DiiiDiii**'))?.tag).toMatchObject({ n: 2, N: 3 })
    expect(t.overview.find(l => l.text.startsWith('**B** plants 3 · planter **stakson**'))?.tag).toMatchObject({ n: 2, N: 3 })
    expect(t.awp.find(l => l.icon === 'awp' && l.text.includes('**Top Mid**'))?.tag).toMatchObject({ n: 4, N: 4 })
    // Route bis Hit +5 s: Pistol-Hit 0:51, DiiiDiii stirbt 0:26 auf B, die Route muss bis zur Site reichen
    expect(t.pistol[0].lines.find(l => l.text.startsWith('**DiiiDiii**'))!.text).toContain('→ B Site → :x: B Site')
  })

  it('Dust2 Rollen T2 (R15, R17) gegen beispiel-dust2.md: >= 4/5 Spieler mit Granaten-Typ, Uhr ± 2 s und Landename', () => {
    const play = derdumm.t.plays.find(p => p.refs.map(r => r.round).sort().join() === '15,17')!
    expect(play).toBeDefined()
    // aus dem Beispiel: Spieler, Granate, Landename, Uhr
    const want: [string, string, string, string][] = [
      ['Criminal_Boy', 'smoke', 'Long Doors', '1:41'], ['DiiiDiii', 'smoke', 'A Cross', '1:23'], ['stakson', 'smoke', 'A Cross', '1:27'],
      ['Derdummbadss', 'smoke', 'A Long', '1:16'], ['sk1nnex', 'flash', 'B', '1:45'],
    ]
    const ok = want.filter(([who, nade, name, c]) => {
      const line = play.roles.find(l => l.text.startsWith(`**${who}**`))?.text ?? ''
      const m = new RegExp(`:${nade}: ${name}\\?? ((?:\\d:\\d\\d(?: / )?)+)`).exec(line)
      return !!m && m[1].split(' / ').some(x => Math.abs(sec(x) - sec(c)) <= 2)
    })
    expect(ok.length).toBeGreaterThanOrEqual(4)
  })
})
