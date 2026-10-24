// Sound-Log Paket SD (Vorlage: animsound-Spike anim-sound/sfxlog.ts): zählt die von buildCues geplanten Sounds der user-demo und prüft sie
// gegen die Demo (Reload-Flanken, Clip-Zeiten, player_footstep, Schritt-Regeln) + Zeit von buildCues und audio.update (Mock-AudioContext).
//   node --experimental-transform-types scripts/dev3d/sfxlog.ts [<app>.3d.bin.gz] [<v5>.3d.bin.gz]   (Exit-Code 1 bei verfehlter Abnahme)
// v4 = App-Datei ohne player_footstep und ohne Server-Sounds (wie ein alter Import: Landungen über Fallgeschwindigkeit, Schritte nach
// stepCues), v5 = mit player_footstep (Standard: Cache von parse3d-test.ts). Die Demo-Landungen für den v4-Vergleich kommen aus den
// player_footstep der v5-Datei. v6 = App-Datei wie sie ist: Schritte/Landungen = Server-Sounds der Demo, nur-lokale Clip-Sounds.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

// Renderer-Code nutzt Bundler-Auflösung (ohne Endung)
registerHooks({
  resolve(spec, ctx, next) {
    if (/^\.\.?\//.test(spec) && !/\.[cm]?[jt]sx?$/.test(spec) && ctx.parentURL) {
      const u = new URL(spec + '.ts', ctx.parentURL)
      if (existsSync(fileURLToPath(u))) return next(u.href, ctx)
    }
    return next(spec, ctx)
  },
})
const { decode3d, EV, FLAG, TELEPORT, newSample, roundAt, sampleTrack, soundHash } = await import('../../src/shared/cs3d.ts')
const { parseFloorGrid } = await import('../../src/shared/assets3d.ts')
const { actionsOf, vmRole } = await import('../../src/renderer/replay3d/actions.ts')
const { buildCues, maxSpeed } = await import('../../src/renderer/replay3d/audio/sfx.ts')
const { createAudio } = await import('../../src/renderer/replay3d/audio/index.ts')
import type { CS3D } from '../../src/shared/cs3d.ts'
import type { SoundMap, WeaponAssets } from '../../src/shared/assets3d.ts'
import type { MatchData, Side } from '../../src/shared/model.ts'
import type { Cue } from '../../src/renderer/replay3d/audio/sfx.ts'
import { vmVariation } from '../../src/main/assets3d/models.ts'

const root = join(process.env.APPDATA!, 'CS Demo Analysis'), id = '4699fdaf49070d28'
const f4 = process.argv[2] ?? join(root, 'matches', `${id}.3d.bin.gz`)
const f5 = process.argv[3] ?? `../Daten/downloads/spike/build/data3d/${id}.3d.bin.gz`
const A = readdirSync(join(root, 'assets3d')).map(p => join(root, 'assets3d', p)).find(p => existsSync(join(p, 'items.json')))!
const json = (f: string) => JSON.parse(readFileSync(f, 'utf8'))

// WeaponAssets und SoundMap wie prepare.ts (sound_map.json + sounds2.json)
const items = json(join(A, 'items.json')).items.weapons as Record<string, { cls: string }>
const table = json(join(A, 'viewmodel', 'table3.json')) as Record<string, { roles: Record<string, string> }>
const W: WeaponAssets = {}
for (const [def, it] of Object.entries(items)) {
  const v = vmVariation(it.cls), dj = join(A, 'viewmodel', `vm_${v}.json`)
  W[+def] = { name: it.cls, className: it.cls, anim: 'rifle', root: [0, 0, 0] }
  if (!table[v] || !existsSync(dj)) continue
  const j = json(dj)
  if (j.dur) W[+def].vm = { glb: '', clips: '', roles: table[v].roles, dur: j.dur, snd: j.snd, win: j.win ?? {} }
}
const sm = json(join(A, 'sounds', 'sound_map.json')) as SoundMap, s2 = json(join(A, 'sounds', 'sounds2.json'))
sm.mixgroupVol = { ...s2.mixgroupVol, ...sm.mixgroupVol }
Object.assign(sm.map, s2.map)
const fb = readFileSync(join(A, 'maps', 'de_dust2', 'high', 'floor.bin')), floorBuf = fb.buffer.slice(fb.byteOffset, fb.byteOffset + fb.byteLength) as ArrayBuffer
const floor = parseFloorGrid(floorBuf)
const match = JSON.parse(gunzipSync(readFileSync(join(root, 'matches', `${id}.json.gz`))).toString()) as MatchData
const load = (f: string) => decode3d(gunzipSync(readFileSync(f)))
const sideOf = (d: CS3D) => {
  const sides = d.header.rounds.map(R => new Map(match.rounds.find(m => m.num === R.num)?.tracks.map(t => [t.steamid, t.side])))
  return (r: number, p: number): Side => sides[r].get(d.header.players[p].steamid) ?? 'CT'
}

