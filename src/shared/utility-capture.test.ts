// Lineup-Vorschläge aus Demos (utility-capture.ts) mit einem Mini-CS3D: Technik aus Tempo/Luft/Ducken und Startgeschwindigkeit,
// Stand/Blick/Ziel, Ähnlichkeits-Zählung, Anleitungstext.
import { describe, expect, it } from 'vitest'
import { BTN, FLAG, NADE, decode3d, encode3d, type Track3DIn } from './cs3d'
import type { ThrowCandidate } from './utility'
import { clickOf, countSimilar, lineupFromThrow, techniqueAt, techniqueStep, THROW_INHERIT, THROW_SPEED } from './utility-capture'

const FIRST = 1000, N = 48, THROW_F = 32 // Wurf bei Frame 32 (2 s)
type Frame = { x: number; y: number; z: number; duck: number; btn: number; flags: number }

/** ein Spieler, eine Runde; frame(i) überschreibt Standwerte; Granate startet beim Wurf mit Geschwindigkeit v (u/s, gerade Bahn) */
function demo(frame: (i: number) => Partial<Frame>, v: [number, number, number], pathPoints = 6) {
  const T: Track3DIn = { player: 0, x: [], y: [], z: [], duck: [], btnLo: [], btnHi: [], flags: [], weapon: [], fov: [], ammo: [], skin: [], pitch: [], yaw: [], aimP: [], aimY: [], viewP: [], viewY: [] }
  for (let i = 0; i < N; i++) {
    const f = { x: 100, y: 200, z: 0, duck: 0, btn: 0, flags: FLAG.alive, ...frame(i) }
    T.x.push(f.x); T.y.push(f.y); T.z.push(f.z); T.duck.push(f.duck); T.btnLo.push(f.btn); T.btnHi.push(0); T.flags.push(f.flags)
    T.weapon.push(45); T.fov.push(0); T.ammo.push(1); T.skin.push(0)
  }
  for (let j = 0; j < 2 * N - 1; j++) { T.pitch.push(-20); T.yaw.push(190); T.aimP.push(0); T.aimY.push(0); T.viewP.push(0); T.viewY.push(0) }
  const t0 = FIRST + THROW_F * 4, x0 = T.x[THROW_F], y0 = T.y[THROW_F], z0 = T.z[THROW_F] + 64
  const path = Array.from({ length: pathPoints }, (_, k): [number, number, number, number] => [t0 + 2 * k, x0 + (v[0] * k) / 32, y0 + (v[1] * k) / 32, z0 + (v[2] * k) / 32])
  return decode3d(encode3d({
    matchId: 'm', map: 'de_test', tickrate: 64, skins: [], events: [], shots: [], voice: [],
    players: [{ steamid: 's1', name: 'Exi', team: 'a', agent: { T: 0, CT: 0 } }],
    rounds: [{ num: 7, firstTick: FIRST, nFrames: N, tracks: [T] }],
    nades: [{ type: NADE.smoke, player: 0, throwTick: t0, detTick: t0 + 128, endTick: t0 + 1280, x: 900, y: 250, z: 16, path }],
  }))
}
const full: [number, number, number] = [THROW_SPEED, 0, 0]
const throwTick = FIRST + THROW_F * 4

