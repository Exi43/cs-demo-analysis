// Schritt-Regel gegen die echten CS2-Schritte (Server-Sounds der Demo, CS3D v6) eichen:
//   node scripts/dev3d/steps-calib.ts [<id>.v6.3d.bin.gz]
// Je Schritt: Tempo (16 Hz), Anteil am Waffen-Maxtempo, Abstand zum vorigen Schritt (Weg/Zeit); je Bewegungs-Frame ohne Schritt das Tempo.
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
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
const { decode3d, FLAG, roundAt, soundHash } = await import('../../src/shared/cs3d.ts')
const { maxSpeed, stepCues, STEP_RULE } = await import('../../src/renderer/replay3d/audio/sfx.ts')

const f = process.argv[2] ?? '../Daten/downloads/spike/build/data3d/4699fdaf49070d28.v6.3d.bin.gz'
const d = decode3d(gunzipSync(readFileSync(f))), H = d.header, rate = H.tickrate, step = H.frameStep
const steps = new Set<number>()
for (const side of ['CT', 'T']) for (const s of ['Concrete', 'Sand', 'Gravel', 'Tile', 'Wood_Panel', 'Dirt', 'Default', 'MetalBarrel', 'SolidMetal', 'Wood', 'WoodBox', 'Wood_Basket', 'MetalVehicle', 'Glass', 'Flesh', 'Rubber', 'Plastic_Box', 'MetalGrate', 'Mud', 'Grass', 'Metal', 'Carpet', 'Chainlink', 'MetalVent', 'Water', 'Snow', 'Ladder'])
  steps.add(soundHash(`${side}_${s}.StepLeft`))
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN }
const at = (p: number, tick: number) => {
  const r = roundAt(d, tick), R = H.rounds[r], k = R ? R.tracks.indexOf(p) : -1
  if (k < 0) return null
  const i = Math.max(1, Math.min(R.nFrames - 1, Math.round((tick - R.firstTick) / step))), j = d.frameBase[r] + k * R.nFrames + i
  return { j, v: Math.hypot(d.x[j] - d.x[j - 1], d.y[j] - d.y[j - 1]) * rate / step, r, k }
}
const vs: number[] = [], frac: number[] = [], fracAbs: number[] = [], gapU: number[] = [], gapS: number[] = [], walk: number[] = [], duck: number[] = []
const last = new Map<number, number>(), stepFrames = new Set<number>()
let n = 0
for (let i = 0; i < d.snd.tick.length; i++) {
  if (!steps.has(H.sounds![d.snd.ev[i]])) continue
  const p = d.snd.player[i], t = d.snd.tick[i], a = at(p, t)
  if (!a) continue
  n++; stepFrames.add(a.j)
  const fl = d.flags[a.j], ms = maxSpeed(d.weapon[a.j], (fl & FLAG.scoped) !== 0)
  vs.push(a.v); frac.push(a.v / ms); fracAbs.push(a.v / 250)
  if (fl & FLAG.walking) walk.push(a.v)
  if (d.duck[a.j] >= 0.5) duck.push(a.v)
  const l = last.get(p)
  if (l !== undefined && t - l < rate) { gapS.push((t - l) / rate) }
  last.set(p, t)
}
console.log(`Schritte ${n}: Tempo p1 ${q(vs, 0.01).toFixed(0)} p5 ${q(vs, 0.05).toFixed(0)} Median ${q(vs, 0.5).toFixed(0)} u/s; Anteil Waffen-Max p1 ${q(frac, 0.01).toFixed(2)} p5 ${q(frac, 0.05).toFixed(2)}; Anteil 250 p1 ${q(fracAbs, 0.01).toFixed(2)} p5 ${q(fracAbs, 0.05).toFixed(2)}`)
console.log(`  mit Shift ${walk.length} (Tempo Median ${q(walk, 0.5).toFixed(0)}), geduckt ${duck.length} (Median ${q(duck, 0.5).toFixed(0)}); Abstand gleicher Spieler Median ${q(gapS, 0.5).toFixed(3)} s p10 ${q(gapS, 0.1).toFixed(3)} p90 ${q(gapS, 0.9).toFixed(3)}`)
// Bewegungs-Frames ohne Schritt in ±2 Frames: Tempo-Verteilung je Anteil (wo liegt die Schwelle?)
const bins = new Map<number, [number, number]>() // Anteil Waffen-Max (0.05-Schritte) → [Frames mit Schritt in ±2, alle]
const binsA = new Map<number, [number, number]>()
for (let r = 0; r < H.rounds.length; r++) {
  const R = H.rounds[r]
  for (let k = 0; k < R.tracks.length; k++) {
    const fb = d.frameBase[r] + k * R.nFrames
    for (let i = 3; i < R.nFrames - 3; i++) {
      const j = fb + i, fl = d.flags[j]
      if (!(fl & FLAG.alive) || fl & FLAG.airborne) continue
      const v = Math.hypot(d.x[j] - d.x[j - 1], d.y[j] - d.y[j - 1]) * rate / step
      if (v < 20 || v > 300) continue
      let hit = false
      for (let o = -3; o <= 3; o++) if (stepFrames.has(j + o)) hit = true
      const b = Math.floor(v / maxSpeed(d.weapon[j], (fl & FLAG.scoped) !== 0) * 20) / 20, e = bins.get(b) ?? [0, 0]
      e[1]++; if (hit) e[0]++; bins.set(b, e)
      const ba = Math.floor(v / 250 * 20) / 20, ea = binsA.get(ba) ?? [0, 0]
      ea[1]++; if (hit) ea[0]++; binsA.set(ba, ea)
    }
  }
}
const show = (m: Map<number, [number, number]>) => [...m].sort((a, b) => a[0] - b[0]).filter(([b]) => b <= 1.1).map(([b, [h, a]]) => `${b.toFixed(2)}:${(100 * h / a).toFixed(0)}%/${a}`).join(' ')
console.log('Frames mit Schritt in ±3 Frames je Anteil Waffen-Max:', show(bins))
console.log('… je Anteil von 250 u/s:', show(binsA))

