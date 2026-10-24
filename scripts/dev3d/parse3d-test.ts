// Test 3D-Daten: node --max-old-space-size=4096 scripts/dev3d/parse3d-test.ts [demo]
// 1. Lauf: v1 (parseDemo) parsen und cachen, dann Ende. Ab 2. Lauf: parse3d messen → encode → gzip → Datei → decode
// → Roundtrip (decode == encode-Eingabe) + Stichproben/Plausibilität + interp.ts.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import * as dp from '@laihoe/demoparser2'
import { parseDemo, readDemoBuffer } from '../../src/main/parse.ts'
import { parse3d, punchAt } from '../../src/main/parse3d.ts'
import {
  BTN, EV, FLAG, NADE, decode3d, encode3d, flashAt, isDown, newSample, sampleTrack, voicePackets, type CS3D,
} from '../../src/shared/cs3d.ts'
import { lerpDeg, roundHold, samplePlayer, wrapDeg } from '../../src/renderer/replay3d/interp.ts'
import type { MatchData } from '../../src/shared/model.ts'

const demo = process.argv[2] ?? 'F:/csdemoanalysis/demos/user-demo.dem'
const CACHE = '../Daten/downloads/spike/build/data3d'
mkdirSync(CACHE, { recursive: true })
const v1File = `${CACHE}/${basename(demo)}.v1.json.gz`
let t0 = performance.now()
const lap = () => { const ms = Math.round(performance.now() - t0); t0 = performance.now(); return ms }
const raw = readFileSync(demo)
if (!existsSync(v1File)) {
  const m = parseDemo(raw, basename(demo))
  writeFileSync(v1File, gzipSync(JSON.stringify(m)))
  console.log(`v1 geparst und gecacht (${lap()} ms): ${v1File}. Nochmal starten für den 3D-Test.`)
  process.exit(0)
}
const m: MatchData = JSON.parse(gunzipSync(readFileSync(v1File)).toString())
lap()

// ---------------------------------------------------------------- Zeiten
const times: Record<string, number> = {}
let phase = 'start'
const tAll = performance.now()
const input = parse3d(raw, m, (_pct, msg) => { times[phase] = lap(); phase = msg })
times[phase] = lap()
times.parse3dTotal = Math.round(performance.now() - tAll)
const enc = encode3d(input); times.encode = lap()
const gz = gzipSync(enc); times.gzip = lap()
const file = `${CACHE}/${m.id}.3d.bin.gz`
writeFileSync(file, gz)
const un = gunzipSync(readFileSync(file)); times.readGunzip = lap()
const d = decode3d(un); times.decode = lap()
console.log('Zeiten ms', times)
console.log(`Größe: raw ${(enc.length / 1024).toFixed(0)} KB, gz ${(statSync(file).size / 1024).toFixed(0)} KB (${file})`)

