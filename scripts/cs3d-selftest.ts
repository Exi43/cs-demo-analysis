// Selbsttest CS3D v6: node scripts/cs3d-selftest.ts
// Synthetische Runden mit Grenzfällen (yaw-Wrap, Tasten-Bit 35, negative Koordinaten, Teleport, Voice-Sprecher ohne Spur, Skins, Linkshand)
// → encode3d → gzip → gunzip → decode3d → Vergleich + sampleTrack/flashAt/voicePackets; v2-Datei weiter lesbar; Crosshair-Decoder.
import assert from 'node:assert/strict'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  BTN, CS3D_VERSION, EV, FLAG, NADE, decode3d, encode3d, flashAt, isDown, newSample, roundAt, sampleTrack, soundHash, splitButtons, voicePackets,
  type CS3DInput, type Player3D, type Skin3D, type Track3DIn,
} from '../src/shared/cs3d.ts'
import { decodeCrosshair, toRender } from '../src/shared/crosshair.ts'
import { buildCrosshair } from '../src/renderer/replay3d/crosshair.ts'

const N = 6, NA = 2 * N - 1
function track(player: number, x0: number): Track3DIn {
  const [lo, hi] = splitButtons('34359738377') // INSPECT (2^35) + FORWARD (8) + ATTACK (1)
  return {
    player,
    x: [x0, x0 + 12.25, x0 + 24.5, x0 + 36.75, x0 + 900, x0 + 912], // Frame 3→4 Teleport
    y: [-2496, -2490.5, -2485, -2480, -2475, -2470], z: [-120.3, -120.3, -110, -100, -100, -100],
    duck: [0, 0.25, 0.5, 1, 1, 0],
    btnLo: [lo, 0, lo, 0, 0, 0], btnHi: [hi, 0, hi, 0, 0, 0],
    flags: [FLAG.alive, FLAG.alive | FLAG.scoped, FLAG.alive | FLAG.planting, FLAG.alive | FLAG.lefthand | FLAG.reloading, 0, 0],
    weapon: [7, 7, 49, 507, 0, 0], fov: [0, 40, 10, 90, 0, 0], ammo: [30, 29, 400, -5, 0, 0], skin: [1, 1, 0, 2, 0, 0],
    pitch: [0, 1, 2, -3, -89, 89, 4, 5, 6, 7, 8],
    yaw: [170, 175, 179.9, -179.9, -175, -170, 0, 90, -90, 180, -180],
    aimP: [0, -0.5, -2.25, -5.4, -3, -1, 0, 0, 0.8, 0, 0], aimY: [0, 0.3, -1.4, 0.7, 0, 0, 0, 0, 0, 0, 0],
    viewP: [0, -1.1, -2.05, -0.3, 0, 0, 0, 0.75, 0, 0, 0], viewY: [0, -0.57, 1.16, 0, 0, 0, 0, 0, 0, 0, 0],
  }
}
const opus = (n: number, b: number) => Uint8Array.from({ length: n }, (_, i) => (b + i) & 255)
const players: Player3D[] = ['76561198254277069', '76561198189827773'].map((steamid, i) => ({ steamid, name: `p${i}`, team: `team${i}`, agent: { T: 5036 + i, CT: i ? 4619 : 0 } }))
Object.assign(players[0], {
  crosshair: decodeCrosshair('CST4G6RryMEYiow2spqFbhnuou2cux6Z876DmDjYrjUXmU')!, vm: { fov: 68, x: 2, y: -2, z: -2 },
  knife: { T: 514, CT: 42 }, glove: { T: { def: 5030, paint: 10045, seed: 864, wear: 0.469488263130188 } },
})
const skins: Skin3D[] = [{ def: 7, paint: 1035, seed: 661, wear: 0.0712, stattrak: true }, { def: 507, paint: 98, seed: 0, wear: 0.38, name: 'Ä "名"' }]
const m: CS3DInput = {
  matchId: 'selftest', map: 'de_dust2', tickrate: 64, players, skins,
  rounds: [
    { num: 1, firstTick: 1000, nFrames: N, tracks: [track(0, 100), track(1, -4000)] },
    { num: 2, firstTick: 2000, nFrames: N, tracks: [track(1, 50)] },
  ],
  events: [
    { tick: 1012, type: EV.player_death, player: 1, arg: 0 | 256 },
    { tick: 1004, type: EV.weapon_fire, player: 0, arg: 'weapon_ak47' },
    { tick: 1004, type: EV.player_blind, player: 1, arg: 450 },
    { tick: 1008, type: EV.weapon_fire, player: 0, arg: 'weapon_incgrenade' },
    { tick: 1010, type: EV.player_hurt, player: 1, arg: 100 | 256 | 512 },
  ],
  shots: [{ tick: 1004, player: 0, weapon: 60, silenced: true, x: 100.3, y: -2496, z: -56.3, pitch: -4.5, yaw: 179.99, recoil: 3.4 }],
  nades: [
    { type: NADE.incgrenade, player: 0, throwTick: 1008, detTick: 1016, endTick: 1460, x: 300, y: -2400, z: -110, path: [[1008, 100, -2496, -60], [1012, 200, -2450, -50], [1016, 300, -2400, -110]] },
    { type: NADE.smoke, player: 1, throwTick: 1001, detTick: 1003, endTick: 2000, x: -10, y: 20, z: 30, path: [[1001, 0, 0, 0]] },
  ],
  voice: [
    { tick: 1001, steamid: players[0].steamid, opus: opus(57, 1), seq: 10 },
    { tick: 1002, steamid: '76561199000000001', opus: opus(3, 9) }, // Coach ohne Spur
    { tick: 1001, steamid: players[0].steamid, opus: opus(60, 7), seq: 11 },
  ],
  drops: [
    { tick: 1012, end: 0, def: 9, skin: 0, x: -4000.3, y: -2470, z: -64, vx: -40.4, vy: 12, vz: 30, land: 1030, ix: -3990, iy: -2468, iz: -100, rx: -3980.6, ry: -2466, rz: -100 }, // AWP nie gehalten → header.weapons
    { tick: 1004, end: 1010, def: 7, skin: 1, x: 100, y: -2496, z: -60, vx: 250, vy: -3, vz: 0, land: 0, ix: 0, iy: 0, iz: 0, rx: 0, ry: 0, rz: 0 },
  ],
  sounds: [
    { tick: 1008, hash: soundHash('CT_Concrete.StepLeft'), player: 1 }, { tick: 1002, hash: soundHash('T_Concrete.StepLeft'), player: 0 },
    { tick: 1016, hash: soundHash('T_Concrete.StepLeft'), player: 0 },
  ],
}

