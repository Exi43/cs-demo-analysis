// Ragdoll-Simulation (ragdoll.ts): deterministisch, ohne NaN, liegt nach dem Fallen still über dem Boden, tunnelt nicht durch eine Wand.
import { describe, expect, it } from 'vitest'
import { NP, PARTICLES, RP, simulate, type RagdollWorld } from './ragdoll'

// stehender Spieler (three: x links, y oben, z vorn; m), Reihenfolge wie PARTICLES
const POSE = [
  [0, 1, 0], [0.09, 0.91, 0.01], [-0.09, 0.91, 0.01], [0.1, 0.5, 0.03], [-0.1, 0.5, 0.03], [0.1, 0.09, -0.01], [-0.1, 0.09, -0.01],
  [0.1, 0.03, 0.14], [-0.1, 0.03, 0.14], [0, 1.25, -0.01], [0, 1.62, 0], [0, 1.69, 0.01], [0.18, 1.48, -0.02], [-0.18, 1.48, -0.02],
  [0.36, 1.26, -0.04], [-0.36, 1.26, -0.04], [0.48, 1.03, 0.02], [-0.48, 1.03, 0.02], [0.52, 0.95, 0.04], [-0.52, 0.95, 0.04],
]
const x = Float32Array.from(POSE.flat())
const arm = (s: number) => { const l = Math.hypot(0.18, 0.22); return [-0.22 / l, -0.18 * s / l, 0] } // Bone-Z Oberarm: Beugen nach vorn
const hinge = Float32Array.from([1, 0, 0, 1, 0, 0, ...arm(1), ...arm(-1)])
const quad = (y0: number, z0: number, a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d].map((v, i) => v + (i % 3 === 1 ? y0 : i % 3 === 2 ? z0 : 0))
const FLOOR = quad(0, 0, [-10, 0, -10], [10, 0, -10], [10, 0, 10], [-10, 0, 10])
const WALL = quad(0, -0.45, [-10, 0, 0], [10, 0, 0], [10, 3, 0], [-10, 3, 0]) // dünne Wand 0,45 m hinter dem Spieler

/** Simulation bis zur Ruhe; chunk > 0: in Häppchen wie beim Abspielen (run je Bild) */
function run(push: number, tris: number[], chunk = 0) {
  const v = new Float32Array(NP * 3)
  v[RP.chest * 3 + 2] = -push; v[RP.head * 3 + 2] = -push // Treffer von vorn: nach hinten
  const world: RagdollWorld = { tris: Float32Array.from(tris) }, s = simulate({ x, v, rest: x, hinge }, world)
  for (let f = chunk; chunk && !s.done; f += chunk) s.run(f)
  s.run(Infinity)
  return s.frames
}
const frame = (f: Float32Array, i: number) => f.subarray(i * NP * 3, (i + 1) * NP * 3)

describe('ragdoll', () => {
  it('is deterministic, finite and independent of how it is stepped', () => {
    const a = run(3, FLOOR), b = run(3, FLOOR), c = run(3, FLOOR, 3)
    expect(a.length).toBe(b.length)
    expect(a).toEqual(b)
    expect(c).toEqual(a)
    expect(a.every(Number.isFinite)).toBe(true)
  })
  it('falls over and rests on the floor', () => {
    const f = run(3, FLOOR), n = f.length / (NP * 3), last = frame(f, n - 1)
    expect(n).toBeLessThan(6 * 64) // schläft vor dem Zeitlimit
    for (let i = 0; i < NP; i++) expect(last[i * 3 + 1]).toBeGreaterThan(PARTICLES[i][2] - 0.01) // über dem Boden
    expect(last[RP.head * 3 + 1]).toBeLessThan(0.4) // liegt
    // Knochen bleiben fast so lang (Oberschenkel, Unterarm)
    const len = (p: Float32Array, a: number, b: number) => Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2])
    expect(len(last, RP.hipL, RP.kneeL) / len(x, RP.hipL, RP.kneeL)).toBeCloseTo(1, 1)
    expect(len(last, RP.elbR, RP.wrR) / len(x, RP.elbR, RP.wrR)).toBeCloseTo(1, 1)
  })
  it('does not pass through a thin wall', () => {
    const f = run(12, [...FLOOR, ...WALL]), n = f.length / (NP * 3)
    for (let k = 0; k < n; k++) for (let i = 0; i < NP; i++) expect(f[k * NP * 3 + i * 3 + 2]).toBeGreaterThan(-0.45)
  })
})