// ---------------------------------------------------------------- Roundtrip decode == encode-Eingabe
const H = d.header
let maxPos = 0, maxAng = 0, maxDuck = 0, frames = 0
input.rounds.forEach((R, r) => R.tracks.forEach((t, k) => {
  const n = R.nFrames, fb = d.frameBase[r] + k * n, ab = d.angleBase[r] + k * (2 * n - 1)
  assert.equal(H.rounds[r].tracks[k], t.player)
  for (let i = 0; i < n; i++, frames++) {
    maxPos = Math.max(maxPos, Math.abs(d.x[fb + i] - t.x[i]), Math.abs(d.y[fb + i] - t.y[i]), Math.abs(d.z[fb + i] - t.z[i]))
    maxDuck = Math.max(maxDuck, Math.abs(d.duck[fb + i] - t.duck[i]))
    assert.equal(d.btnLo[fb + i], t.btnLo[i]); assert.equal(d.btnHi[fb + i], t.btnHi[i]); assert.equal(d.flags[fb + i], t.flags[i])
    assert.equal(d.weapon[fb + i], t.weapon[i]); assert.equal(d.fov[fb + i], t.fov[i])
    assert.equal(d.ammo[fb + i], Math.min(255, Math.max(0, Math.round(t.ammo[i])))); assert.equal(d.skin[fb + i], t.skin[i])
  }
  for (let j = 0; j < 2 * n - 1; j++) maxAng = Math.max(maxAng, Math.abs(d.pitch[ab + j] - t.pitch[j]), Math.abs(wrapDeg(d.yaw[ab + j] - t.yaw[j])),
    Math.abs(d.aimP[ab + j] - t.aimP[j]), Math.abs(d.aimY[ab + j] - t.aimY[j]), Math.abs(d.viewP[ab + j] - t.viewP[j]), Math.abs(d.viewY[ab + j] - t.viewY[j]))
}))
assert.ok(maxPos <= 0.25 && maxAng <= 0.003 && maxDuck <= 0.002, `Roundtrip ${maxPos} ${maxAng} ${maxDuck}`)
assert.deepEqual(H.skins, input.skins); assert.deepEqual(H.players.slice(0, input.players.length), input.players)
const byTick = <T extends { tick: number }>(a: T[]) => [...a].sort((p, q) => p.tick - q.tick)
byTick(input.events).forEach((e, i) => {
  assert.equal(d.evt.tick[i], e.tick); assert.equal(d.evt.type[i], e.type); assert.equal(d.evt.player[i], e.player)
  assert.equal(typeof e.arg === 'string' ? H.strings[d.evt.arg[i]] : d.evt.arg[i], e.arg)
})
byTick(input.shots).forEach((s, i) => {
  assert.equal(d.shot.tick[i], s.tick); assert.equal(d.shot.player[i], s.player); assert.equal(d.shot.weapon[i], s.weapon)
  assert.equal(d.shot.silenced[i], +s.silenced); assert.ok(Math.abs(d.shot.x[i] - s.x) <= 0.25 && Math.abs(wrapDeg(d.shot.yaw[i] - s.yaw)) <= 0.003)
})
;[...input.nades].sort((p, q) => p.throwTick - q.throwTick).forEach((n, i) => {
  assert.equal(d.nade.type[i], n.type); assert.equal(d.nade.player[i], n.player); assert.equal(d.nade.detTick[i], n.detTick)
  assert.ok(Math.abs(d.nade.x[i] - n.x) <= 0.25 && Math.abs(d.nade.z[i] - n.z) <= 0.25)
  assert.equal(d.nade.pathStart[i + 1] - d.nade.pathStart[i], n.path.length)
})
const vp = voicePackets(d)
byTick(input.voice).forEach((v, i) => {
  assert.equal(vp[i].tick, v.tick); assert.equal(vp[i].steamid, v.steamid); assert.equal(vp[i].seq, v.seq)
  assert.ok(vp[i].opus.length === v.opus.length && vp[i].opus.every((b, j) => b === v.opus[j]))
})
console.log(`Roundtrip OK: ${frames} Track-Frames, max Fehler pos ${maxPos} u, Winkel ${maxAng.toFixed(4)}°, duck ${maxDuck.toFixed(4)}; ` +
  `${d.evt.tick.length} Events, ${d.shot.tick.length} Schüsse, ${d.nade.type.length} Granaten, ${vp.length} Voice-Pakete identisch`)

