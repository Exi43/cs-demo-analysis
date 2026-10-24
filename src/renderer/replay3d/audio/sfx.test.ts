// Schritt-Regel ohne Server-Schritte (stepCues) und nur-lokale Clip-Sounds (SoundDef.local, Berat 22.10.: Ziehen/Pin nur beim Beobachteten)
import { describe, expect, it } from 'vitest'
import { FLAG, type CS3D } from '../../../shared/cs3d'
import type { SoundDef } from '../../../shared/assets3d'
import { Sfx, stepCues, type Cue } from './sfx'
import type { Clock } from './clock'

const RATE = 64, STEP = 4, DT = STEP / RATE
/** eine Runde, ein Spieler: je Frame [Tempo u/s, Waffe, Flags] (Bewegung entlang x) */
function track(frames: [number, number, number][]): CS3D {
  const n = frames.length, x = new Float32Array(n), flags = new Uint16Array(n), weapon = new Uint16Array(n)
  frames.forEach(([v, w, f], i) => { x[i] = i ? x[i - 1] + v * DT : 0; weapon[i] = w; flags[i] = FLAG.alive | f })
  return {
    header: { tickrate: RATE, frameStep: STEP, rounds: [{ num: 1, firstTick: 1000, nFrames: n, tracks: [0] }] },
    frameBase: [0], x, y: new Float32Array(n), z: new Float32Array(n), flags, weapon,
  } as unknown as CS3D
}
const run = (k: number, v: number, w = 42, f = 0) => Array.from({ length: k }, () => [v, w, f] as [number, number, number])

describe('stepCues (Regel ohne Server-Schritte)', () => {
  it('Mini-Schritt (2 Frames Gegenlenken) bleibt stumm', () => {
    expect(stepCues(track([...run(8, 0), ...run(2, 200), ...run(10, 0)]), 0, 0)).toEqual([])
  })
  it('Laufen: erster Schritt nach ~0.27 s, dann alle 0.3 s (Tick-Abstand 19–20)', () => {
    const s = stepCues(track([...run(4, 0), ...run(32, 250)]), 0, 0).map(x => x[0])
    expect(s.length).toBe(6) // 2 s Laufen: 0.27, 0.57 … 1.77 (der 7. bei 2.07 s fällt hinaus)
    expect((s[0] - (1000 + 3 * STEP)) / RATE).toBeCloseTo(0.27, 1) // Bewegung beginnt zwischen Frame 3 und 4
    for (let i = 1; i < s.length; i++) expect(Math.abs(s[i] - s[i - 1] - 0.3 * RATE)).toBeLessThanOrEqual(1)
  })
  it('Shift-Gehen (0.52 × Max) und Ducken stumm, gezoomte AWP (0.6 × 100 u/s) hörbar mit 0.4 s', () => {
    expect(stepCues(track(run(32, 130)), 0, 0)).toEqual([])
    const awp = stepCues(track(run(32, 60, 9, FLAG.scoped)), 0, 0).map(x => x[0])
    expect(awp.length).toBeGreaterThan(3)
    expect(awp[1] - awp[0]).toBeCloseTo(0.4 * RATE, -1)
  })
})

describe('nur-lokale Clip-Sounds', () => {
  const def = (local: boolean): SoundDef => ({ ev: local ? 'Flashbang.PullPin' : 'Weapon_AK47.Clipout', vol: 1, mix: 'Foley', files: ['x.wav'], curve: [], ...(local && { local: true as const }) })
  const cue = (src: number, local: boolean): Cue => ({ k: local ? 'pullpin' : 'reload', t: 1, defs: [def(local)], x: 0, y: 0, z: 0, src, prio: 0 })
  const play = (ego: number | undefined) => {
    const clock = { demoAt: () => 1e9, when: (t: number) => t + 10 } as unknown as Clock
    const sfx = new Sfx({ currentTime: 0 } as AudioContext, {} as AudioNode, clock, [cue(1, true), cue(0, true), cue(1, false)], '', {})
    sfx.update(1, 1, { x: 0, y: 0, z: 0, yaw: 0, ego })
    return sfx.stats
  }
  it('Ego-Sicht auf Spieler 0: nur seine lokalen, von anderen nur übertragene', () => {
    const s = play(0)
    expect(s.local).toBe(1) // Pin von Spieler 1
    expect(s.missing).toBe(2) // eigener Pin + Nachladen von Spieler 1 wären gespielt (Datei hier nicht geladen)
  })
  it('Free-Cam: keine lokalen Sounds', () => { expect(play(-1).local).toBe(2); expect(play(undefined).local).toBe(2) })
})
