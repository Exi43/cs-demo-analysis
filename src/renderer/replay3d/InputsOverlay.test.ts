// Tasten-Anzeige (keysAt): Granatenwurf zeigt M1 nur bis zum Loslassen (weapon_fire), Schuss weiter danach; Absprung = Space, auch ohne
// gesehene Sprungtaste (Jumpthrow-Bind zwischen zwei 16-Hz-Frames); Herunterfallen ohne Absprung nicht.
import { describe, expect, it } from 'vitest'
import { BTN, EV, FLAG, decode3d, encode3d, type Track3DIn } from '../../shared/cs3d'
import { keysAt } from './InputsOverlay'

const FIRST = 1000, N = 32
function demo(f: (i: number) => { btn?: number; air?: boolean; z?: number }, events: { tick: number; weapon: string }[]) {
  const T: Track3DIn = { player: 0, x: [], y: [], z: [], duck: [], btnLo: [], btnHi: [], flags: [], weapon: [], fov: [], ammo: [], skin: [], pitch: [], yaw: [], aimP: [], aimY: [], viewP: [], viewY: [] }
  for (let i = 0; i < N; i++) {
    const v = f(i)
    T.x.push(0); T.y.push(0); T.z.push(v.z ?? 0); T.duck.push(0); T.btnLo.push(v.btn ?? 0); T.btnHi.push(0)
    T.flags.push(FLAG.alive | (v.air ? FLAG.airborne : 0)); T.weapon.push(45); T.fov.push(0); T.ammo.push(1); T.skin.push(0)
  }
  for (let j = 0; j < 2 * N - 1; j++) { T.pitch.push(0); T.yaw.push(0); T.aimP.push(0); T.aimY.push(0); T.viewP.push(0); T.viewY.push(0) }
  return decode3d(encode3d({
    matchId: 'm', map: 'de_test', tickrate: 64, skins: [], shots: [], voice: [], nades: [],
    players: [{ steamid: 's', name: 'S', team: '', agent: { T: 0, CT: 0 } }], rounds: [{ num: 1, firstTick: FIRST, nFrames: N, tracks: [T] }],
    events: events.map(e => ({ tick: e.tick, type: EV.weapon_fire, player: 0, arg: e.weapon })),
  }))
}
const at = (frame: number) => FIRST + frame * 4

describe('keysAt', () => {
  it('Granate: M1 bis zum Loslassen, nicht danach; kurzer Klick ohne Probe davor sichtbar', () => {
    const held = demo(i => ({ btn: i >= 4 && i < 10 ? 1 << BTN.ATTACK : 0 }), [{ tick: at(10) + 1, weapon: 'weapon_smokegrenade' }])
    expect(keysAt(held, 's', at(9))).toContain('ATTACK')
    expect(keysAt(held, 's', at(10) + 2)).not.toContain('ATTACK')
    const click = demo(() => ({}), [{ tick: at(10) + 1, weapon: 'weapon_flashbang' }])
    expect(keysAt(click, 's', at(10) - 3)).toContain('ATTACK')
    expect(keysAt(click, 's', at(10) + 3)).not.toContain('ATTACK')
  })
  it('Schuss: M1 noch 150 ms danach wie bisher', () => {
    const gun = demo(() => ({}), [{ tick: at(10), weapon: 'weapon_ak47' }])
    expect(keysAt(gun, 's', at(10) + 4)).toContain('ATTACK')
    expect(keysAt(gun, 's', at(10) - 2)).not.toContain('ATTACK')
  })
  it('Absprung = Space (150 ms), Herunterfallen nicht', () => {
    const jump = demo(i => ({ air: i >= 10 && i < 20, z: i >= 10 && i < 20 ? 10 + (i - 10) * 5 : 0 }), [])
    expect(keysAt(jump, 's', at(10))).toContain('JUMP')
    expect(keysAt(jump, 's', at(12))).toContain('JUMP')
    expect(keysAt(jump, 's', at(14))).not.toContain('JUMP')
    const fall = demo(i => ({ air: i >= 10 && i < 20, z: i >= 10 ? -10 * (i - 9) : 0 }), [])
    expect(keysAt(fall, 's', at(10))).not.toContain('JUMP')
  })
})
