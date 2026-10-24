// Abnahme Paket AV: Aktions-Zeitleiste (actions.ts) + Viewmodel-Zustand (viewmodel.ts) auf der user-demo, ohne Electron.
//   node scripts/dev3d/actions-check.ts [<id>.3d.bin.gz]   (Standard: user-demo 4699fdaf49070d28; Exit-Code 1 bei verfehlter Abnahme)
// WeaponAssets wie prepare.ts aus dem Asset-Cache (items.json, viewmodel/table3.json bzw. table2.json, vm_<v>.json {dur, snd, win}).
// Alte vm_<v>.json (nur Dauern, vor dem AS-Bau): Block-/Ladeschleifen-Fenster aus dem animsound-Spike (vm_clip_events.json, gleiche CS2-Clips).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { PerformanceObserver } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { gunzipSync } from 'node:zlib'

// Renderer-Code nutzt Bundler-Auflösung (ohne Endung); agents.ts (Shader, 2D-Szene) braucht der Zustand nicht → Stub
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === './agents' && ctx.parentURL?.includes('/engine/viewmodel.ts'))
      return { url: 'data:text/javascript,export const SkinSlot={},adopt=()=>{},bindGlove=()=>{}', shortCircuit: true }
    if (/^\.\.?\//.test(spec) && !/\.[cm]?[jt]sx?$/.test(spec) && ctx.parentURL) {
      const u = new URL(spec + '.ts', ctx.parentURL)
      if (existsSync(fileURLToPath(u))) return next(u.href, ctx)
    }
    return next(spec, ctx)
  },
})
const { decode3d } = await import('../../src/shared/cs3d.ts')
const { actionsOf, vmRole } = await import('../../src/renderer/replay3d/actions.ts')
const { vmStateAt, layers, LAYERS } = await import('../../src/renderer/replay3d/engine/viewmodel.ts')
import type { WeaponAssets } from '../../src/shared/assets3d.ts'
import type { Action } from '../../src/renderer/replay3d/contracts.ts'
import { vmVariation } from '../../src/main/assets3d/models.ts'

const root = join(process.env.APPDATA!, 'CS Demo Analysis')
const file = process.argv[2] ?? join(root, 'matches', '4699fdaf49070d28.3d.bin.gz')
const A = readdirSync(join(root, 'assets3d')).map(p => join(root, 'assets3d', p)).find(p => existsSync(join(p, 'items.json')))!
const items = JSON.parse(readFileSync(join(A, 'items.json'), 'utf8')).items.weapons as Record<string, { cls: string }>
const tf = ['table3.json', 'table2.json'].map(f => join(A, 'viewmodel', f)).find(f => existsSync(f))!
const table = JSON.parse(readFileSync(tf, 'utf8')) as Record<string, { roles: Record<string, string> }>
const W: WeaponAssets = {}, oldVm: NonNullable<WeaponAssets[number]['vm']>[] = []
for (const [def, it] of Object.entries(items)) {
  const v = vmVariation(it.cls), dj = join(A, 'viewmodel', `vm_${v}.json`)
  W[+def] = { name: it.cls, className: it.cls, anim: 'rifle', root: [0, 0, 0] }
  if (!table[v] || !existsSync(dj)) continue
  const j = JSON.parse(readFileSync(dj, 'utf8'))
  W[+def].vm = j.dur ? { glb: '', clips: '', roles: table[v].roles, dur: j.dur, snd: j.snd, win: j.win ?? {} } : { glb: '', clips: '', roles: table[v].roles, dur: j }
  if (!j.dur) oldVm.push(W[+def].vm!)
}
const winFrom = `${tf.slice(-11)}, win: ${Object.values(W).filter(w => w.vm).length - oldVm.length} aus Assets, ${oldVm.length} aus Spike`
if (oldVm.length) {
  const ev = JSON.parse(readFileSync('../Daten/downloads/spike/animsound/anim-sound/vm_clip_events.json', 'utf8')) as Record<string, { events: { t: number; d: number; name?: string }[] }>
  const win: Record<string, { block?: [number, number][]; loop?: [number, number] }> = {}
  for (const [path, c] of Object.entries(ev)) {
    const leaf = path.split('/').pop()!, block = c.events.filter(e => e.name === 'WPN_BLOCK_INSPECT').map(e => [e.t, e.t + e.d] as [number, number])
    const lp = c.events.find(e => e.name === 'WPN_RELOAD_LOOP')
    if (block.length || lp) win[leaf] = { ...(block.length && { block }), ...(lp && { loop: [lp.t, lp.t + lp.d] as [number, number] }) }
  }
  for (const vm of oldVm) vm.win = win
}