describe('techniqueAt / lineupFromThrow', () => {
  it('steht, M1: Stand, Blick, Ziel, Runde, Seite, Titel, Anleitung', () => {
    const c = lineupFromThrow(demo(() => ({ btn: 1 << BTN.ATTACK }), full), 0, 'm', 'T', 'TSpawn')!
    expect(c).toMatchObject({ matchId: 'm', tick: throwTick, steamid: 's1', player: 'Exi', round: 7, map: 'de_test', type: 'smoke', side: 'T', similar: 0 })
    expect(c.lineup).toMatchObject({
      map: 'de_test', type: 'smoke', side: 'T', title: 'Smoke from TSpawn', technique: ['stand', 'left'], steps: ['Throw with left click'],
      stand: { x: 100, y: 200, z: 0 }, target: { x: 900, y: 250, z: 16 }, aim: { pitch: -20, yaw: -170 }, images: [], tags: [],
      demo: { matchId: 'm', tick: throwTick, steamid: 's1', player: 'Exi', round: 7 },
    })
  })

  it('Laufen/Gehen über das Tempo, Spieleranteil (1,25 ×) aus der Startgeschwindigkeit herausgerechnet', () => {
    const run = demo(i => ({ x: 100 + (240 * i) / 16 }), [THROW_SPEED + THROW_INHERIT * 240, 0, 0])
    expect(lineupFromThrow(run, 0, 'm', 'CT')!.lineup.technique).toEqual(['run', 'left'])
    const walk = demo(i => ({ y: 200 + (100 * i) / 16 }), [0, THROW_SPEED + THROW_INHERIT * 100, 0])
    expect(lineupFromThrow(walk, 0, 'm', 'CT')!.lineup.technique).toEqual(['walk', 'left'])
  })

  it('Sprung: in der Luft beim Wurf, Stand-Höhe vom Absprung; geduckt ohne stand', () => {
    const z = (i: number) => (i < 30 ? 0 : 20 * (i - 29))
    const c = lineupFromThrow(demo(i => ({ z: z(i), flags: FLAG.alive | (i >= 30 ? FLAG.airborne : 0), btn: i >= 29 && i <= 31 ? 1 << BTN.JUMP : 0 }), full), 0, 'm', 'T')!
    expect(c.lineup.technique).toEqual(['jump', 'left'])
    expect(c.lineup.stand.z).toBe(0)
    expect(c.lineup.steps).toEqual(['Jump and throw with left click'])
    // Sprungtaste im Wurf-Frame, abgehoben erst 2 Frames später (Jumpthrow am Boden ausgelöst)
    const d = demo(i => ({ flags: FLAG.alive | (i >= THROW_F + 2 ? FLAG.airborne : 0), btn: i === THROW_F ? 1 << BTN.JUMP : 0 }), full)
    expect(techniqueAt(d, 0, 0, throwTick)).toEqual(['jump'])
    expect(lineupFromThrow(demo(() => ({ duck: 1 }), full), 0, 'm', 'T')!.lineup.technique).toEqual(['crouch', 'left'])
  })

  it('Maustaste aus der Startgeschwindigkeit; ohne Flugbahn weggelassen', () => {
    expect([THROW_SPEED, THROW_SPEED * 0.65, THROW_SPEED * 0.3].map(clickOf)).toEqual(['left', 'both', 'right'])
    expect(lineupFromThrow(demo(() => ({}), [0, 0, THROW_SPEED * 0.65]), 0, 'm', 'T')!.lineup.technique).toEqual(['stand', 'both'])
    expect(lineupFromThrow(demo(() => ({}), [THROW_SPEED * 0.3, 0, 0]), 0, 'm', 'T')!.lineup.technique).toEqual(['stand', 'right'])
    expect(lineupFromThrow(demo(() => ({}), full, 1), 0, 'm', 'T')!.lineup.technique).toEqual(['stand'])
  })

  it('Werfer ohne Spur → null', () => {
    const d = demo(() => ({}), full)
    d.nade.throwTick[0] = FIRST + 10 * N * 4 // nach der Runde
    expect(lineupFromThrow(d, 0, 'm', 'T')).toBeNull()
  })

  it('Anleitung: Reihenfolge Gehen/Laufen, Ducken, Sprung, dann Taste', () => {
    expect(techniqueStep(['run', 'jump', 'left'])).toBe('Run, jump and throw with left click')
    expect(techniqueStep(['crouch', 'both'])).toBe('Crouch and throw with left + right click')
    expect(techniqueStep(['stand'])).toBe('Throw')
  })
})

describe('countSimilar', () => {
  const c = (map: string, type: ThrowCandidate['type'], sx: number, tx: number) =>
    ({ map, type, similar: 9, lineup: { stand: { x: sx, y: 0, z: 0 }, target: { x: tx, y: 0, z: 0 } } }) as ThrowCandidate
  it('gleiche Map und Typ, Stand und Ziel je < 64 u; andere Würfe zählen nicht', () => {
    const l = [c('a', 'smoke', 0, 1000), c('a', 'smoke', 40, 1050), c('a', 'smoke', 60, 1000), c('a', 'smoke', 200, 1000), c('a', 'flash', 0, 1000), c('b', 'smoke', 0, 1000), c('a', 'smoke', 0, 1200)]
    expect(countSimilar(l).map(x => x.similar)).toEqual([2, 2, 2, 0, 0, 0, 0])
  })
})