// Takt: Abstand (s und u Weg) zwischen zwei Schritten je Tempo-Klasse; erster Schritt nach dem Losgehen (Anteil >= 0.55)
const byV = new Map<number, { s: number[]; u: number[] }>(), first: { s: number[]; u: number[] } = { s: [], u: [] }
const list = new Map<number, number[]>()
for (let i = 0; i < d.snd.tick.length; i++) if (steps.has(H.sounds![d.snd.ev[i]])) (list.get(d.snd.player[i]) ?? list.set(d.snd.player[i], []).get(d.snd.player[i])!).push(d.snd.tick[i])
const path = (p: number, a: number, b: number) => { // Weg (u) von Tick a bis b über 16-Hz-Frames
  let u = 0
  for (let t = a; t < b; t += step) { const x = at(p, t), y = at(p, Math.min(b, t + step)); if (x && y && x.r === y.r) u += Math.hypot(d.x[y.j] - d.x[x.j], d.y[y.j] - d.y[x.j]) }
  return u
}
for (const [p, ts] of list) for (let i = 1; i < ts.length; i++) {
  const dt = (ts[i] - ts[i - 1]) / rate
  if (dt > 0.8) continue
  const a = at(p, ts[i]); if (!a) continue
  const v = Math.round(a.v / 25) * 25, e = byV.get(v) ?? { s: [], u: [] }
  e.s.push(dt); e.u.push(path(p, ts[i - 1], ts[i])); byV.set(v, e)
}
console.log('Takt je Tempo (u/s): ' + [...byV].sort((a, b) => a[0] - b[0]).filter(([, e]) => e.s.length > 50).map(([v, e]) => `${v}: ${q(e.s, 0.5).toFixed(3)} s / ${q(e.u, 0.5).toFixed(0)} u (n ${e.s.length})`).join(', '))
// Losgehen: Frame mit Anteil < 0.3 → danach erster Schritt: Zeit und Weg seit dem Überschreiten von 0.55
for (let r = 0; r < H.rounds.length; r++) {
  const R = H.rounds[r]
  R.tracks.forEach((p, k) => {
    const fb = d.frameBase[r] + k * R.nFrames, ts = list.get(p) ?? []
    let still = true
    for (let i = 1; i < R.nFrames; i++) {
      const j = fb + i, v = Math.hypot(d.x[j] - d.x[j - 1], d.y[j] - d.y[j - 1]) * rate / step, fr = v / maxSpeed(d.weapon[j], (d.flags[j] & FLAG.scoped) !== 0)
      if (fr < 0.3 || !(d.flags[j] & FLAG.alive)) { still = true; continue }
      if (!still || fr < 0.55) continue
      still = false
      const t0 = R.firstTick + i * step, nx = ts.find(t => t >= t0 - step && t < t0 + rate)
      if (nx !== undefined) { first.s.push((nx - t0) / rate); first.u.push(nx > t0 ? path(p, t0, nx) : 0) }
    }
  })
}
console.log(`erster Schritt nach Losgehen (Anteil >= 0.55): n ${first.s.length}, Zeit p10 ${q(first.s, 0.1).toFixed(3)} Median ${q(first.s, 0.5).toFixed(3)} p90 ${q(first.s, 0.9).toFixed(3)} s, Weg Median ${q(first.u, 0.5).toFixed(0)} u`)
const hist = new Array(12).fill(0)
for (const s of first.s) hist[Math.min(11, Math.floor(s / 0.05))]++
console.log('  Verteilung erster Schritt (je 0.05 s):', hist.join(' '))
// Takt je Anteil Waffen-Max (stehend/geduckt getrennt)
const byF = new Map<string, number[]>()
for (const [p, ts] of list) for (let i = 1; i < ts.length; i++) {
  const dt = (ts[i] - ts[i - 1]) / rate, a = at(p, ts[i])
  if (dt > 0.8 || !a) continue
  const fr = a.v / maxSpeed(d.weapon[a.j], (d.flags[a.j] & FLAG.scoped) !== 0), key = `${d.duck[a.j] >= 0.5 ? 'D' : ''}${(Math.floor(fr * 10) / 10).toFixed(1)}`
  ;(byF.get(key) ?? byF.set(key, []).get(key)!).push(Math.round(dt * rate))
}
console.log('Takt (Ticks) je Anteil: ' + [...byF].sort().filter(([, v]) => v.length > 30).map(([k, v]) => `${k}: p10 ${q(v, 0.1)} med ${q(v, 0.5)} p90 ${q(v, 0.9)} (n ${v.length})`).join(', '))
// Schübe über der Schwelle: Dauer (Frames) → Anteil mit Schritt
const burst = new Map<number, [number, number]>()
for (let r = 0; r < H.rounds.length; r++) {
  const R = H.rounds[r]
  R.tracks.forEach((p, k) => {
    const fb = d.frameBase[r] + k * R.nFrames, ts = list.get(p) ?? []
    let s = -1
    for (let i = 1; i <= R.nFrames; i++) {
      const j = fb + i
      const on = i < R.nFrames && d.flags[j] & FLAG.alive && !(d.flags[j] & FLAG.airborne) &&
        Math.hypot(d.x[j] - d.x[j - 1], d.y[j] - d.y[j - 1]) * rate / step >= 0.55 * maxSpeed(d.weapon[j], (d.flags[j] & FLAG.scoped) !== 0)
      if (on && s < 0) s = i
      if (!on && s >= 0) {
        const n = Math.min(12, i - s), t0 = R.firstTick + (s - 1) * step, t1 = R.firstTick + i * step
        const e = burst.get(n) ?? [0, 0]; e[1]++; if (ts.some(t => t >= t0 && t <= t1)) e[0]++; burst.set(n, e)
        s = -1
      }
    }
  })
}
console.log('Schübe >= 0.55 (Frames à 1/16 s → mit Schritt): ' + [...burst].sort((a, b) => a[0] - b[0]).map(([n, [h, a]]) => `${n}: ${(100 * h / a).toFixed(0)}% /${a}`).join(', '))

