// Abnahme HUD-Modell (state.ts) mit echten Daten. CSDA_TESTDATA = Ordner mit index.json + <id>.json.gz + <id>.3d.bin.gz der user-demo
// (die App legt sie in %APPDATA%/CS Demo Analysis/matches ab); fehlt die Variable, wird übersprungen.
// HudTrack-Teil nur, wenn <id>.hud.json.gz daneben liegt (Parser ab Paket PD), sonst nur der Ersatz-Teil (alter Import).
// Sollwerte = Entwurf v2 (fixtures.ts aus data-v2.js): Runde 15, Sekunden ab Freeze-Ende.
import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decode3d } from '../../../shared/cs3d'
import type { HudTrack } from '../../../shared/hud'
import type { MatchData, MatchSummary } from '../../../shared/model'
import { FIXTURES } from './fixtures'
import { hudView, timeline } from './state'

const DIR = process.env.CSDA_TESTDATA
function load() {
  const id = (JSON.parse(readFileSync(`${DIR}/index.json`, 'utf8')) as MatchSummary[]).find(s => s.fileName === 'user-demo.dem')?.id
  if (!id) throw new Error(`user-demo.dem not imported in ${DIR}`)
  const gz = (ext: string) => gunzipSync(readFileSync(`${DIR}/${id}.${ext}`))
  const match = JSON.parse(gz('json.gz').toString()) as MatchData
  const track = existsSync(`${DIR}/${id}.hud.json.gz`) ? (JSON.parse(gz('hud.json.gz').toString()) as HudTrack) : null
  return { data: { match, d: decode3d(gz('3d.bin.gz')) }, track }
}
const T = DIR ? load() : null
const R15 = T?.data.match.rounds.find(r => r.num === 15)
const EXI = FIXTURES.normal.focus
const at = (sec: number, track: HudTrack | null) => hudView(T!.data, track, Math.round(R15!.freezeEndTick + sec * 64), EXI, [], {})

for (const [label, useTrack] of [['fallback (no HudTrack)', false], ['HudTrack', true]] as const) {
  describe.skipIf(!T || (useTrack && !T.track))(`hudView R15 user-demo, ${label}`, () => {
    const track = useTrack ? T?.track ?? null : null

    it('72.4 s: 1 VS 2, bomb 41 s timer, captains', () => {
      const v = at(72.4, track)
      expect(v.vs).toEqual({ ct: 1, t: 2 })
      expect(v.phase).toBe('planted')
      expect(v.bomb.total).toBe(41)
      expect(v.bomb.left).toBeCloseTo(FIXTURES.normal.view.bomb.left, 1)
      expect(v.teams.CT.captain?.name).toBe('tyrannus00')
      expect(v.teams.T.captain?.name).toBe('Derdummbadss')
    })

    it('64.5 s: Exi 66 HP, red 34', () => {
      const v = at(64.5, track)
      expect(v.players.find(p => p.steamid === EXI)?.hp).toBe(66)
      expect(v.panel).toMatchObject({ steamid: EXI, hp: 66, hpLost: 34 })
    })

    it('90.5 s: defuse 50 %, 5.0 s left without kit', () => {
      const df = at(90.5, track).defuse!
      expect(df).toMatchObject({ steamid: EXI, kit: false })
      expect(df.progress).toBeCloseTo(0.5, 1)
      expect(Math.abs(df.left - 5)).toBeLessThan(0.1)
    })

    it('3 s: full utility + kit like the design data, slots CT 1–5 / T 6–10', () => {
      const v = at(3, track)
      const util = (u: string[]) => [...u].sort()
      // Entwurf = Inventar bei Freeze-Ende; der HudTrack sieht zusätzlich die Käufe 0,3 s danach (C3M0 HE Tick 110520, SymboIe 2 Flashbangs 110520/110536)
      const later: Record<string, string[]> = track ? { C3M0: ['High Explosive Grenade'], SymboIe: ['Flashbang', 'Flashbang'] } : {}
      for (const want of FIXTURES.start.view.players) {
        const got = v.players.find(p => p.steamid === want.steamid)!
        expect([got.name, util(got.utility), got.kit, got.helmet]).toEqual([want.name, util([...want.utility, ...(later[want.name] ?? [])]), want.kit, want.helmet])
      }
      expect(v.players.filter(p => p.side === 'T').every(p => p.utility.length === 4)).toBe(true)
      expect(v.players.map(p => p.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(v.players.slice(0, 5).every(p => p.side === 'CT')).toBe(true)
      expect(v.panel?.buy).toBe(!track) // Kaufzeit läuft; mit HudTrack: Exi hat die Kaufzone bei Tick 110680 (2,8 s) verlassen
    })

    it('whole demo: no exception, reserve null without HudTrack, mean ≤ 0.5 ms', () => {
      const { match } = T!.data, a = match.rounds[0].startTick, b = match.rounds.at(-1)!.endTick, N = 10_000
      hudView(T!.data, track, a, EXI, [], {}) // Indizes bauen
      let reserve = 0
      const t0 = performance.now()
      for (let i = 0; i < N; i++) { const v = hudView(T!.data, track, a + ((b - a) * i) / N, EXI, [], {}); if (v.panel?.reserve != null) reserve++ }
      const ms = (performance.now() - t0) / N
      console.log(`hudView ${label}: ${ms.toFixed(3)} ms/call, ${reserve} views with reserve`)
      expect(ms).toBeLessThanOrEqual(0.5)
      if (!track) expect(reserve).toBe(0)
      else expect(reserve).toBeGreaterThan(0)
    })
  })
}

describe.skipIf(!T)('timeline user-demo', () => {
  it('kills/deaths of Exi + bomb events, same as the fixtures, cached per focus', () => {
    const tl = timeline(T!.data.match, T!.data.d, EXI)
    expect(tl).toEqual(FIXTURES.normal.timeline)
    expect(tl.some(e => e.kind === 'kill') && tl.some(e => e.kind === 'death') && tl.some(e => e.kind === 'plant')).toBe(true)
    expect(timeline(T!.data.match, T!.data.d, EXI)).toBe(tl)
  })
})