// ---------------------------------------------------------------- Plausibilität
const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`
const quant = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return +(s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? NaN).toFixed(1) }
let alive = 0, anyBtn = 0, fwd = 0, atk = 0, duckF = 0, scoped = 0, walking = 0, air = 0, planting = 0, defusing = 0, noWeapon = 0
const fovs = new Map<number, number>(), speeds: number[] = [], pitchR = [Infinity, -Infinity]
const s = newSample()
H.rounds.forEach((R, r) => R.tracks.forEach((_, k) => {
  const fb = d.frameBase[r] + k * R.nFrames
  for (let i = 0; i < R.nFrames; i++) {
    const f = d.flags[fb + i]; if (!(f & FLAG.alive)) continue
    alive++
    const lo = d.btnLo[fb + i], hi = d.btnHi[fb + i]
    if (lo || hi) anyBtn++
    if (isDown(lo, hi, BTN.FORWARD)) fwd++
    if (isDown(lo, hi, BTN.ATTACK)) atk++
    if (d.duck[fb + i] > 0.5) duckF++
    if (f & FLAG.scoped) scoped++; if (f & FLAG.walking) walking++; if (f & FLAG.airborne) air++
    if (f & FLAG.planting) planting++; if (f & FLAG.defusing) defusing++
    if (!d.weapon[fb + i]) noWeapon++
    fovs.set(d.fov[fb + i], (fovs.get(d.fov[fb + i]) ?? 0) + 1)
    const ab = d.angleBase[r] + k * (2 * R.nFrames - 1)
    pitchR[0] = Math.min(pitchR[0], d.pitch[ab + 2 * i]); pitchR[1] = Math.max(pitchR[1], d.pitch[ab + 2 * i])
    if (i % 8 === 0) { sampleTrack(d, r, k, R.firstTick + 4 * i, s); speeds.push(Math.hypot(s.vx, s.vy)) }
  }
}))
console.log(`lebende Frames ${alive}: Taste gedrückt ${pct(anyBtn, alive)}, FORWARD ${pct(fwd, alive)}, ATTACK ${pct(atk, alive)}, duck>0.5 ${pct(duckF, alive)}, ` +
  `scoped ${pct(scoped, alive)}, walking ${pct(walking, alive)}, airborne ${pct(air, alive)}, planting ${planting}, defusing ${defusing}, ohne Waffe ${pct(noWeapon, alive)}`)
console.log(`fov ${JSON.stringify([...fovs])}, pitch ${pitchR.map(v => v.toFixed(1))}, Geschwindigkeit u/s p50 ${quant(speeds, 0.5)} p95 ${quant(speeds, 0.95)} p99 ${quant(speeds, 0.99)}`)
console.log(`Waffen (item_def_idx) ${H.weapons.join(',')}`)
console.log('Agenten', H.players.map(p => `${p.name} T${p.agent.T}/CT${p.agent.CT}`).join(', '))
// v3: pro Spieler Crosshair, Viewmodel, Messer, Handschuh, Linkshand-/Reload-Anteil, eigene Skins (Waffe|Paint aus Frames, in denen er die Waffe hält)
const per = H.players.map(() => ({ alive: 0, left: 0, reload: 0, skins: new Set<number>() }))
H.rounds.forEach((R, r) => R.tracks.forEach((p, k) => {
  const fb = d.frameBase[r] + k * R.nFrames
  for (let i = 0; i < R.nFrames; i++) {
    const f = d.flags[fb + i]; if (!(f & FLAG.alive)) continue
    per[p].alive++; if (f & FLAG.lefthand) per[p].left++; if (f & FLAG.reloading) per[p].reload++
    if (d.skin[fb + i]) per[p].skins.add(d.skin[fb + i])
  }
}))
const xcs = (p: (typeof H.players)[number]) => {
  const c = p.crosshair as any
  return !c ? '-' : `${c.format} st${c.style} g${c.gap} l${c.length} t${c.thickness} o${c.outlineMode ?? +c.outlineEnabled}${c.centerDotEnabled ? ' dot' : ''}${c.tStyleEnabled ? ' T' : ''} rgba(${[c.red, c.green, c.blue, c.alpha]}) @${c.screenHeight}`
}
for (const [i, p] of H.players.entries()) {
  const P = per[i]; if (!P.alive) continue
  const gl = Object.entries(p.glove ?? {}).map(([s, g]) => `${s}:${g.def}/${g.paint}/${g.seed}/${g.wear.toFixed(3)}`).join(' ') || '-'
  const sk = [...P.skins].map(s => { const k = H.skins[s - 1]; return `${k.def}:${k.paint}${k.stattrak ? 'ST' : ''}${k.name ? `"${k.name}"` : ''}` }).join(' ')
  console.log(`  ${p.name.padEnd(14)} xhair ${xcs(p)} | vm ${p.vm ? `${p.vm.fov}/${p.vm.x}/${p.vm.y}/${p.vm.z}` : '-'} | knife ${JSON.stringify(p.knife ?? {})} | glove ${gl} | ` +
    `left ${pct(P.left, P.alive)} reload ${pct(P.reload, P.alive)} | skins ${sk || '-'}`)
}
const st = H.skins.filter(k => k.stattrak).length, named = H.skins.filter(k => k.name).length
console.log(`Skins: ${H.skins.length} (StatTrak ${st}, Nametag ${named}), Frames mit Skin ${pct(d.skin.filter(v => v).length, d.skin.length)}, ` +
  `wear ${Math.min(...H.skins.map(k => k.wear)).toFixed(3)}..${Math.max(...H.skins.map(k => k.wear)).toFixed(3)}, seed max ${Math.max(...H.skins.map(k => k.seed))}`)
assert.ok(H.skins.every(k => k.def > 0 && k.paint > 0 && k.wear >= 0 && k.wear <= 1 && Number.isInteger(k.seed) && k.seed >= 0 && k.seed <= 1000), 'Skin-Werte')
assert.ok(H.players.every(p => !p.vm || (p.vm.fov >= 54 && p.vm.fov <= 68 && Math.abs(p.vm.x) <= 2.5 && Math.abs(p.vm.y) <= 2 && p.vm.z >= -2 && p.vm.z <= 2)), 'vm-Bereich')
// Skin folgt der Waffen-Entity: Frame-Skin muss zur gehaltenen Waffe passen
for (let i = 0; i < d.skin.length; i++) if (d.skin[i]) assert.equal(H.skins[d.skin[i] - 1].def, d.weapon[i], `Skin-def ≠ Waffe bei Frame ${i}`)
// Altlack (demo-econ P0): Standardwaffe (Item-ID 0, kein Fallback-Paint) darf keinen Skin haben; Rohzeilen derselben Frame-Ticks
{
  const AL = ['Weapon.m_iItemIDLow', 'Weapon.m_iItemIDHigh', 'Weapon.m_nFallbackPaintKit', 'weapon_skin_id']
  const V1 = m.rounds.filter(R => R.frameTicks.length), fr = new Map<number, [number, number]>()
  V1.forEach((R, r) => R.frameTicks.forEach((t, i) => fr.set(t, [r, i])))
  const c = dp.parseTicks(readDemoBuffer(raw), AL, [...fr.keys()], null, true) as Record<string, any[]>
  let rows = 0, painted = 0, stale = 0, bad = 0
  for (let i = 0; i < c.tick.length; i++) {
    const a = fr.get(c.tick[i]), k = a && V1[a[0]].tracks.findIndex(t => t.steamid === String(c.steamid[i]))
    if (!a || k === undefined || k < 0) continue
    rows++
    const id0 = !c[AL[0]][i] && !c[AL[1]][i] && !(c[AL[2]][i] > 0), skin = d.skin[d.frameBase[a[0]] + k * H.rounds[a[0]].nFrames + a[1]]
    if (c[AL[3]][i] > 0) { painted++; if (id0) stale++ }
    if (id0 && skin) bad++
  }
  console.log(`Altlack: ${rows} Zeilen, Paint > 0 ${painted}, davon Item-ID 0 ${stale} (${pct(stale, painted)}, früher als Skin gezeigt), jetzt mit Skin ${bad}`)
  assert.equal(bad, 0, 'Standardwaffe (Item-ID 0) mit Skin')
  // EOM-Gegenprobe (msg 375, demo-econ align.mjs): im Match gesehene Vitrine-Items behalten Paint/Seed/Wear
  const al = `../Daten/downloads/spike/fidelity/demo-econ/out/${({ 'user-demo.dem': 'user', 'faceit-de_mirage-6de46e85.dem': 'faceit', 'dl-22f4620d.dem': 'dl1' } as Record<string, string>)[basename(demo)]}_align.json`
  if (existsSync(al)) {
    const eom = (JSON.parse(readFileSync(al, 'utf8')).report as any[]).filter(r => r.found && r.entity.paint > 0)
    const miss = eom.filter(r => !H.skins.some(k => k.def === r.def && k.paint === r.entity.paint && k.seed === Math.floor(r.entity.seed) && k.wear === r.entity.wear))
    console.log(`EOM-Gegenprobe: ${eom.length - miss.length} von ${eom.length} Items mit Paint/Seed/Wear in header.skins`)
    assert.equal(miss.length, 0, `EOM-Items fehlen: ${miss.map(r => `${r.name} ${r.def}/${r.entity.paint}`).join(', ')}`)
  }
}
const evCount = Object.entries(EV).map(([k, v]) => `${k} ${d.evt.type.filter(t => t === v).length}`)
console.log('Events', evCount.join(', '))
// v5: player_footstep = Absprung/harte Landung; Spieler in der Luft ±8 Ticks. Ganze Demo 1200 / 1418 (Spike), davon in den
// Runden-Fenstern 1107 / 1315; der Rest liegt im Warmup oder zwischen den Runden (dort gibt es keine Frames, wie alle Events gefiltert)
const foot = [...d.evt.type.keys()].filter(i => d.evt.type[i] === EV.player_footstep)
const footAir = foot.filter(i => [-8, 0, 8].some(o => samplePlayer(d, d.evt.player[i], d.evt.tick[i] + o, s) && s.flags & FLAG.airborne)).length
console.log(`player_footstep: ${foot.length}, in der Luft ±8 Ticks ${pct(footAir, foot.length)}`)
assert.ok(foot.every(i => d.evt.player[i] !== 255 && d.evt.arg[i] === 0), 'player_footstep: Spieler/arg')
assert.equal(foot.length, ({ 'user-demo.dem': 1107, 'faceit-de_mirage-6de46e85.dem': 1315 } as Record<string, number>)[basename(demo)] ?? foot.length, 'player_footstep-Anzahl')
assert.ok(footAir >= 0.9 * foot.length, 'player_footstep ohne Sprung/Landung')
// ältere v4-Dateien (vor player_footstep) laden weiter: gleicher Aufbau, nur Version 4 im Kopf
const hl = new DataView(enc.buffer, enc.byteOffset).getUint32(0, true), hv = JSON.parse(new TextDecoder().decode(enc.subarray(4, 4 + hl)))
hv.version = 4
const v4 = enc.slice(); v4.set(new TextEncoder().encode(JSON.stringify(hv)), 4)
assert.equal(decode3d(v4).header.version, 4); assert.equal(decode3d(v4).evt.tick.length, d.evt.tick.length)
const hurt = [...d.evt.type.keys()].filter(i => d.evt.type[i] === EV.player_hurt).map(i => d.evt.arg[i])
const deaths = [...d.evt.type.keys()].filter(i => d.evt.type[i] === EV.player_death).map(i => d.evt.arg[i])
console.log(`player_hurt: head ${hurt.filter(a => a & 256).length}/${hurt.length}, armor ${hurt.filter(a => a & 512).length}; ` +
  `player_death: Headshot ${deaths.filter(a => a & 256).length}/${deaths.length}, ohne Angreifer ${deaths.filter(a => (a & 255) === 255).length}`)
const nadeCount = Object.entries(NADE).map(([k, v]) => `${k} ${d.nade.type.filter(t => t === v).length}`)
console.log('Granaten', nadeCount.join(', '), `| v1 molotov gesamt ${m.rounds.reduce((a, R) => a + R.nades.filter(n => n.type === 'molotov').length, 0)}`)
// Molotov/Brand: Seite des Werfers (T kauft Molotov, CT Brandgranate) und Abstand Wurf-Event → Projektil
const fireStr = (i: number) => H.strings[d.evt.arg[i]]
const mol: string[] = []
for (let i = 0; i < d.nade.type.length; i++) {
  if (d.nade.type[i] !== NADE.molotov && d.nade.type[i] !== NADE.incgrenade) continue
  const throwTick = d.nade.throwTick[i], p = d.nade.player[i]
  const R = m.rounds.find(R => throwTick >= R.frameTicks[0] && throwTick <= R.frameTicks[R.frameTicks.length - 1])!
  const side = R.tracks.find(t => t.steamid === H.players[p]?.steamid)?.side
  let fire = -1
  for (let e = 0; e < d.evt.tick.length && d.evt.tick[e] <= throwTick + 8; e++)
    if (d.evt.type[e] === EV.weapon_fire && d.evt.player[e] === p && /molotov|incgrenade/.test(fireStr(e))) fire = e
  mol.push(`${d.nade.type[i] === NADE.molotov ? 'M' : 'I'}/${side}/${fire >= 0 ? throwTick - d.evt.tick[fire] : '-'}`)
}
console.log('Molly (Typ/Seite/Ticks Wurf→Projektil):', mol.join(' '))
const sil = d.shot.silenced.reduce((a, v) => a + v, 0)
console.log(`Schüsse: ${d.shot.tick.length}, Spieler unbekannt ${d.shot.player.filter(p => p === 255).length}, schallgedämpft ${sil}, ` +
  `Waffen ${[...new Set(d.shot.weapon)].join(',')}`)
// Schuss-Augenposition gegen Spur (prüft Tick-Ausrichtung der Frames): Abstand horizontal / Augenhöhe / yaw
const dxy: number[] = [], dz: number[] = [], dyaw: number[] = [], dpit: number[] = [], dpun: number[] = []
for (let i = 0; i < d.shot.tick.length; i++) {
  if (!samplePlayer(d, d.shot.player[i], d.shot.tick[i], s)) continue
  dxy.push(Math.hypot(d.shot.x[i] - s.x, d.shot.y[i] - s.y)); dz.push(Math.abs(d.shot.z[i] - (s.z + 64 - 18 * s.duck)))
  dyaw.push(Math.abs(wrapDeg(d.shot.yaw[i] - s.yaw)))
  // Kugel = Blick + 2·Aim-Punch (weapon_recoil_scale): mit Punch muss die Abweichung deutlich kleiner sein
  dpit.push(Math.abs(d.shot.pitch[i] - s.pitch)); dpun.push(Math.abs(d.shot.pitch[i] - s.pitch - 2 * s.aimP))
}
console.log(`Schuss-pitch vs. Blick: ohne Punch p50 ${quant(dpit, 0.5)} p90 ${quant(dpit, 0.9)}°, mit 2·Aim-Punch p50 ${quant(dpun, 0.5)} p90 ${quant(dpun, 0.9)}°`)
assert.ok(quant(dpun, 0.9) < quant(dpit, 0.9) / 2, 'Aim-Punch erklärt den Schuss-pitch nicht')
// punchAt gegen den nächsten Basiswert aus der Demo (Exi-Spray R2, Ticks 44784 → 44790: Basis −4.730/−1.356)
const pa = punchAt([[[-4.604, -0.807, 0]], [[-71.665, -23.519, 0]], [107972], [0.4382], [[-1.834, -0.864, 0]], [107970], [0.9382], [53992.8382]], 0, 64)
assert.ok(Math.abs(pa[0] + 4.730) < 0.03 && Math.abs(pa[1] + 1.356) < 0.03 && pa[2] > -1.834 * 0.2 && pa[2] < 0, `punchAt ${pa}`)
// Exi R2 14.11–14.70 s (7 AK-Schüsse): Blick sinkt, Kamera mit Punch bleibt ruhiger
const ex = H.players.findIndex(p => p.name === 'Exi'), R2 = m.rounds[1]
if (ex >= 0 && R2) {
  const cam: number[] = [], eye: number[] = []
  for (let t = R2.freezeEndTick + 14.11 * 64; t <= R2.freezeEndTick + 14.7 * 64; t += 2) if (samplePlayer(d, ex, t, s)) { eye.push(s.pitch); cam.push(s.pitch + s.viewP + 0.9 * s.aimP) }
  const span = (a: number[]) => `${Math.min(...a).toFixed(2)}..${Math.max(...a).toFixed(2)}`
  console.log(`Exi R2 14.11–14.70 s: Blick-pitch ${span(eye)}°, Kamera-pitch (Blick + View + 0.9·Aim) ${span(cam)}°`)
}
console.log(`Schuss vs. Spur: xy p50 ${quant(dxy, 0.5)} p99 ${quant(dxy, 0.99)} u, Augenhöhe p50 ${quant(dz, 0.5)} p99 ${quant(dz, 0.99)} u, ` +
  `yaw p50 ${quant(dyaw, 0.5)} p99 ${quant(dyaw, 0.99)}°`)
// Voice
const seqGaps = (() => { let g = 0; const last = new Map<string, number>(); for (const v of vp) { const l = last.get(v.steamid); if (l !== undefined && v.seq !== undefined && v.seq !== l + 1) g++; if (v.seq !== undefined) last.set(v.steamid, v.seq) } return g })()
console.log(`Voice: ${vp.length} Pakete, ${(d.voice.data.length / 1024).toFixed(0)} KB, Sprecher ${new Set(vp.map(v => v.steamid)).size}, seq fehlt ${vp.filter(v => v.seq === undefined).length}, seq-Sprünge ${seqGaps}`)
// Stichprobe: Runde 5, 20 s nach Freeze-Ende, erster Spieler
const r5 = Math.min(4, H.rounds.length - 1), R5 = H.rounds[r5], t5 = m.rounds[r5].freezeEndTick + 20 * 64
sampleTrack(d, r5, 0, t5, s)
const keys = Object.entries(BTN).filter(([, b]) => isDown(s.btnLo, s.btnHi, b)).map(([k]) => k)
console.log(`Stichprobe R${R5.num} Tick ${t5} ${H.players[R5.tracks[0]].name}: pos ${[s.x, s.y, s.z].map(v => v.toFixed(1))}, pitch ${s.pitch.toFixed(2)}, yaw ${wrapDeg(s.yaw).toFixed(2)}, ` +
  `duck ${s.duck.toFixed(2)}, v ${Math.hypot(s.vx, s.vy).toFixed(0)} u/s, weapon ${s.weapon}, ammo ${s.ammo}, flags ${s.flags}, keys ${keys.join('+') || '-'}, flash ${flashAt(d, R5.tracks[0], t5)}`)

// ---------------------------------------------------------------- interp.ts
// Frame-Ticks treffen die Stützstellen exakt; zwischen den Runden letzter Frame der vorigen
const R1 = H.rounds[1], p1 = R1.tracks[3], fb1 = d.frameBase[1] + 3 * R1.nFrames
assert.ok(samplePlayer(d, p1, R1.firstTick + 4 * 100, s)); assert.ok(Math.abs(s.x - d.x[fb1 + 100]) < 1e-3)
const R0 = H.rounds[0], last0 = R0.firstTick + 4 * (R0.nFrames - 1)
assert.equal(roundHold(d, last0 + 1), 0); assert.equal(roundHold(d, R1.firstTick), 1); assert.equal(roundHold(d, 0), 0)
const k0 = R0.tracks.indexOf(p1), fb0 = d.frameBase[0] + k0 * R0.nFrames
if (k0 >= 0 && R1.firstTick > last0 + 4) { samplePlayer(d, p1, last0 + 3, s); assert.ok(Math.abs(s.x - d.x[fb0 + R0.nFrames - 1]) < 1e-3, 'Halten zwischen Runden') }
assert.equal(samplePlayer(d, 254, R1.firstTick, s), false)
assert.equal(wrapDeg(190), -170); assert.equal(wrapDeg(-180), -180); assert.equal(wrapDeg(540), -180); assert.equal(lerpDeg(170, -170, 0.5), 180)
// Teleport-Nachbar (sampleCR-Fix): Segment vor dem Sprung bleibt linear statt um ~6 % des Sprungs zu überschwingen
const syn = (xs: number[]): CS3D => decode3d(encode3d({
  matchId: 't', map: 'm', tickrate: 64, players: [{ steamid: '1', name: 'a', team: '', agent: { T: 0, CT: 0 } }], skins: [],
  rounds: [{ num: 1, firstTick: 0, nFrames: xs.length, tracks: [{ player: 0, x: xs, y: xs.map(() => 0), z: xs.map(() => 0),
    duck: xs.map(() => 0), btnLo: xs.map(() => 0), btnHi: xs.map(() => 0), flags: xs.map(() => 1), weapon: xs.map(() => 0), fov: xs.map(() => 0), ammo: xs.map(() => 0), skin: xs.map(() => 0),
    ...Object.fromEntries(['pitch', 'yaw', 'aimP', 'aimY', 'viewP', 'viewY'].map(k => [k, new Array(2 * xs.length - 1).fill(0)])) as Record<'pitch' | 'yaw' | 'aimP' | 'aimY' | 'viewP' | 'viewY', number[]> }] }],
  events: [], shots: [], nades: [], voice: [],
}))
const dt = syn([0, 10, 20, 30, 2000, 2010, 2020])
samplePlayer(dt, 0, 10, s); assert.ok(Math.abs(s.x - 25) < 0.3, `vor Sprung ${s.x}`)
samplePlayer(dt, 0, 18, s); assert.ok(Math.abs(s.x - 2005) < 0.3, `nach Sprung ${s.x}`)
console.log(`interp OK | maxRSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`)
