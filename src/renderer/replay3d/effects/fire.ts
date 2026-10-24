// Molotov/Brandgranate: Bodenzellen ab inferno_startburn per raycast fluten (Wände, Stufen, Kanten), Feuer breitet sich in ~1 s aus,
// Flammen-Sprites + Glut je Zelle, Qualm darüber, ein Pool-Licht flackert. Ende = endTick (inferno_expire, auch früh durch Smoke).
// Low: gleiche Zellen (Fläche, Ausbreitung), Flammen und Glut nur auf jeder zweiten Zelle (Schachbrett), dafür größer → halbe Sprite-Zahl.
import * as THREE from 'three'
import { NADE, type CS3D } from '../../../shared/cs3d'
import { HU, worldToGltf, type EffectsContext } from '../contracts'
import { getOptions } from '../options'
import { hash, type LightPool, type SpriteBatch } from './gfx'

const FC = 24 // Zelle (u)
const R = 7 // Suchradius in Zellen
const W = 2 * R + 1
const BUDGET = 80 // Zellen ≈ Kreis r 120 u (CS:GO inferno: 16 Flammen, Abstand 42 u; CS2 ähnlich, ungemessen)
const RMAX = 150, SPREAD = 1.1 // u, s
const END_FADE = 0.6 // s
const LOW_FLAME = 1.25, LOW_EMBER = 1.41 // Low: Flammenhöhe/-breite und Glut-Durchmesser der gezeichneten Zellen

/** keep[v] = 1: Zelle wird in Low gezeichnet (Schachbrett) */
interface FireFill { n: number; ground: Float32Array; arr: Float32Array; keep: Uint8Array; center: THREE.Vector3 }