const raw = gunzipSync(readFileSync(file)), d = decode3d(raw)
const H = d.header, rate = H.tickrate, step = H.frameStep
let fails = 0
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`); if (!ok) fails++ }
/** Plan-Soll mit dieser Demo nicht erreichbar (Grund in msg); geprüft wird der belegte Ist-Wert */
const dev = (ok: boolean, msg: string) => { console.log(`${ok ? 'ABW ' : 'FAIL'} ${msg}`); if (!ok) fails++ }

// ---- Aufbau
let t0 = performance.now()
const X = actionsOf(d, W)
const buildCold = performance.now() - t0, warm: number[] = []
for (let i = 0; i < 5; i++) { const di = decode3d(raw); t0 = performance.now(); actionsOf(di, W); warm.push(performance.now() - t0) } // je CS3D eigener Cache-Eintrag
warm.sort((a, b) => a - b)
check(actionsOf(d, W) === X, 'WeakMap-Cache liefert denselben Index')

// ---- Zahlen
const all: Action[] = H.players.flatMap((_, p) => X.list(p) as Action[])
const kinds: Record<string, number> = {}
for (const a of all) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1
const clipDur = (a: Action) => { const vm = W[a.def]?.vm; const c = vm?.roles[vmRole(a.kind, vm.roles)]; return c ? vm!.dur[c] ?? 0 : 0 }
const reloads = all.filter(a => a.kind === 'reload' || a.kind === 'reload_empty')
const roundEnd = (t: number) => { const R = H.rounds.findLast(R => R.firstTick <= t)!; return R.firstTick + R.nFrames * step }
const cutAll = reloads.filter(a => a.end < a.t0 + clipDur(a) * rate), cut = cutAll.filter(a => a.end < roundEnd(a.t0)).length
const knifeHits = (kinds.hit ?? 0) + (kinds.heavy_hit ?? 0) + (kinds.backstab ?? 0)
const sorted = H.players.every((_, p) => X.list(p).every((a, i, L) => a.t0 <= a.end && (i === 0 || L[i - 1].end <= a.t0)))
const jumps = H.players.reduce((s, _, p) => s + X.jumps(p).length, 0), hard = H.players.reduce((s, _, p) => s + X.jumps(p).filter(j => j.vz <= -340).length, 0)
console.log(`actions ${all.length} (${winFrom})`, JSON.stringify(kinds))
console.log(`jumps ${jumps} (landing <= -340 u/s: ${hard})`)
check(sorted, 'Listen sortiert, end = nächste Aktion oder früher')
check(reloads.length === 91, `Reload-Starts ${reloads.length} (Soll 91)`)
check(cut === 44, `Reloads mit end vor dem Clip-Ende ${cutAll.length}, ohne Rundenende ${cut} (Soll 44 = Spike cues2: Wechsel/Schuss/Tod, Rundenende nicht gezählt)`)
// 1049 F-Flanken (audit): 48 im Frame eines Waffenwechsels (wie Spike nicht gezählt), 65 in WPN_BLOCK_INSPECT-Fenstern der laufenden
// Aktion (Messer-Schwung 0–0,27/0,37 s, Deagle-/Talon-Ziehen) → 936
dev((kinds.inspect ?? 0) === 936, `Inspect-Aktionen ${kinds.inspect ?? 0} (Plan >= 1000: 1049 Flanken − 48 im Wechsel-Frame − 65 in CS2-Block-Fenstern)`)
// Messer-Schwünge mit player_hurt ±1 Tick: Opfer immer >= 1100 u entfernt (anderer Schütze); Plan-Soll kam aus Spike-Frames ohne Abstandsregel
dev(knifeHits === 0, `Messer-Treffer ${knifeHits} (Plan >= 30: user-demo hat keinen Messer-Treffer, Test synthetisch unten)`)

// ---- Inspect-Frames (wie Spike vmstate.ts: alle Spuren, 16 Hz, nur Frames mit Viewmodel)
let frames = 0, inspectFrames = 0, vmMs = 0, calls = 0
for (let r = 0; r < H.rounds.length; r++) {
  const R = H.rounds[r]
  R.tracks.forEach((p, k) => {
    for (let i = 0; i < R.nFrames; i++) {
      const tick = R.firstTick + i * step, s0 = performance.now(), st = vmStateAt(d, r, k, p, tick, W)
      if (st) layers(W[st.def].vm!, st, tick / rate)
      vmMs += performance.now() - s0; calls++
      if (!st) continue
      frames++
      if (X.at(p, tick)?.kind === 'inspect') inspectFrames++
    }
  })
}
check(Math.abs(inspectFrames / 22514 - 1) <= 0.05, `Inspect-Frames ${inspectFrames} von ${frames} (Soll 22514 ± 5 %)`)
const perFrame = vmMs / calls
check(perFrame <= 0.05, `Viewmodel-Logik (vmStateAt + layers) ${(perFrame * 1000).toFixed(2)} us/Bild (Soll <= 50 us)`)
check(buildCold <= 30 && warm[2] <= 30, `actionsOf ${buildCold.toFixed(1)} ms beim ersten Aufruf, Median warm ${warm[2].toFixed(1)} ms (${warm.map(x => x.toFixed(0)).join('/')}) (Soll <= 30 ms)`)

// ---- at(): Zeit und Allokationen (keine Scavenges in 5 Mio. Aufrufen)
const N = 5_000_000, ps = new Uint8Array(4096), ts = new Float64Array(4096), last = H.rounds.at(-1)!, end = last.firstTick + last.nFrames * step
for (let i = 0; i < ps.length; i++) { ps[i] = i % H.players.length; ts[i] = H.rounds[0].firstTick + ((i * 7919) % 4096) / 4096 * (end - H.rounds[0].firstTick) }
let gcs = 0
const obs = new PerformanceObserver(l => { gcs += l.getEntries().length })
let sink = 0
for (let i = 0; i < 200_000; i++) sink += X.at(ps[i & 4095], ts[i & 4095]) ? 1 : 0 // aufwärmen
setFlagsFromString('--expose-gc'); (runInNewContext('gc') as () => void)() // Altlasten vom Aufbau vorher wegräumen
obs.observe({ entryTypes: ['gc'] })
t0 = performance.now()
for (let i = 0; i < N; i++) sink += X.at(ps[i & 4095], ts[i & 4095]) ? 1 : 0
const atUs = ((performance.now() - t0) * 1000) / N
await new Promise(r => setTimeout(r, 50))
obs.disconnect()
check(atUs <= 1, `at() ${(atUs * 1000).toFixed(0)} ns im Mittel (Soll <= 1 us)`)
check(gcs === 0, `at(): ${gcs} GC-Läufe in ${N / 1e6} Mio. Aufrufen (0 = keine Allokation)`)

// ---- Zustands-Stichproben (feste Ticks aus Spike vmstate.json + erste Aktion je Art): Rolle, Clip-Zeit, Ebenen
const P = (name: string) => H.players.findIndex(p => p.name === name)
const sample = (label: string, p: number, tick: number, want?: string) => {
  const r = H.rounds.findLastIndex(R => R.firstTick <= tick), k = H.rounds[r]?.tracks.indexOf(p) ?? -1
  if (k < 0) return check(false, `${label}: Spieler ${p} nicht in Runde ${r}`)
  const a = X.at(p, tick), st = vmStateAt(d, r, k, p, tick, W)
  const lay = st ? LAYERS.slice(0, layers(W[st.def].vm!, st, tick / rate)).map(l => `${l[0]}@${l[1].toFixed(2)}x${l[2].toFixed(2)}`).join(' + ') : '-'
  const line = `${label}: tick ${tick} ${H.players[p].name} ${items[a?.def ?? 0]?.cls ?? '-'} kind=${a?.kind ?? '-'} role=${st?.action ?? '-'} t=${st?.t.toFixed(2) ?? '-'}${a?.n !== undefined ? ` n=${a.n}` : ''} | ${lay}`
  if (want) check(a?.kind === want, line); else console.log(`     ${line}`)
}
sample('Karambit inspect', P('tyrannus00'), 4380, 'inspect')
sample('Smoke pullpin', P('Kugel666'), 6348, 'pullpin')
sample('Messer kein Treffer (Spike-Fehltreffer: Opfer 1832 u weg)', P('Criminal_Boy'), 54704, 'light')
sample('HE unterhand', P('Exi'), 55204, 'throw_under')
const first = (pred: (a: Action) => boolean) => { for (let p = 0; p < H.players.length; p++) { const a = X.list(p).find(pred); if (a) return [p, a] as const } }
for (const [label, pred] of [
  ['AK inspect', (a: Action) => a.kind === 'inspect' && items[a.def]?.cls === 'weapon_ak47'],
  ['Messer inspect', (a: Action) => a.kind === 'inspect' && /knife/.test(items[a.def]?.cls ?? '')],
  ['Flash pullpin', (a: Action) => a.kind === 'pullpin' && items[a.def]?.cls === 'weapon_flashbang' && a.end - a.t0 > rate],
  ['Reload unterbrochen', (a: Action) => a.kind === 'reload' && a.end < a.t0 + clipDur(a) * rate],
  ['Schrotflinte', (a: Action) => a.n !== undefined],
  ['Elites rechts', (a: Action) => a.kind === 'shoot_right'],
] as const) {
  const hit = first(pred)
  if (!hit) { console.log(`     ${label}: keine in dieser Demo`); continue }
  const [p, a] = hit, t = Math.min(a.end - 1, a.t0 + Math.round(0.5 * rate))
  const r = H.rounds.findLastIndex(R => R.firstTick <= a.t0)
  sample(`${label} (+${((t - a.t0) / rate).toFixed(2)} s, Runde ${r + 1}, ${((a.t0 - H.rounds[r].firstTick) / rate).toFixed(1)} s, Spieler ${p})`, p, t)
}

// ---- Synthetisch (fehlt in user-demo): Messer-Treffer/Rückenstich, Schrotflinten-Schleife, Pin halten
{
  const [p, a] = first(a => a.kind === 'light')!, r = H.rounds.findLastIndex(R => R.firstTick <= a.t0), R = H.rounds[r], n = R.nFrames
  const k = R.tracks.indexOf(p), vk = (k + 1) % R.tracks.length, f = Math.floor((a.t0 - R.firstTick) / step)
  const hurt = (dmg: number) => { // Opfer 40 u neben den Schwung legen, player_hurt am selben Tick einfügen
    const d2 = decode3d(raw), E = d2.evt, at = E.tick.findIndex(t => t > a.t0), ins = <T extends Uint8Array | Uint16Array | Uint32Array>(x: T, v: number) => { const y = new (x.constructor as any)(x.length + 1) as T; y.set(x.subarray(0, at)); y[at] = v; y.set(x.subarray(at), at + 1); return y }
    const af = d2.frameBase[r] + k * n + f, vf = d2.frameBase[r] + vk * n + f
    d2.x[vf] = d2.x[af] + 40; d2.y[vf] = d2.y[af]; d2.z[vf] = d2.z[af]
    d2.evt = { tick: ins(E.tick, a.t0), type: ins(E.type, 5), player: ins(E.player, R.tracks[vk]), arg: ins(E.arg, dmg) }
    return actionsOf(d2, W).at(p, a.t0)?.kind
  }
  check(hurt(34) === 'hit' && hurt(90) === 'backstab', `Messer-Treffer synthetisch: dmg 34 → ${hurt(34)}, dmg 90 → ${hurt(90)}`)
  const vm = { glb: '', clips: '', roles: { idle: 'idle_nova', reload: 'reload_nova', pullpin: 'pullpin_flash' }, dur: { idle_nova: 1, reload_nova: 1.6333, pullpin_flash: 0.9667 }, win: { reload_nova: { loop: [0.367, 0.8] as [number, number] } } }
  const L = (action: 'reload' | 'pullpin', t: number, n?: number) => LAYERS.slice(0, layers(vm, { def: 35, action, t, empty: false, n }, 0)).map(l => `${l[0]}@${l[1].toFixed(3)}x${l[2].toFixed(2)}`).join('+')
  const got = [L('reload', 0.2, 3), L('reload', 0.9, 3), L('reload', 1.7, 3), L('reload', 2.6, 3), L('reload', 1, 1), L('pullpin', 5)]
  const want = ['reload_nova@0.200x1.00', 'reload_nova@0.467x1.00', 'reload_nova@0.834x1.00', 'reload_nova@1.633x0.33+idle_nova@0.000x0.67', 'reload_nova@1.000x1.00', 'pullpin_flash@0.967x1.00']
  check(got.join() === want.join(), `Schleife n=3 (Intro, 3× 0,367–0,8 s, Outro, Länge 2,50 s) + Pin hält: ${got.join(' | ')}`)
}
void sink
console.log(fails ? `${fails} FAIL` : 'alle Abnahmen OK')
process.exitCode = fails ? 1 : 0