let fails = 0
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`); if (!ok) fails++ }
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN }
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }

/** Cues bauen, Zeit getrennt wie im Plan (laden_einmalig: actionsOf 30 ms, die Engine ruft es beim Laden; buildCues 100 ms) */
function build(d: CS3D) {
  let t = performance.now()
  actionsOf(d, W)
  const act = performance.now() - t
  t = performance.now()
  const cues = buildCues(d, sm, sideOf(d), floor, W)
  return { cues, ms: performance.now() - t, act }
}

/** Frame (Runde r, Track k, Index i) von Spieler p bei tick oder null */
function frameAt(d: CS3D, p: number, tick: number) {
  const r = roundAt(d, tick), R = d.header.rounds[r], k = R ? R.tracks.indexOf(p) : -1
  if (k < 0) return null
  const i = Math.floor((tick - R.firstTick) / d.header.frameStep)
  return { r, k, i, j: d.frameBase[r] + k * R.nFrames + i, n: R.nFrames, first: R.firstTick }
}

/** ohne Server-Sounds (wie vor v6) */
const noSnd = (x: CS3D): CS3D => ({ ...x, snd: { tick: new Uint32Array(0), ev: new Uint16Array(0), player: new Uint8Array(0) } })
/** wie ein alter Import: ohne player_footstep (v5) und ohne Server-Sounds (v6) */
function legacy(x: CS3D): CS3D {
  const E = x.evt, keep = Array.from(E.type.keys()).filter(i => E.type[i] !== EV.player_footstep)
  return { ...noSnd(x), evt: { tick: Uint32Array.from(keep, i => E.tick[i]), type: Uint8Array.from(keep, i => E.type[i]), player: Uint8Array.from(keep, i => E.player[i]), arg: Uint16Array.from(keep, i => E.arg[i]) } }
}

// ======================= v4: Reloads, Clip-Sounds, Messer, Schritte, Zeiten =======================
const d6 = load(f4), d = legacy(d6), H = d.header, rate = H.tickrate, step = H.frameStep
console.log(`v4: ${f4} (CS3D v${H.version} ohne player_footstep/Server-Sounds), Assets ${A}`)
const { cues, ms: buildMs, act: actMs } = build(d)
const X = actionsOf(d, W), C = sm.map.clip ?? {}
const kinds: Record<string, number> = {}
for (const c of cues) kinds[c.k] = (kinds[c.k] ?? 0) + 1
console.log(`Cues ${cues.length}, je Typ ${JSON.stringify(kinds)}`)
check(buildMs <= 100, `buildCues ${buildMs.toFixed(1)} ms (kalt) <= 100 ms; actionsOf vorher ${actMs.toFixed(1)} ms (Plan 30, Paket AV)`)

// --- Nachladen: je FLAG.reloading-Flanke (lebend) die Reload-Cues desselben Spielers in [Flanke, Flanke + 4 s]
const byP = new Map<number, Cue[]>()
for (const c of cues) if (c.src < 1000) (byP.get(c.src) ?? byP.set(c.src, []).get(c.src)!).push(c)
const edges: { p: number; tick: number; def: number; empty: boolean }[] = []
for (let r = 0; r < H.rounds.length; r++) {
  const R = H.rounds[r], n = R.nFrames
  R.tracks.forEach((p, k) => {
    const b = d.frameBase[r] + k * n
    for (let i = 1; i < n; i++) {
      const f = d.flags[b + i], f0 = d.flags[b + i - 1]
      if (f & FLAG.alive && f0 & FLAG.alive && f & FLAG.reloading && !(f0 & FLAG.reloading)) edges.push({ p, tick: R.firstTick + i * step, def: d.weapon[b + i], empty: d.ammo[b + i - 1] === 0 })
    }
  })
}
let silent = 0, early = 0
const errs: number[] = [], why: string[] = []
for (const e of edges) {
  const mine = (byP.get(e.p) ?? []).filter(c => c.k === 'reload' && c.t * rate >= e.tick && c.t * rate <= e.tick + 4 * rate)
  // Soll-Zeit je Teil: Clip des Reloads (reload_empty bei leerem Magazin) aus vm.snd ab der Flanke; Schleifenteile: nächster Soll-Zeitpunkt
  const vm = W[e.def]?.vm, clip = vm?.roles[vmRole(e.empty ? 'reload_empty' : 'reload', vm.roles)] ?? '', snd = vm?.snd?.[clip] ?? []
  if (!mine.length) {
    // stumm ist richtig, wenn die Aktion (Wechsel, Tod, Rundenende) vor dem ersten Clip-Sound endet: CS2 bricht den Clip ebenso ab
    const a = X.at(e.p, e.tick)
    silent++
    if (a && /^reload/.test(a.kind) && snd.length && a.end < e.tick + snd[0][0] * rate) early++
    const by = a && X.list(e.p).find(b => b.t0 === a.end)
    why.push(`${W[e.def]?.name} ${a ? ((a.end - e.tick) / rate).toFixed(2) : '?'}s<${snd[0]?.[0].toFixed(2)}s ${by ? by.kind : 'Tod/Runde'}`)
    continue
  }
  for (const c of mine) {
    const ev = c.defs[0].ev, want = snd.filter(s => C[s[1]]?.[0]?.ev === ev).map(s => e.tick / rate + s[0])
    errs.push(want.length ? Math.min(...want.map(w => Math.abs(c.t - w))) : Infinity)
  }
}
check(edges.length === 91 && silent === early, `Reloads mit Ton ${edges.length - silent}/${edges.length} (Plan 91/91); stumm ${silent}, davon vor dem ersten Clip-Sound abgebrochen ${early} (Soll: alle stummen) ${JSON.stringify(why)}`)
check(med(errs) <= 0.05, `Nachlade-Fehler Median ${med(errs).toFixed(3)} s, p90 ${q(errs, 0.9).toFixed(3)} s, n ${errs.length} (Soll <= 0,05 s)`)

// --- Clip-Sounds: jeder Cue muss in seiner Aktion liegen (nichts nach Abbruch = action.end)
const CLIPK = new Set(['draw', 'reload', 'shoot', 'inspect', 'pullpin', 'plant', 'silencer', 'knife'])
let after = 0, afterReload = 0
for (const c of cues) {
  if (!CLIPK.has(c.k)) continue
  const a = X.at(c.src, Math.round(c.t * rate))
  if (!a) { after++; if (c.k === 'reload') afterReload++ }
}
check(afterReload === 0, `Reload-Teile nach Abbruch ${afterReload} (Soll 0); alle Clip-Typen außerhalb ihrer Aktion: ${after}`)

// Plan „177“ = Soundevents in den Clips der Aktionen dieser Demo, die vor dem Aktionsende liegen (Wurf ohne: den spielt weapon_fire);
// fehlt = kein SoundDef oder nie geplant
const used = new Set<string>(), planned = new Set<string>()
for (let p = 0; p < H.players.length; p++) for (const a of X.list(p)) {
  const vm = W[a.def]?.vm, role = vm && vmRole(a.kind, vm.roles), clip = role && role !== 'idle' && !/^throw/.test(a.kind) ? vm!.roles[role] : ''
  for (const [t, ev] of (clip && vm!.snd?.[clip]) || []) if (a.t0 + t * rate < a.end) used.add(ev)
}
for (const c of cues) if (CLIPK.has(c.k)) for (const def of c.defs) planned.add(def.ev)
const noDef = [...used].filter(ev => !C[ev]?.length), never = [...used].filter(ev => C[ev]?.length && !C[ev].some(x => planned.has(x.ev)))
check(noDef.length === 0 && never.length === 0, `Clip-Sounds der Demo-Aktionen: ${used.size}, ohne SoundDef ${noDef.length}, nie geplant ${never.length} ${JSON.stringify([...noDef, ...never].slice(0, 8))}`)

// --- Messer: Schwung aus den Clips (Swish), Treffer mit Hit.*
const knife = cues.filter(c => c.k === 'knife'), kev: Record<string, number> = {}
for (const c of knife) for (const x of c.defs) kev[`${x.ev} vol ${x.vol}`] = (kev[`${x.ev} vol ${x.vol}`] ?? 0) + 1
const light = sm.map.clip?.['Weapon_Knife.Swish.Light']?.[0]
check(light?.vol === 0.03 && knife.some(c => c.defs[0].ev === 'Weapon_Knife.Swish.Light') && !cues.some(c => c.defs.some(x => /Knife\.Slash/.test(x.ev))),
  `Messer-Schwung Weapon_Knife.Swish.Light vol ${light?.vol} (Soll 0,03), kein Weapon_Knife.Slash; Messer-Cues ${knife.length}: ${JSON.stringify(Object.entries(kev).sort((a, b) => b[1] - a[1]).slice(0, 6))}`)

// --- Schritte (Regel ohne Server-Sounds, sfx.ts stepCues): nie in der Luft/tot/unter 0.55 × Maxtempo der Waffe, Takt 0.3/0.4 s
const dt = step / rate
let bad = 0, n = 0
const gaps: number[] = [], lastStep = new Map<number, number>()
for (const c of cues) {
  if (c.k !== 'step') continue
  n++
  // Schritt liegt im Frame, an dessen Ende der Takt abläuft (letzter Frame der Runde: der selbst)
  const tick = Math.round(c.t * rate), F = frameAt(d, c.src, tick + step - 1) ?? frameAt(d, c.src, tick)
  if (!F || F.i < 1) { bad++; continue }
  const j = F.j, f = d.flags[j], v = Math.hypot(d.x[j] - d.x[j - 1], d.y[j] - d.y[j - 1]) / dt
  if (f & FLAG.airborne || !(f & FLAG.alive) || v < 0.55 * maxSpeed(d.weapon[j], (f & FLAG.scoped) !== 0) - 0.5) bad++
  const l = lastStep.get(c.src); if (l !== undefined && c.t - l < 0.6) gaps.push(c.t - l)
  lastStep.set(c.src, c.t)
}
check(bad === 0, `Schritt-Sounds in der Luft/tot/unter 0,55 × Waffen-Maxtempo: ${bad} von ${n} (Soll 0); Abstand Median ${med(gaps).toFixed(3)} s, p10 ${q(gaps, 0.1).toFixed(3)} s (CS2 0,313/0,297)`)
check(!cues.some(c => c.defs.some(x => x.ev === 'Default.Land')), 'kein Default.Land mehr')

// ======================= Sprung/Landung =======================
const jl = (cs: Cue[]) => cs.filter(c => c.k === 'jump' || c.k === 'land')
/** Demo-player_footstep der v5-Datei: Landung = im 16-Hz-Frame vor dem Event in der Luft, Absprung = danach in der Luft */
let landEv: { p: number; tick: number }[] = [], upEv: typeof landEv = []
if (existsSync(f5)) {
  const d5 = noSnd(load(f5)) // auch eine neuere Datei prüft hier nur den player_footstep-Weg
  console.log(`v5: ${f5} (CS3D v${d5.header.version})`)
  const { cues: c5, ms: ms5, act: act5 } = build(d5)
  check(ms5 <= 100, `buildCues v5 ${ms5.toFixed(1)} ms <= 100 ms (actionsOf vorher ${act5.toFixed(1)} ms)`)
  const E = d5.evt, all: { p: number; tick: number; kind: string }[] = []
  for (let e = 0; e < E.tick.length; e++) {
    if (E.type[e] !== EV.player_footstep) continue
    const p = E.player[e], t = E.tick[e], F = frameAt(d5, p, t - 1)
    if (!F || F.i + 1 >= F.n) { all.push({ p, tick: t, kind: 'none' }); continue }
    const before = d5.flags[F.j] & FLAG.airborne, after1 = d5.flags[F.j + 1] & FLAG.airborne
    all.push({ p, tick: t, kind: before && !after1 ? 'land' : !before && after1 ? 'takeoff' : before ? 'air' : 'ground' })
  }
  const cnt: Record<string, number> = {}
  for (const e of all) cnt[e.kind] = (cnt[e.kind] ?? 0) + 1
  const cj = jl(c5), key = (p: number, t: number) => p * 1e7 + t, has = new Set(cj.map(c => key(c.src, Math.round(c.t * rate))))
  // player_footstep meldet nur Absprünge und harte Landungen (fsratio: 0 Bodenschritte); 'air' = beides im selben 16-Hz-Frame
  const tl = all.filter(e => e.kind !== 'none'), voiced = tl.filter(e => has.has(key(e.p, e.tick))).length
  check(voiced === tl.length, `mit player_footstep: Absprung/Landung vertont ${voiced}/${tl.length} (Soll alle, Plan 1183); Events ${all.length} ${JSON.stringify(cnt)}, Cues jump ${cj.filter(c => c.k === 'jump').length} land ${cj.filter(c => c.k === 'land').length}`)
  landEv = all.filter(e => e.kind === 'land')
  upEv = all.filter(e => e.kind === 'takeoff')
} else console.log(`v5-Datei fehlt (${f5}): Sprung/Landung mit player_footstep nicht geprüft`)

// ohne player_footstep (v4): Landungs-/Absprung-Cues gegen die Demo-Events, gleicher Spieler ±0,15 s
{
  const w = 0.15 * rate, near = (p: number, t: number) => (c: Cue) => c.src === p && Math.abs(c.t * rate - t) <= w
  const cmp = (k: string, ev: typeof landEv) => {
    const cs = cues.filter(c => c.k === k)
    return { n: cs.length, hit: ev.filter(e => cs.some(near(e.p, e.tick))).length, extra: cs.filter(c => !ev.some(e => near(e.p, e.tick)(c))).length }
  }
  const L = cmp('land', landEv), U = cmp('jump', upEv)
  if (landEv.length) check(L.hit >= 180 && L.extra <= 30, `ohne player_footstep: Landungen getroffen ${L.hit}/${landEv.length} (Soll >= 180/202), zusätzlich ${L.extra} (Soll <= 30), Land-Cues ${L.n}`)
  console.log(`ohne player_footstep: Absprünge getroffen ${U.hit}/${upEv.length}, zusätzlich ${U.extra}, Jump-Cues ${U.n} (Info, ohne Plan-Soll)`)
}

// ======================= v6: Server-Schritte der Demo, nur-lokale Clip-Sounds =======================
if (d6.snd.tick.length) {
  const { cues: c6 } = build(d6), k6: Record<string, number> = {}
  for (const c of c6) k6[c.k] = (k6[c.k] ?? 0) + 1
  // Server-Sounds mit bekanntem Namen (Schritt/Landung der Sound-Map) müssen alle als Cue kommen, sonst keine erfundenen Schritte
  const names = new Set([...Object.keys(sm.map.footsteps).filter(k => /^(CT|T)_.+\.StepLeft$/.test(k)), ...Object.values(sm.map.land ?? {}).map(x => x[0].ev)].map(soundHash))
  // nur in Runden (zwischen den Runden gibt es keine Spur)
  const known = Array.from(d6.snd.ev).filter((e, i) => names.has(d6.header.sounds![e]) && roundAt(d6, d6.snd.tick[i]) >= 0).length
  check((k6.step ?? 0) + (k6.land ?? 0) === known && !k6.jump, `v6: Schritt-/Landungs-Cues ${(k6.step ?? 0)}/${k6.land ?? 0} = Server-Sounds der Demo ${known} (Soll gleich), keine erfundenen Absprünge (${k6.jump ?? 0}); alte Regel ergab ${n} Schritte`)
  // nur-lokal (CS2 metadata localplayeronly): je Typ, wie viele Clip-Sounds anderer Spieler bisher hörbar waren (jetzt nur in Ego-Sicht des Spielers)
  const loc: Record<string, number> = {}, all: Record<string, number> = {}
  for (const c of c6) for (const x of c.defs) if (CLIPK.has(c.k)) { all[c.k] = (all[c.k] ?? 0) + 1; if (x.local) loc[c.k] = (loc[c.k] ?? 0) + 1 }
  const nLoc = Object.values(loc).reduce((a, b) => a + b, 0)
  check(nLoc > 0 && (loc.pullpin ?? 0) > 0 && (loc.draw ?? 0) > 0 && !loc.knife,
    `v6: nur-lokale Clip-Sounds ${nLoc} (je Typ ${JSON.stringify(loc)} von ${JSON.stringify(all)}): Free-Cam spielt keinen, Ego nur die des Beobachteten; Messer/Nachladen-Teile bleiben für alle (Soll: Ziehen + Pin lokal, Messer nie)`)
}

// ======================= audio.update je Bild (Mock-AudioContext, ganze Demo bei 60 fps, Hörer = Spieler 0) =======================
{
  let simMs = 1000, srcs: { end: number; s: any }[] = []
  const param = () => ({ value: 0, setTargetAtTime() {}, cancelScheduledValues() {} })
  class Ctx {
    currentTime = 1; baseLatency = 0; outputLatency = 0; state = 'running'; destination = {}
    getOutputTimestamp() { return { contextTime: this.currentTime, performanceTime: simMs } }
    createGain() { return { gain: param(), connect: (x: any) => x, disconnect() {} } }
    createStereoPanner() { return { pan: param(), connect: (x: any) => x, disconnect() {} } }
    createDynamicsCompressor() { return { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), connect: (x: any) => x } }
    createBufferSource() {
      const s: any = { playbackRate: param(), loop: false, onended: null, connect: (x: any) => x }, e = { end: Infinity, s }
      s.start = (w: number) => { e.end = s.loop ? Infinity : w + s.buffer.duration }
      s.stop = (t: number) => { e.end = Math.min(e.end, t) }
      srcs.push(e)
      return s
    }
    decodeAudioData = async () => ({ duration: 1 }) // shortcut: jede Datei 1 s lang (echte 0,1–14 s), für die Kosten je Bild reicht das
    resume = async () => { this.state = 'running' }
    suspend = async () => { this.state = 'suspended' }
    close = async () => {}
  }
  // Fenster sichtbar (audio/index.ts hält den Kontext bei document.hidden an)
  const document = { hidden: false, addEventListener() {}, removeEventListener() {} }
  Object.assign(globalThis, { AudioContext: Ctx, document, fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }) })
  const realNow = performance.now.bind(performance)
  performance.now = () => simMs // Prefetch-Takt (0,5 s) und Watchdog laufen in Demo-Zeit
  const audio = await createAudio({ d, match }, { sounds: { base: '', map: sm }, weapons: W, map: undefined })
  audio.setVolume('voice', 0)
  const S = newSample(), times: number[] = []
  const t0 = H.rounds[0].firstTick, t1 = H.rounds.at(-1)!.firstTick + H.rounds.at(-1)!.nFrames * step
  let lx = 0, ly = 0, lz = 0, frame = 0
  for (let tick = t0; tick < t1; tick += rate / 60, frame++) {
    simMs += 1000 / 60
    const ctx = (audio as any).ctx as Ctx
    ctx.currentTime += 1 / 60
    const r = roundAt(d, tick), k = r >= 0 ? H.rounds[r].tracks.indexOf(0) : -1
    if (k >= 0) { sampleTrack(d, r, k, tick, S); lx = S.x; ly = S.y; lz = S.z + 64 }
    const a = realNow()
    audio.update({ tick, playing: true, speed: 1, at: simMs }, { x: lx, y: ly, z: lz, yaw: S.yaw, ego: 0 }) // Ego-Sicht von Spieler 0
    times.push(realNow() - a)
    // beendete Quellen melden (wie WebAudio onended)
    const now = ctx.currentTime
    srcs = srcs.filter(e => { if (e.end > now) return true; e.s.onended?.(); return false })
    if (frame % 30 === 0) await new Promise(r => setImmediate(r)) // Dateien „laden“
  }
  performance.now = realNow
  const st = audio.stats().sfx!
  audio.dispose()
  const mean = times.reduce((a, b) => a + b, 0) / times.length
  check(mean <= 0.1, `audio.update ${mean.toFixed(4)} ms/Bild Mittel, p99 ${q(times, 0.99).toFixed(3)} ms, max ${q(times, 1).toFixed(2)} ms über ${times.length} Bilder (Soll <= 0,1 ms)`)
  check(st.maxActive <= 48, `Stimmen aktiv max ${st.maxActive} (Cap 48; inkl. ausblendender ${st.maxLive}); gestartet ${st.started}, gecullt ${st.culled}, Cap-Treffer ${st.capped}, fehlend ${st.missing}, nur-lokal anderer übersprungen ${st.local}`)
}

console.log(fails ? `${fails} Abnahme(n) verfehlt` : 'alle Abnahmen OK')
process.exit(fails ? 1 : 0)