// Regel ohne Server-Sounds (sfx.ts stepCues) gegen die echten Schritte: Treffer = echter Schritt desselben Spielers ±W Ticks
// Vergleich: alte Regel (alle 70 u ab 135 u/s, erster Schritt sofort, nicht Shift/geduckt)
const W = 8, short = { n: 0, sim: 0, real: 0 }, long = { n: 0, sim: 0, real: 0 }
const old =(r: number, k: number): number[] => {
  const R = H.rounds[r], fb = d.frameBase[r] + k * R.nFrames, dt = step / rate, o: number[] = []
  let acc = 70
  for (let i = 1; i < R.nFrames; i++) {
    const j = fb + i, f = d.flags[j], h = Math.hypot(d.x[j] - d.x[j - 1], d.y[j] - d.y[j - 1])
    if (!(f & FLAG.alive) || f & (FLAG.walking | FLAG.airborne) || d.duck[j] >= 0.5 || h <= 135 * dt || h > 100 || Math.abs(d.z[j] - d.z[j - 1]) >= 120 * dt) { acc = 70; continue }
    acc += h; if (acc < 70) continue; acc -= 70; o.push(R.firstTick + i * step)
  }
  return o
}
const variants: [string, (r: number, k: number) => number[]][] = [['alt', old]]
// Varianten: HOLDS=0,0.2,0.35 FIRSTS=0.2,0.27 (ohne: die Werte aus sfx.ts STEP_RULE)
for (const HOLD of (process.env.HOLDS ?? String(STEP_RULE.HOLD)).split(',').map(Number)) for (const FIRST of (process.env.FIRSTS ?? String(STEP_RULE.FIRST)).split(',').map(Number))
  variants.push([`neu HOLD ${HOLD} FIRST ${FIRST}`, (r, k) => { Object.assign(STEP_RULE, { HOLD, FIRST }); return stepCues(d, r, k).map(x => x[0]) }])