export function createFire(ctx: EffectsContext, glow: SpriteBatch, puff: SpriteBatch, lights: LightPool) {
  const d: CS3D = ctx.data.d, N = d.nade, rate = d.header.tickrate
  const fills = new Map<number, FireFill | null>()
  const queue: number[] = []
  let job: Generator<void, FireFill> | null = null, jobNade = -1
  const vO = new THREE.Vector3(), vD = new THREE.Vector3(), P = new THREE.Vector3()
  const ray = (x: number, y: number, z: number, dx: number, dy: number, dz: number, far: number) =>
    ctx.raycast(worldToGltf(x, y, z, vO), vD.set(dy, dz, dx).normalize(), far * HU) / HU

  function* fill(i: number): Generator<void, FireFill> {
    const ox = N.x[i], oy = N.y[i]
    const hit0 = ray(ox, oy, N.z[i] + 24, 0, 0, -1, 120)
    const g = new Float32Array(W * W).fill(NaN), prio = new Float32Array(W * W).fill(Infinity)
    const done = new Uint8Array(W * W), order: number[] = []
    const c0 = R * W + R
    g[c0] = hit0 === Infinity ? N.z[i] : N.z[i] + 24 - hit0; prio[c0] = 0
    const NB = [1, 0, -1, 0, 0, 1, 0, -1]
    while (order.length < BUDGET) {
      let c = -1
      for (let k = 0; k < W * W; k++) if (!done[k] && prio[k] < Infinity && (c < 0 || prio[k] < prio[c])) c = k
      if (c < 0) break
      done[c] = 1; order.push(c)
      const a = (c % W) - R, b = Math.floor(c / W) - R, gz = g[c]
      for (let k = 0; k < 8; k += 2) {
        const na = a + NB[k], nb = b + NB[k + 1]
        if (Math.abs(na) > R || Math.abs(nb) > R) continue
        const q = (nb + R) * W + na + R
        if (done[q]) continue
        const p = FC * Math.hypot(na, nb) + hash(i * 977 + q) * 30 // unregelmäßiger Rand
        if (p > RMAX || p >= prio[q]) continue
        if (ray(ox + a * FC, oy + b * FC, gz + 18, NB[k], NB[k + 1], 0, FC) < FC) continue // Wand
        const down = ray(ox + na * FC, oy + nb * FC, gz + 30, 0, 0, -1, 80)
        if (down === Infinity) continue // Kante > 50 u
        g[q] = gz + 30 - down; prio[q] = p
      }
      yield
    }
    const n = order.length, ground = new Float32Array(n * 3), arr = new Float32Array(n), keep = new Uint8Array(n)
    const maxP = Math.max(FC, ...order.map(c => prio[c]))
    let sx = 0, sy = 0, sz = 0
    order.forEach((c, v) => {
      const x = ox + ((c % W) - R) * FC, y = oy + (Math.floor(c / W) - R) * FC
      ground.set([x, y, g[c]], v * 3); arr[v] = SPREAD * (prio[c] / maxP) ** 1.3
      keep[v] = ((c % W) + Math.floor(c / W)) & 1 ? 0 : 1
      sx += x; sy += y; sz += g[c]
    })
    return { n, ground, arr, keep, center: new THREE.Vector3(sx / n, sy / n, sz / n) }
  }

  /** Flutung vormerken (schon während des Flugs: Startpunkt steht in den Daten) */
  function prepare(i: number) { if (!fills.has(i) && N.endTick[i] > N.detTick[i]) { fills.set(i, null); queue.push(i) } }

  return {
    prepare,
    pending: () => job !== null || queue.length > 0,
    work(budgetMs: number) {
      const t0 = performance.now()
      while (performance.now() - t0 < budgetMs) {
        if (!job) { const i = queue.shift(); if (i === undefined) return; job = fill(i); jobNade = i }
        const r = job.next()
        if (r.done) { fills.set(jobNade, r.value); job = null }
      }
    },
    /** Feuer von Granate i bei tick (nur zwischen detTick und endTick aufrufen) */
    draw(i: number, tick: number, clock: number) {
      const age = (tick - N.detTick[i]) / rate, rem = (N.endTick[i] - tick) / rate
      if (age < 0.25) { // Flasche zerplatzt
        const k = 1 - age / 0.25
        glow.add(worldToGltf(N.x[i], N.y[i], N.z[i] + 12, P), 1.3 * (0.5 + age * 3), 3, 1.8, 1, k, 4, i, hash(i), 0)
        lights.want(P, 1, 0.55, 0.25, 30 * k, 8)
      }
      if (N.endTick[i] <= N.detTick[i]) return // in Smoke gelandet / verpufft
      prepare(i)
      const f = fills.get(i)
      if (!f) return
      const inc = N.type[i] === NADE.incgrenade
      const fr = inc ? 1.8 : 1.7, fg = inc ? 1.35 : 1.1, fb = inc ? 0.95 : 0.7
      const kEnd = Math.min(1, rem / END_FADE), low = getOptions().lowQuality // live umschaltbar
      let cover = 0
      for (let v = 0; v < f.n; v++) {
        if (f.arr[v] > age) continue
        const kv = Math.min(1, (age - f.arr[v]) / 0.35) * kEnd
        cover += kv
        if (low && !f.keep[v]) continue
        const fs = low ? LOW_FLAME : 1
        const x = f.ground[v * 3], y = f.ground[v * 3 + 1], z = f.ground[v * 3 + 2]
        for (let j = 0; j < 2; j++) {
          const s = hash(i * 1013 + v * 7 + j), s2 = hash(i * 1013 + v * 7 + j + 3)
          if (j && s2 < 0.75) continue // im Mittel 1.25 Flammen je Zelle
          // Flammen leben ~0.7–1.2 s und wachsen neu nach (Phase je Flamme), dadurch ständig wechselnde Zungen; innen höher
          const life = 0.7 + 0.5 * s, ph = ((clock + s * 7) / life) % 1
          const h = (28 + 46 * s2) * (1.2 - 0.45 * f.arr[v] / SPREAD) * kv * Math.sin(Math.PI * Math.min(1, ph * 1.4)) ** 0.6
          glow.add(worldToGltf(x + (s - 0.5) * FC, y + (s2 - 0.5) * FC, z - 1, P), h * fs * HU, fr, fg, fb, 0.6, 2, 0, s + Math.floor((clock + s * 7) / life) * 0.37, 2)
        }
        glow.add(worldToGltf(x, y, z + 1.5, P), FC * 1.9 * (low ? LOW_EMBER : 1) * HU, 0.7, 0.16, 0.03, kv, 3, hash(i + v) * 6.3, hash(v * 31 + i), 1)
      }
      if (cover <= 0) return
      const c = f.center, size = Math.sqrt(cover / BUDGET)
      // Qualm: aufsteigende dunkle Wolken über dem Feuer
      for (let j = 0; j < 6; j++) {
        const ph = (age * 0.3 + j / 6) % 1, s = hash(i * 31 + j)
        worldToGltf(c.x + (s - 0.5) * 60 * size, c.y + (hash(i * 37 + j) - 0.5) * 60 * size, c.z + 30 + ph * 170, P)
        puff.add(P, (50 + 90 * ph) * HU * (0.6 + 0.6 * size), 0.04, 0.036, 0.032, (1 - ph) * Math.min(1, ph * 4) * kEnd, 0, s * 6, s, 0)
      }
      const flick = 0.75 + 0.25 * Math.sin(clock * 23 + i) * Math.sin(clock * 9.7 + i * 3)
      lights.want(worldToGltf(c.x, c.y, c.z + 40, P), 1, 0.5, 0.2, 9 * size * flick * kEnd, 10)
    },
    /** Brandfleck ab dem Zünden bis Rundenende (molotov_groundfire_scortch: Radius 30 u je Flamme): dunkle flache Wolke je zweiter Zelle */
    scorch(i: number, tick: number) {
      prepare(i) // Sprung hinter das Feuerende: Flutung nachholen
      const f = fills.get(i)
      if (!f) return
      const age = (tick - N.detTick[i]) / rate
      for (let v = 0; v < f.n; v++) {
        if (!f.keep[v] || f.arr[v] > age) continue
        const s = hash(i * 389 + v)
        puff.add(worldToGltf(f.ground[v * 3], f.ground[v * 3 + 1], f.ground[v * 3 + 2] + 0.8, P), 60 * HU, 0.02, 0.018, 0.016, 0.75 * Math.min(1, (age - f.arr[v]) / 1.5), 0, s * 6.3, s, 1)
      }
    },
    dispose() { fills.clear(); queue.length = 0; job = null },
  }
}