const raw = encode3d(m)
const gz = gzipSync(raw)
const d = decode3d(gunzipSync(gz))
const H = d.header
const near = (a: number, b: number, eps: number, what: string) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`)
const wrap = (v: number) => ((v % 360) + 540) % 360 - 180

// Spuren
assert.equal(H.rounds.length, 2)
assert.deepEqual(H.weapons, [7, 9, 49, 60, 507])
assert.deepEqual(H.strings, ['weapon_ak47', 'weapon_incgrenade'])
let checked = 0
m.rounds.forEach((R, r) => R.tracks.forEach((t, k) => {
  const fb = d.frameBase[r] + k * N, ab = d.angleBase[r] + k * NA
  for (let i = 0; i < N; i++) {
    near(d.x[fb + i], t.x[i], 0.25, 'x'); near(d.y[fb + i], t.y[i], 0.25, 'y'); near(d.z[fb + i], t.z[i], 0.25, 'z')
    near(d.duck[fb + i], t.duck[i], 0.002, 'duck')
    assert.equal(d.btnLo[fb + i], t.btnLo[i]); assert.equal(d.btnHi[fb + i], t.btnHi[i]); assert.equal(d.flags[fb + i], t.flags[i])
    assert.equal(d.weapon[fb + i], t.weapon[i]); assert.equal(d.fov[fb + i], t.fov[i])
    assert.equal(d.ammo[fb + i], Math.min(255, Math.max(0, t.ammo[i]))); assert.equal(d.skin[fb + i], t.skin[i])
    checked++
  }
  for (let i = 0; i < NA; i++) { near(d.pitch[ab + i], t.pitch[i], 0.003, 'pitch'); near(wrap(d.yaw[ab + i] - t.yaw[i]), 0, 0.003, 'yaw') }
  for (const c of ['aimP', 'aimY', 'viewP', 'viewY'] as const) for (let i = 0; i < NA; i++) near(d[c][ab + i], t[c][i], 0.003, c)
}))
// yaw stetig über ±180: 179.9 → −179.9 ist +0.2°, nicht −359.8°
near(d.yaw[3] - d.yaw[2], 0.2, 0.01, 'yaw unwrapped')
assert.deepEqual(H.skins, skins); assert.deepEqual(H.players.slice(0, 2), players)
assert.ok(d.flags[3] & FLAG.lefthand && d.flags[3] & FLAG.reloading)
const [lo, hi] = [d.btnLo[0], d.btnHi[0]]
assert.ok(isDown(lo, hi, BTN.INSPECT) && isDown(lo, hi, BTN.FORWARD) && isDown(lo, hi, BTN.ATTACK) && !isDown(lo, hi, BTN.JUMP))

// Interpolation
const s = newSample()
sampleTrack(d, 0, 0, 1000, s); near(s.x, 100, 0.25, 'sample x@0'); near(s.yaw, 170, 0.01, 'sample yaw@0')
sampleTrack(d, 0, 0, 1006, s); near(s.x, 118.375, 0.3, 'sample x@1.5'); near(s.duck, 0.375, 0.01, 'duck linear')
near(s.vx, 196, 1, 'vx (12.25 u / 4 Ticks · 64)'); assert.equal(s.weapon, 7); assert.equal(s.flags, FLAG.alive | FLAG.scoped); assert.equal(s.skin, 1)
sampleTrack(d, 0, 0, 1006, s); near(s.aimP, -5.4, 0.003, 'aimP@6'); near(s.viewP, -0.3, 0.003, 'viewP@6')
sampleTrack(d, 0, 0, 1005, s); near(s.yaw, 180, 0.05, 'yaw zwischen 179.9 (1004) und −179.9 (1006)') // naiv wäre ≈0
sampleTrack(d, 0, 0, 1013, s); near(s.x, 136.75, 0.25, 'Teleport nicht interpoliert (vorher)')
sampleTrack(d, 0, 0, 1015, s); near(s.x, 1000, 0.25, 'Teleport nicht interpoliert (nachher)')
assert.equal(roundAt(d, 999), -1); assert.equal(roundAt(d, 1020), 0); assert.equal(roundAt(d, 1021), -1); assert.equal(roundAt(d, 2010), 1)

// Events, Schüsse, Granaten
assert.deepEqual([...d.evt.tick], [1004, 1004, 1008, 1010, 1012])
const deaths = [...d.evt.type].map((t, i) => [t, i] as const).filter(([t]) => t === EV.player_death)
assert.equal(d.evt.arg[deaths[0][1]], 256)
near(flashAt(d, 1, 1004), 1, 0, 'flash voll'); near(flashAt(d, 1, 1004 + 64 * 3), 0.5, 0.001, 'flash 1.5 s Rest'); assert.equal(flashAt(d, 0, 1010), 0)
assert.equal(d.shot.silenced[0], 1); assert.equal(d.shot.weapon[0], 60); assert.equal(d.shot.recoil[0], 3)
near(d.shot.x[0], 100.3, 0.25, 'shot x'); near(d.shot.pitch[0], -4.5, 0.003, 'shot pitch'); near(wrap(d.shot.yaw[0] - 179.99), 0, 0.003, 'shot yaw')
assert.deepEqual([...d.nade.type], [NADE.smoke, NADE.incgrenade]) // nach throwTick
assert.deepEqual([...d.nade.pathStart], [0, 1, 4])
assert.deepEqual([...d.path.tick.subarray(d.nade.pathStart[1], d.nade.pathStart[2])], [1008, 1012, 1016])
near(d.nade.x[1], 300, 0, 'nade x')
// liegende Waffen (v6), nach tick sortiert
assert.deepEqual([...d.drop.tick], [1004, 1012]); assert.deepEqual([...d.drop.end], [1010, 0]); assert.deepEqual([...d.drop.def], [7, 9]); assert.deepEqual([...d.drop.skin], [1, 0])
near(d.drop.x[1], -4000.3, 0.25, 'drop x'); near(d.drop.vx[1], -40, 0.5, 'drop vx'); near(d.drop.vz[0], 0, 0, 'drop vz')
assert.deepEqual([...d.drop.land], [0, 1030]); near(d.drop.rx[1], -3980.6, 0.25, 'drop rx'); near(d.drop.iz[1], -100, 0, 'drop iz')
// Server-Sounds: Hash wie Source 2 (Wert aus user-demo, GE_SosStartSoundEvent), Index in header.sounds, nach tick
assert.equal(soundHash('T_Concrete.StepLeft'), 4163677892); assert.equal(soundHash('weapon.Rifle.Impact'), 449069384)
assert.deepEqual([...d.snd.tick], [1002, 1008, 1016]); assert.deepEqual([...d.snd.player], [0, 1, 0])
assert.deepEqual([...d.snd.ev].map(i => H.sounds![i]), [soundHash('T_Concrete.StepLeft'), soundHash('CT_Concrete.StepLeft'), soundHash('T_Concrete.StepLeft')])

// Voice
const vp = voicePackets(d)
assert.equal(H.players.length, 3) // Coach angehängt
assert.equal(vp.length, 3)
assert.deepEqual(vp.map(p => [p.tick, p.steamid, p.seq, p.opus.length]), [
  [1001, players[0].steamid, 10, 57], [1001, players[0].steamid, 11, 60], [1002, '76561199000000001', undefined, 3]])
assert.deepEqual([...vp[1].opus], [...opus(60, 7)])

// Fehlerfälle
assert.throws(() => encode3d({ ...m, rounds: [{ num: 1, firstTick: 0, nFrames: N + 1, tracks: [track(0, 0)] }] }), /Frames/)
assert.throws(() => encode3d({ ...m, rounds: [{ num: 1, firstTick: 0, nFrames: N, tracks: [{ ...track(0, 0), x: [NaN, 0, 0, 0, 0, 0] }] }] }), /ungültig/)
assert.throws(() => encode3d({ ...m, skins: [] }), /skin/)
const bad = raw.slice(); bad[4 + 10] = 0x58 // Header-JSON kaputt / falsches magic
assert.throws(() => decode3d(bad))

// v2-Datei (vor Skins): Header ohne skins/Spieler-Extras und ohne Sektion skin → skin 0, skins [], Rest gleich; unbekannte Version wirft
const withHeader = (f: (h: any) => void) => {
  const hl = new DataView(raw.buffer).getUint32(0, true), h = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + hl)))
  f(h)
  const hj = new TextEncoder().encode(JSON.stringify(h)), body = raw.subarray((4 + hl + 3) & ~3), base = (4 + hj.length + 3) & ~3
  const out = new Uint8Array(base + body.length)
  new DataView(out.buffer).setUint32(0, hj.length, true); out.set(hj, 4); out.set(body, base)
  return out
}
const d2 = decode3d(withHeader(h => {
  h.version = 2; delete h.skins; h.sections = h.sections.filter((x: any) => x.name !== 'skin')
  for (const p of h.players) { delete p.crosshair; delete p.vm; delete p.knife; delete p.glove }
}))
assert.deepEqual(d2.header.skins, []); assert.ok(d2.skin.length === d.skin.length && d2.skin.every(v => v === 0))
assert.deepEqual([...d2.x], [...d.x]); assert.deepEqual([...d2.flags], [...d.flags]); assert.equal(d2.header.players[0].crosshair, undefined)
sampleTrack(d2, 0, 0, 1006, s); assert.equal(s.skin, 0)
// v3-Datei (vor Rückstoß): ohne Punch-Sektionen → 0, Winkel gleich
const d3 = decode3d(withHeader(h => { h.version = 3; h.sections = h.sections.filter((x: any) => !/^(aim|view)[PY]$/.test(x.name)) }))
assert.ok(d3.aimP.every(v => v === 0) && d3.viewY.every(v => v === 0)); assert.deepEqual([...d3.yaw], [...d.yaw])
sampleTrack(d3, 0, 0, 1006, s); assert.equal(s.aimP, 0)
// v5-Datei (vor liegenden Waffen): ohne drop.* → leer
const d5 = decode3d(withHeader(h => { h.version = 5; delete h.sounds; h.sections = h.sections.filter((x: any) => !/^(drop|snd)\./.test(x.name)) }))
assert.equal(d5.drop.tick.length, 0); assert.equal(d5.drop.rz.length, 0); assert.equal(d5.snd.tick.length, 0); assert.deepEqual(d5.header.sounds, [])
assert.deepEqual([...d5.x], [...d.x])
assert.throws(() => decode3d(withHeader(h => { h.version = CS3D_VERSION + 1 })), /Format/)
// krummer byteOffset (Node-Buffer-Pool)
const odd = new Uint8Array(raw.length + 1); odd.set(raw, 1)
assert.equal(decode3d(odd.subarray(1)).x[0], d.x[0])

// Crosshair-Decoder: je Format ein Testvektor aus akiver/csgo-sharecode (index.test.ts), Clamp, ungültige Codes
const has = (code: string, exp: Record<string, unknown>) => {
  const c = decodeCrosshair(code) as Record<string, unknown> | null
  assert.ok(c, `crosshair null: ${code}`)
  for (const [k, v] of Object.entries(exp)) assert.equal(c[k], v, `${code} ${k}`)
}
has('CSAB6Oby2JUDOrBRy4jRcsR6JOQdhbszKF9GuKQGhKVwAc', { format: 'cs2-v1', style: 9, followRecoil: true, centerDotEnabled: false, tStyleEnabled: true,
  outlineMode: 2, red: 10, green: 20, blue: 30, alpha: 200, outlineRed: 40, outlineGreen: 50, outlineBlue: 60, outlineAlpha: 128, gap: -7, length: 255,
  thickness: 12, dynamicSpreadLimit: 64, splitDistance: 127, innerSplitAlpha: 0.29, outerSplitAlpha: 0.97, splitSizeRatio: 0.63, screenHeight: 1440,
  scopeDotScale: 2, scopeDotUseCrosshairColor: true })
has('CSDfPcMpj4e9NRxx6SGiVoFCHzYRYGmb34WHpbYHy6E6id', { gap: 3840 })
has('CSGO-Cn37R-YE7vo-pLCAL-aURmZ-z6zkG', { format: 'legacy-v1', gap: -1.3, outlineThickness: 2, red: 175, green: 81, blue: 213, alpha: 137, splitDistance: 6,
  fixedCrosshairGap: 3, color: 5, innerSplitAlpha: 0.6, outlineEnabled: true, outerSplitAlpha: 0.4, splitSizeRatio: 0.5, thickness: 1.2, centerDotEnabled: true,
  alphaEnabled: true, tStyleEnabled: true, style: 2, length: 4.6, deployedWeaponGapEnabled: true, followRecoil: false })
has('CSGO-MnUCC-89iG7-2cVar-wy7Yn-amCpF', { format: 'legacy-v3', style: 6, followRecoil: false, outlineMode: 1, centerDotEnabled: true, tStyleEnabled: false,
  red: 252, green: 15, blue: 192, alpha: 255, gap: 4, length: 8, thickness: 3, dynamicSpreadLimit: 255, splitDistance: 7, innerSplitAlpha: 1,
  outerSplitAlpha: 0.45, splitSizeRatio: 0.3, screenHeight: 1080 })
has('CSGO-G8oAC-RyvWc-Hi3CZ-voSwn-QJbfE', { format: 'legacy-v4', style: 8, outlineMode: 1, centerDotEnabled: true, red: 124, gap: 25, length: 7, thickness: 20, screenHeight: 768 })
for (const bad of ['CSGO-L9spZ-ihuov-cyhtE-kxbqa-FkBAA', 'CSuZhVyU8icUwjTjopBSVi6ctEbq5GiOXJBRdC6LNLKaFL', 'CSGO-12345-12345-12345-12345-1234', '', 'CS'])
  assert.equal(decodeCrosshair(bad), null, `crosshair accepted: ${bad}`)
const xr = toRender(H.players[0].crosshair!) // Exi aus user-demo: Cyan, T-Style, 1440p
assert.deepEqual(xr.color, [0, 255, 255, 255]); assert.ok(xr.tStyle); assert.equal(xr.screenHeight, 1440)
// Renderer-Geometrie (Spike-Werte @1080): Exi T=1 L=2 G=2, T-Style ohne Outline; Criminal_Boy T=1 L=3 G=2, volle Outline (je Balken Outline + Füllung)
const rects = (c: Parameters<typeof buildCrosshair>[0]) => buildCrosshair(c, 1080, 960, 540).map(p => (p.kind === 'rect' ? [p.x, p.y, p.w, p.h] : null))
assert.deepEqual(rects(xr), [[956, 540, 2, 1], [963, 540, 2, 1], [960, 543, 1, 2]])
const cb = rects(toRender(decodeCrosshair('CSFAcAqKntHpN6mNBNBk4mhOTRA3EfRpDzrpLV6oBS8Ssc')!))
assert.equal(cb.length, 8); assert.deepEqual(cb.slice(0, 2), [[954, 539, 5, 3], [955, 540, 3, 1]])

console.log(`CS3D OK: ${checked} Frames, ${d.evt.tick.length} Events, ${d.shot.tick.length} Schüsse, ${d.nade.type.length} Granaten, ${vp.length} Voice-Pakete, ` +
  `${H.skins.length} Skins, v2/v3 lesbar, Crosshair-Vektoren OK | raw ${raw.length} B, gz ${gz.length} B`)