for (const [name, rule] of variants) {
  let sim = 0, hit = 0, real = 0, found = 0, mini = 0, miniReal = 0
  for (let r = 0; r < H.rounds.length; r++) {
    const R = H.rounds[r], t0 = R.firstTick, t1 = R.firstTick + (R.nFrames - 1) * step
    R.tracks.forEach((p, k) => {
      const ts = (list.get(p) ?? []).filter(t => t >= t0 && t <= t1), ss = rule(r, k)
      sim += ss.length; real += ts.length
      hit += ss.filter(s => ts.some(t => Math.abs(t - s) <= W)).length
      found += ts.filter(t => ss.some(s => Math.abs(t - s) <= W)).length
      // Schübe über 0.55 (am Boden): kurze (≤ 3 Frames = Mini-Schritte/Gegenlenken) und lange (≥ 6) → Anteil mit Schritt, simuliert/echt
      const fb = d.frameBase[r] + k * R.nFrames
      let s0 = -1
      for (let i = 1; i <= R.nFrames; i++) {
        const j = fb + i, on = i < R.nFrames && d.flags[j] & FLAG.alive && !(d.flags[j] & FLAG.airborne) &&
          Math.hypot(d.x[j] - d.x[j - 1], d.y[j] - d.y[j - 1]) * rate / step >= 0.55 * maxSpeed(d.weapon[j], (d.flags[j] & FLAG.scoped) !== 0)
        if (on && s0 < 0) s0 = i
        if (on || s0 < 0) continue
        const L = i - s0, a = t0 + (s0 - 1) * step, b = t0 + i * step, g = L <= 3 ? short : L >= 6 ? long : null
        s0 = -1
        if (!g) continue
        g.n++; if (ss.some(s => s >= a && s <= b)) g.sim++; if (ts.some(t => t >= a && t <= b)) g.real++
      }
    })
  }
  const pc = (g: typeof short, k: 'sim' | 'real') => `${(100 * g[k] / g.n).toFixed(0)} %`
  console.log(`${name}: Schritte ${sim} (echt ${real}), Präzision ${(100 * hit / sim).toFixed(1)} %, Trefferquote ${(100 * found / real).toFixed(1)} % (±${W} Ticks); ` +
    `Mini-Schübe ≤ 3 Frames ${short.n}: mit Schritt simuliert ${pc(short, 'sim')}, echt ${pc(short, 'real')}; lange ≥ 6 Frames ${long.n}: simuliert ${pc(long, 'sim')}, echt ${pc(long, 'real')}`)
  short.n = short.sim = short.real = long.n = long.sim = long.real = 0
}
