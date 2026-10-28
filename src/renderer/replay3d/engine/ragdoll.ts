// Ragdoll beim Tod wie CS2: worldmodel.vnmgraph hat keinen Todes-Clip, CS2 schaltet auf die Physik-Körper des Modells (PHYS-Block der
// Agenten, VRF -b PHYS, für alle Agenten gleich): 15 Körper (Becken, Brust = spine_2, Kopf, Ober-/Unterarme, Hände, Ober-/Unterschenkel,
// Füße). Daraus: Massen, Radien (Kapseln/Kugeln), Knie-Scharnier (links 0–110°, rechts 0–90° ab Bind-Pose), Ellbogen (12–74° bzw.
// 10–92°) und Hüfte (Beugen 70°, Strecken 35°, seitlich 15°), gelesen als Drehung um die Z-Achse der Gelenkrahmen wie beim Knie-Scharnier.
// Schulter, Wirbelsäule, Hals: menschliche Standardgrenzen (Valve-Rahmen dort nicht sicher deutbar).
// Partikel-Ragdoll (Verlet + Positions-Constraints), ab dem Tod mit festem Schritt vorab simuliert, ein Bild je Tick bis zur Ruhe.
// Rein (keine three-Objekte, kein Zufall): gleiche Eingabe → gleiche Bilder; der Renderer tastet nach Zeit ab (Spulen vor/zurück gleich).
// Welt = three/glTF (m, y oben) wie raycast.ts; Kollision Kugel gegen Map-Dreiecke um den Todesort.

/** Partikel: Bone, Versatz im Bone-Raum (m, null = Ursprung), Radius (m), Masse (kg; PHYS-Körpermassen auf die Gelenke verteilt) */
export const PARTICLES: readonly (readonly [string, readonly [number, number, number] | null, number, number])[] = [
  ['pelvis', null, 0.15, 25], ['leg_upper_L', null, 0.1, 22.5], ['leg_upper_R', null, 0.1, 22.5],
  ['leg_lower_L', null, 0.09, 30], ['leg_lower_R', null, 0.09, 30], ['ankle_L', null, 0.055, 14], ['ankle_R', null, 0.055, 14],
  ['ball_L', null, 0.045, 1.5], ['ball_R', null, 0.045, 1.5],
  ['spine_2', null, 0.16, 25], ['head_0', null, 0.08, 8], ['head_0', [0.066, 0.01, 0], 0.127, 12], // Kopf: Kugel r 5 in um (2.6, 0.4, 0) in
  ['arm_upper_L', null, 0.075, 8.5], ['arm_upper_R', null, 0.075, 8.5], ['arm_lower_L', null, 0.065, 7], ['arm_lower_R', null, 0.065, 7],
  ['hand_L', null, 0.05, 5], ['hand_R', null, 0.05, 5], ['hand_L', [0.088, 0.037, 0], 0.07, 1.5], ['hand_R', [-0.09, -0.044, 0], 0.07, 1.5],
]
export const NP = PARTICLES.length
/** Partikel-Indizes; headJ = Kopfgelenk (head_0-Ursprung, Drehpunkt des Kopfes), head = Kopfmitte */
export const RP = {
  pelvis: 0, hipL: 1, hipR: 2, kneeL: 3, kneeR: 4, ankleL: 5, ankleR: 6, ballL: 7, ballR: 8,
  chest: 9, headJ: 10, head: 11, shL: 12, shR: 13, elbL: 14, elbR: 15, wrL: 16, wrR: 17, handL: 18, handR: 19,
} as const
/** Basen [a, b, c, d] für basis(): Becken (Hüften, Becken über der Hüftmitte), Brust (Schultern, Kopfgelenk über spine_2) */
export const BASES = [[RP.hipL, RP.hipR, RP.pelvis, -1], [RP.shL, RP.shR, RP.headJ, RP.chest]] as const

const P = RP
/** feste Abstände (Länge aus der Todespose): Becken mit Lende starr (CS2: spine_0/1 hängen am Becken-Körper), Brustkorb starr, Glieder */
const LINKS = [
  P.pelvis, P.hipL, P.pelvis, P.hipR, P.hipL, P.hipR, P.pelvis, P.chest, P.hipL, P.chest, P.hipR, P.chest,
  P.chest, P.headJ, P.chest, P.shL, P.chest, P.shR, P.headJ, P.shL, P.headJ, P.shR, P.shL, P.shR, P.headJ, P.head,
  P.hipL, P.kneeL, P.kneeL, P.ankleL, P.ankleL, P.ballL, P.kneeL, P.ballL, P.hipR, P.kneeR, P.kneeR, P.ankleR, P.ankleR, P.ballR, P.kneeR, P.ballR,
  P.shL, P.elbL, P.elbL, P.wrL, P.wrL, P.handL, P.elbL, P.handL, P.shR, P.elbR, P.elbR, P.wrR, P.wrR, P.handR, P.elbR, P.handR,
]
/** a, b, lo, hi: Abstand in [lo, hi] × Ruhepose: Wirbelsäule (Beugen ~35°, seitlich/Drehen ~15°), Hals (~35°) */
const RANGES = [
  P.pelvis, P.headJ, 0.96, 1.01, P.hipL, P.shL, 0.94, 1.05, P.hipR, P.shR, 0.94, 1.05, P.hipL, P.shR, 0.95, 1.04, P.hipR, P.shL, 0.95, 1.04,
  P.chest, P.head, 0.95, 1.01, P.shL, P.head, 0.9, 1.08, P.shR, P.head, 0.9, 1.08,
]
const D2R = Math.PI / 180
/** a, b, e, Basis, lo, hi: Eltern-Segment a→b, Kind b→e, Basis 0 Becken / 1 Brust, Achse = Bone-Z des Eltern-Bones (inp.hinge), Beugung lo..hi (rad) */
const HINGES = [
  P.hipL, P.kneeL, P.ankleL, 0, 0.13, 2.05, P.hipR, P.kneeR, P.ankleR, 0, 0.13, 1.7,
  P.shL, P.elbL, P.wrL, 1, 0.21, 1.29, P.shR, P.elbR, P.wrR, 1, 0.18, 1.6,
]
const NH = HINGES.length / 6
/** Hüfte (Oberschenkel in der Becken-Basis, um die Ruhepose): Beugen vor 70°, Strecken 35°, seitlich ±15° */
const HIP_FLEX = 70 * D2R, HIP_EXT = 35 * D2R, HIP_SIDE = 15 * D2R
/** Schulter: Oberarm höchstens so weit von der Ruhe-Richtung (A-Pose) in der Brust-Basis, nicht durch den Rumpf */
const SHOULDER = Math.cos(80 * D2R), SHOULDER_S = Math.sin(80 * D2R)
/** Scharnier: seitliches Spiel (CS2-Swing Knie/Ellbogen ~7°, als Sinus); Gelenkgrenzen je Durchlauf nur zur Hälfte, sonst kämpfen sie gegen den Boden */
const HINGE_SIDE = Math.sin(7 * D2R), K_LIM = 0.5

/** sv_gravity 800 u/s² in m/s²; Schritt = Tick (64 Hz) */
const G = 800 * 0.0254, DT = 1 / 64, ITER = 10, MAX_STEPS = 6 * 64
/** Luftdämpfung je Schritt; Reibung (Haft/Gleit) als PBD-Reibung gegen die Eindringtiefe */
const DAMP = 0.998, MU_S = 0.6, MU_K = 0.45
/** Ruhe: alle Partikel < SLEEP m je Schritt (5 cm/s) für SLEEP_N Schritte */
const SLEEP = 0.0008, SLEEP_N = 32

export interface RagdollInput {
  /** Partikel bei Tod (Welt m), 3·NP */
  x: ArrayLike<number>
  /** Startgeschwindigkeit (m/s), 3·NP */
  v: ArrayLike<number>
  /** Ruhe-/Bindpose des Modells (beliebiger Raum, nur Abstände und Richtungen in den Basen zählen), 3·NP */
  rest: ArrayLike<number>
  /** Bone-Z bei Tod (Welt) von leg_upper_L, leg_upper_R, arm_upper_L, arm_upper_R = Knie-/Ellbogen-Achsen, 3·4 */
  hinge: ArrayLike<number>
}
/** Dreiecke um den Todesort (je 9 Floats, Welt m); floor = Boden (y) unter x,z ab Höhe y, −Infinity = keiner (außerhalb der Dreiecke) */
export interface RagdollWorld { tris: Float32Array; floor?: (x: number, y: number, z: number) => number }

const len3 = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z) // Math.hypot ist in V8 mehrfach langsamer
const dist = (X: ArrayLike<number>, a: number, b: number) => len3(X[a * 3] - X[b * 3], X[a * 3 + 1] - X[b * 3 + 1], X[a * 3 + 2] - X[b * 3 + 2])

/** Basis aus Partikeln, Spalten x, y, z: x = a − b, y = c − (d < 0 ? Mitte a,b : d) senkrecht zu x, z = x × y */
export function basis(X: ArrayLike<number>, a: number, b: number, c: number, d: number, B: Float64Array | number[]) {
  let x0 = X[a * 3] - X[b * 3], x1 = X[a * 3 + 1] - X[b * 3 + 1], x2 = X[a * 3 + 2] - X[b * 3 + 2]
  let l = len3(x0, x1, x2) || 1
  x0 /= l; x1 /= l; x2 /= l
  const m0 = d < 0 ? (X[a * 3] + X[b * 3]) / 2 : X[d * 3], m1 = d < 0 ? (X[a * 3 + 1] + X[b * 3 + 1]) / 2 : X[d * 3 + 1], m2 = d < 0 ? (X[a * 3 + 2] + X[b * 3 + 2]) / 2 : X[d * 3 + 2]
  let y0 = X[c * 3] - m0, y1 = X[c * 3 + 1] - m1, y2 = X[c * 3 + 2] - m2
  const k = y0 * x0 + y1 * x1 + y2 * x2
  y0 -= k * x0; y1 -= k * x1; y2 -= k * x2
  l = len3(y0, y1, y2) || 1
  y0 /= l; y1 /= l; y2 /= l
  B[0] = x0; B[1] = x1; B[2] = x2; B[3] = y0; B[4] = y1; B[5] = y2
  B[6] = x1 * y2 - x2 * y1; B[7] = x2 * y0 - x0 * y2; B[8] = x0 * y1 - x1 * y0
}
/** Richtung a→b im Basis-Raum (Bᵀ · d, normiert) */
function localDir(X: ArrayLike<number>, a: number, b: number, B: ArrayLike<number>, out: number[]) {
  let d0 = X[b * 3] - X[a * 3], d1 = X[b * 3 + 1] - X[a * 3 + 1], d2 = X[b * 3 + 2] - X[a * 3 + 2]
  const l = len3(d0, d1, d2) || 1
  d0 /= l; d1 /= l; d2 /= l
  out[0] = B[0] * d0 + B[1] * d1 + B[2] * d2; out[1] = B[3] * d0 + B[4] * d1 + B[5] * d2; out[2] = B[6] * d0 + B[7] * d1 + B[8] * d2
}

/** Abstand a–b in [lo, hi] (inverse Massen w) */
function link(X: Float64Array, w: Float64Array, a: number, b: number, lo: number, hi: number) {
  const A = a * 3, B = b * 3, dx = X[B] - X[A], dy = X[B + 1] - X[A + 1], dz = X[B + 2] - X[A + 2], d = len3(dx, dy, dz)
  if (d < 1e-9 || (d >= lo && d <= hi)) return
  const k = (d - (d < lo ? lo : hi)) / d / (w[a] + w[b]), ka = k * w[a], kb = k * w[b]
  X[A] += dx * ka; X[A + 1] += dy * ka; X[A + 2] += dz * ka
  X[B] -= dx * kb; X[B + 1] -= dy * kb; X[B + 2] -= dz * kb
}
/**
 * Grenze: b soll bei a + Länge l · Basis · (l0, l1, l2) liegen. Korrektur zur Hälfte (K_LIM), auf a und b nach inversen Massen verteilt
 * (nur b zu schieben wirkt wie eine äußere Kraft: der Körper rutscht davon)
 */
function place(X: Float64Array, w: Float64Array, a: number, b: number, B: ArrayLike<number>, l0: number, l1: number, l2: number, l: number) {
  pull(X, w, a, b, X[a * 3] + (B[0] * l0 + B[3] * l1 + B[6] * l2) * l, X[a * 3 + 1] + (B[1] * l0 + B[4] * l1 + B[7] * l2) * l, X[a * 3 + 2] + (B[2] * l0 + B[5] * l1 + B[8] * l2) * l)
}
/** b Richtung Ziel (t0, t1, t2), a gegengleich (inverse Massen), zusammen K_LIM des Abstands */
function pull(X: Float64Array, w: Float64Array, a: number, b: number, t0: number, t1: number, t2: number) {
  const kb = K_LIM * w[b] / (w[a] + w[b]), ka = K_LIM * w[a] / (w[a] + w[b])
  const d0 = t0 - X[b * 3], d1 = t1 - X[b * 3 + 1], d2 = t2 - X[b * 3 + 2]
  X[b * 3] += d0 * kb; X[b * 3 + 1] += d1 * kb; X[b * 3 + 2] += d2 * kb
  X[a * 3] -= d0 * ka; X[a * 3 + 1] -= d1 * ka; X[a * 3 + 2] -= d2 * ka
}
const wrap = (x: number) => Math.abs(((x + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)
/** Winkel th auf [lo, hi] begrenzen, außerhalb auf die auf dem Kreis nähere Grenze */
const clampAngle = (th: number, lo: number, hi: number) => (th >= lo && th <= hi ? th : wrap(th - lo) <= wrap(th - hi) ? lo : hi)

/**
 * Simulation ab dem Tod mit festem Schritt: Bilder je Tick (1/64 s), je Bild 3·NP Floats (Bild 0 = inp.x), bis Ruhe bzw. MAX_STEPS
 * (danach liegt der Körper still, Abtasten hält das letzte Bild). run(f) rechnet nur bis Bild f weiter: beim Abspielen ~1 Schritt je Bild
 * statt der ganzen Simulation in einem Bild; das Ergebnis hängt nicht davon ab, in welchen Häppchen gerechnet wird.
 */
export interface RagdollSim { frames: Float32Array; n: number; done: boolean; run(f: number): void }
export function simulate(inp: RagdollInput, world: RagdollWorld): RagdollSim {
  const n3 = NP * 3, X = Float64Array.from(inp.x), Q = new Float64Array(n3), w = Float64Array.from(PARTICLES, p => 1 / p[3])
  for (let i = 0; i < n3; i++) Q[i] = X[i] - inp.v[i] * DT
  const L = Float64Array.from(LINKS, (_, i) => (i & 1 ? 0 : dist(X, LINKS[i], LINKS[i + 1])))
  const R = Float64Array.from(RANGES, (v, i) => (i % 4 === 2 ? dist(inp.rest, RANGES[i - 2], RANGES[i - 1]) * v : i % 4 === 3 ? dist(inp.rest, RANGES[i - 3], RANGES[i - 2]) * v : 0))
  // Basen bei Tod (Scharnier-Achsen wandern mit) und in Ruhe (Richtungen von Hüfte/Schulter)
  const B0 = BASES.map(([a, b, c, d]) => { const B = new Float64Array(9); basis(X, a, b, c, d, B); return B })
  const Br = BASES.map(([a, b, c, d]) => { const B = new Float64Array(9); basis(inp.rest, a, b, c, d, B); return B })
  const u0: number[][] = [], z0: number[][] = [], hl = new Float64Array(NH)
  for (let h = 0; h < NH; h++) {
    const a = HINGES[h * 6], b = HINGES[h * 6 + 1], e = HINGES[h * 6 + 2], l = dist(X, a, b)
    u0.push([0, 1, 2].map(c => (X[b * 3 + c] - X[a * 3 + c]) / l)); z0.push([0, 1, 2].map(c => inp.hinge[h * 3 + c])); hl[h] = dist(X, b, e)
  }
  // Hüften (Beugen f, seitlich s in der Becken-Basis) und Schultern (Richtung r in der Brust-Basis) der Ruhepose
  const limb = [[P.hipL, P.kneeL, 0], [P.hipR, P.kneeR, 0], [P.shL, P.elbL, 1], [P.shR, P.elbR, 1]].map(([a, b, bi]) => {
    const r = [0, 0, 0]
    localDir(inp.rest, a, b, Br[bi], r)
    return { a, b, l: dist(X, a, b), r, f: Math.atan2(r[2], -r[1]), s: Math.asin(Math.max(-1, Math.min(1, r[0]))) }
  })
  const col = collider(world.tris, inp.x), rad = PARTICLES.map(p => p[2]) // inp.x[0..2] = Becken bei Tod
  const Bt = [new Float64Array(9), new Float64Array(9)], v = [0, 0, 0], z = [0, 0, 0], d = [0, 0, 0], u = [0, 0, 0]
  const sim: RagdollSim = { frames: new Float32Array(n3 * (MAX_STEPS + 1)), n: 1, done: false, run }
  sim.frames.set(X)
  let still = 0
  function run(fmax: number) {
    while (!sim.done && sim.n <= fmax) {
      step()
      const out = sim.frames, f = sim.n++
      out.set(X, f * n3)
      let mv = 0
      for (let i = 0; i < n3; i++) mv = Math.max(mv, Math.abs(X[i] - out[(f - 1) * n3 + i]))
      still = mv < SLEEP ? still + 1 : 0
      if (still >= SLEEP_N || sim.n > MAX_STEPS) { sim.done = true; sim.frames = out.slice(0, sim.n * n3) }
    }
  }
  return sim
  function step() {
    for (let i = 0; i < n3; i++) { const x = X[i], vi = (x - Q[i]) * DAMP; Q[i] = x; X[i] = x + vi - (i % 3 === 1 ? G * DT * DT : 0) }
    for (let it = 0; it < ITER; it++) {
      for (let i = 0; i < LINKS.length; i += 2) link(X, w, LINKS[i], LINKS[i + 1], L[i], L[i])
      for (let i = 0; i < RANGES.length; i += 4) link(X, w, RANGES[i], RANGES[i + 1], R[i + 2], R[i + 3])
      for (let i = 0; i < 2; i++) basis(X, BASES[i][0], BASES[i][1], BASES[i][2], BASES[i][3], Bt[i])
      // Scharniere: Achse = Bone-Z bei Tod, mit dem Elternkörper mitgedreht (Basis seit Tod, dann kürzester Schwung auf das Eltern-Segment)
      for (let h = 0; h < NH; h++) {
        const a = HINGES[h * 6], b = HINGES[h * 6 + 1], e = HINGES[h * 6 + 2], bi = HINGES[h * 6 + 3], ul = dist(X, a, b)
        if (ul < 1e-9) continue
        for (let c = 0; c < 3; c++) u[c] = (X[b * 3 + c] - X[a * 3 + c]) / ul
        rot(Bt[bi], B0[bi], u0[h], v); rot(Bt[bi], B0[bi], z0[h], z)
        swing(v, u, z)
        const k = z[0] * u[0] + z[1] * u[1] + z[2] * u[2]
        let a0 = z[0] - k * u[0], a1 = z[1] - k * u[1], a2 = z[2] - k * u[2]
        const al = len3(a0, a1, a2)
        if (al < 1e-6) continue
        a0 /= al; a1 /= al; a2 /= al
        const s0 = a1 * u[2] - a2 * u[1], s1 = a2 * u[0] - a0 * u[2], s2 = a0 * u[1] - a1 * u[0] // Achse × u = Beuge-Richtung
        const c0 = X[e * 3] - X[b * 3], c1 = X[e * 3 + 1] - X[b * 3 + 1], c2 = X[e * 3 + 2] - X[b * 3 + 2], cl = len3(c0, c1, c2) || 1
        const th = Math.atan2(c0 * s0 + c1 * s1 + c2 * s2, c0 * u[0] + c1 * u[1] + c2 * u[2]), tc = clampAngle(th, HINGES[h * 6 + 4], HINGES[h * 6 + 5])
        const side = (c0 * a0 + c1 * a1 + c2 * a2) / cl, sc = Math.max(-HINGE_SIDE, Math.min(HINGE_SIDE, side))
        if (tc === th && sc === side) continue
        const q = Math.sqrt(1 - sc * sc) * hl[h], cs = Math.cos(tc) * q, sn = Math.sin(tc) * q, ax = sc * hl[h]
        pull(X, w, b, e, X[b * 3] + u[0] * cs + s0 * sn + a0 * ax, X[b * 3 + 1] + u[1] * cs + s1 * sn + a1 * ax, X[b * 3 + 2] + u[2] * cs + s2 * sn + a2 * ax)
      }
      for (let k = 0; k < 4; k++) {
        const H = limb[k], B = Bt[k >> 1]
        localDir(X, H.a, H.b, B, d)
        if (k < 2) { // Hüfte: Beugen/Strecken und seitlich getrennt begrenzen
          const fl = Math.atan2(d[2], -d[1]), sd = Math.asin(Math.max(-1, Math.min(1, d[0])))
          const fc = Math.max(H.f - HIP_EXT, Math.min(H.f + HIP_FLEX, fl)), sc = Math.max(H.s - HIP_SIDE, Math.min(H.s + HIP_SIDE, sd))
          if (fc !== fl || sc !== sd) place(X, w, H.a, H.b, B, Math.sin(sc), -Math.cos(sc) * Math.cos(fc), Math.cos(sc) * Math.sin(fc), H.l)
          continue
        }
        const r = H.r, c = d[0] * r[0] + d[1] * r[1] + d[2] * r[2] // Schulter: Kegel um die Ruhe-Richtung
        if (c >= SHOULDER) continue
        let p0 = d[0] - c * r[0], p1 = d[1] - c * r[1], p2 = d[2] - c * r[2]
        const pl = len3(p0, p1, p2) || 1
        p0 /= pl; p1 /= pl; p2 /= pl
        place(X, w, H.a, H.b, B, r[0] * SHOULDER + p0 * SHOULDER_S, r[1] * SHOULDER + p1 * SHOULDER_S, r[2] * SHOULDER + p2 * SHOULDER_S, H.l)
      }
    }
    for (let i = 0; i < NP; i++) {
      const r = rad[i]
      if (!col?.hit(X, Q, i, r) && world.floor) {
        // außerhalb der Dreiecke (oder ohne): Boden-Raster als Netz
        const fy = world.floor(X[i * 3], X[i * 3 + 1], X[i * 3 + 2])
        if (X[i * 3 + 1] < fy + r) { const dep = fy + r - X[i * 3 + 1]; X[i * 3 + 1] = fy + r; friction(X, Q, i, 0, 1, 0, dep) }
      }
    }
  }
}

/** out = B · B0ᵀ · v (Drehung der Basis seit Tod) */
function rot(B: ArrayLike<number>, B0: ArrayLike<number>, v: ArrayLike<number>, out: number[]) {
  const t0 = B0[0] * v[0] + B0[1] * v[1] + B0[2] * v[2], t1 = B0[3] * v[0] + B0[4] * v[1] + B0[5] * v[2], t2 = B0[6] * v[0] + B0[7] * v[1] + B0[8] * v[2]
  out[0] = B[0] * t0 + B[3] * t1 + B[6] * t2; out[1] = B[1] * t0 + B[4] * t1 + B[7] * t2; out[2] = B[2] * t0 + B[5] * t1 + B[8] * t2
}
/** w um den kürzesten Schwung v → u drehen (v, u normiert; Rodrigues mit k = v × u, c = v·u) */
function swing(v: number[], u: number[], w: number[]) {
  const c = v[0] * u[0] + v[1] * u[1] + v[2] * u[2]
  if (c < -0.999) return
  const k0 = v[1] * u[2] - v[2] * u[1], k1 = v[2] * u[0] - v[0] * u[2], k2 = v[0] * u[1] - v[1] * u[0]
  const kw = (k0 * w[0] + k1 * w[1] + k2 * w[2]) / (1 + c)
  const x0 = w[0] * c + (k1 * w[2] - k2 * w[1]) + k0 * kw, x1 = w[1] * c + (k2 * w[0] - k0 * w[2]) + k1 * kw, x2 = w[2] * c + (k0 * w[1] - k1 * w[0]) + k2 * kw
  w[0] = x0; w[1] = x1; w[2] = x2
}
/** PBD-Reibung: Gleiten dieses Schritts tangential zur Normale n bremsen (Haften unter MU_S · Tiefe) */
function friction(X: Float64Array, Q: Float64Array, i: number, n0: number, n1: number, n2: number, depth: number) {
  const I = i * 3, d0 = X[I] - Q[I], d1 = X[I + 1] - Q[I + 1], d2 = X[I + 2] - Q[I + 2], dn = d0 * n0 + d1 * n1 + d2 * n2
  const t0 = d0 - dn * n0, t1 = d1 - dn * n1, t2 = d2 - dn * n2, tl = len3(t0, t1, t2)
  const k = tl < MU_S * depth ? 1 : Math.min(MU_K * depth / tl, 1)
  X[I] -= t0 * k; X[I + 1] -= t1 * k; X[I + 2] -= t2 * k
}

/**
 * Kugel gegen Dreiecks-Suppe: Gitter 0,5 m über die Dreiecks-AABBs (wie raycast.ts gridOf), höchstens ±BOX um c (große Boden-Dreiecke
 * blähen es sonst auf). Herausschieben auf die Seite der Fläche, auf der das Partikel im Schritt davor war (kein Durchtunneln dünner
 * Wände), dann Reibung. null = keine Dreiecke.
 */
const BOX = 3.5
function collider(T: Float32Array, c: ArrayLike<number>) {
  const nt = T.length / 9, C = 0.5
  if (!nt) return null
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < T.length; i += 3) for (let r = 0; r < 3; r++) { mn[r] = Math.min(mn[r], T[i + r]); mx[r] = Math.max(mx[r], T[i + r]) }
  for (let r = 0; r < 3; r++) { mn[r] = Math.max(mn[r], c[r] - BOX); mx[r] = Math.min(mx[r], c[r] + BOX) }
  const N = [0, 1, 2].map(r => Math.max(1, Math.ceil((mx[r] - mn[r]) / C)))
  const cell = (v: number, r: number) => Math.min(N[r] - 1, Math.max(0, Math.floor((v - mn[r]) / C)))
  // Normale und Hüllkugel (Mitte, Radius) je Dreieck: Kugel-Test vor dem teuren nächsten Punkt (Map-Dreiecke liegen dicht)
  const nrm = new Float32Array(nt * 3), sph = new Float32Array(nt * 4), offs = new Uint32Array(N[0] * N[1] * N[2] + 1)
  let list = new Uint32Array(0), fill = offs
  for (let t = 0; t < nt; t++) {
    const o = t * 9, e0 = T[o + 3] - T[o], e1 = T[o + 4] - T[o + 1], e2 = T[o + 5] - T[o + 2], g0 = T[o + 6] - T[o], g1 = T[o + 7] - T[o + 1], g2 = T[o + 8] - T[o + 2]
    const n0 = e1 * g2 - e2 * g1, n1 = e2 * g0 - e0 * g2, n2 = e0 * g1 - e1 * g0, l = len3(n0, n1, n2) || 1
    nrm[t * 3] = n0 / l; nrm[t * 3 + 1] = n1 / l; nrm[t * 3 + 2] = n2 / l
    const c0 = (T[o] + T[o + 3] + T[o + 6]) / 3, c1 = (T[o + 1] + T[o + 4] + T[o + 7]) / 3, c2 = (T[o + 2] + T[o + 5] + T[o + 8]) / 3
    sph[t * 4] = c0; sph[t * 4 + 1] = c1; sph[t * 4 + 2] = c2
    for (let k = 0; k < 9; k += 3) sph[t * 4 + 3] = Math.max(sph[t * 4 + 3], len3(T[o + k] - c0, T[o + k + 1] - c1, T[o + k + 2] - c2))
  }
  const lo = [0, 0, 0], hi = [0, 0, 0]
  for (let pass = 0; pass < 2; pass++) {
    for (let t = 0; t < nt; t++) {
      const o = t * 9
      for (let r = 0; r < 3; r++) { lo[r] = cell(Math.min(T[o + r], T[o + 3 + r], T[o + 6 + r]), r); hi[r] = cell(Math.max(T[o + r], T[o + 3 + r], T[o + 6 + r]), r) }
      for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
        const k = (z * N[1] + y) * N[0] + x
        if (pass === 0) offs[k + 1]++; else list[fill[k]++] = t
      }
    }
    if (pass === 0) { for (let c = 1; c < offs.length; c++) offs[c] += offs[c - 1]; list = new Uint32Array(offs[offs.length - 1]); fill = offs.slice(0, -1) }
  }
  const stamp = new Uint32Array(nt), q = [0, 0, 0], acc = [0, 0, 0, 0], box = [0, 0, 0, 0, 0, 0]
  let s = 0
  /** einmal über die Dreiecke der Zellen in box schieben; acc = Summe der Kontakt-Normalen, größte Tiefe */
  const resolve = (X: Float64Array, Q: Float64Array, I: number, r: number) => {
    s = (s + 1) >>> 0 || 1
    acc[0] = acc[1] = acc[2] = acc[3] = 0
    // Strecke dieses Schritts als Kugel um die Mitte (Schieben unterwegs: großzügig 2 r)
    const g0 = (X[I] + Q[I]) / 2, g1 = (X[I + 1] + Q[I + 1]) / 2, g2 = (X[I + 2] + Q[I + 2]) / 2, reach = len3(X[I] - Q[I], X[I + 1] - Q[I + 1], X[I + 2] - Q[I + 2]) / 2 + 2 * r
    for (let z = box[4]; z <= box[5]; z++) for (let y = box[2]; y <= box[3]; y++) for (let x = box[0]; x <= box[1]; x++) {
      const c = (z * N[1] + y) * N[0] + x
      for (let j = offs[c]; j < offs[c + 1]; j++) {
        const t = list[j]
        if (stamp[t] === s) continue
        stamp[t] = s
        const h0 = g0 - sph[t * 4], h1 = g1 - sph[t * 4 + 1], h2 = g2 - sph[t * 4 + 2], hr = sph[t * 4 + 3] + reach
        if (h0 * h0 + h1 * h1 + h2 * h2 > hr * hr) continue
        closest(T, t * 9, X[I], X[I + 1], X[I + 2], q)
        const n0 = nrm[t * 3], n1 = nrm[t * 3 + 1], n2 = nrm[t * 3 + 2], o = t * 9
        const now = (X[I] - T[o]) * n0 + (X[I + 1] - T[o + 1]) * n1 + (X[I + 2] - T[o + 2]) * n2
        const prev = (Q[I] - T[o]) * n0 + (Q[I + 1] - T[o + 1]) * n1 + (Q[I + 2] - T[o + 2]) * n2
        const d0 = X[I] - q[0], d1 = X[I + 1] - q[1], d2 = X[I + 2] - q[2], dd = len3(d0, d1, d2)
        let m0: number, m1: number, m2: number, dep: number
        if (prev * now < 0 && Math.abs(dd - Math.abs(now)) < 1e-6) { // durch die Fläche: zurück auf die vorige Seite
          const sg = prev > 0 ? 1 : -1
          m0 = n0 * sg; m1 = n1 * sg; m2 = n2 * sg; dep = r + Math.abs(now)
        } else if (dd < r) {
          if (dd > 1e-9) { m0 = d0 / dd; m1 = d1 / dd; m2 = d2 / dd } else { const sg = prev >= 0 ? 1 : -1; m0 = n0 * sg; m1 = n1 * sg; m2 = n2 * sg }
          dep = r - dd
        } else continue
        X[I] = q[0] + m0 * r; X[I + 1] = q[1] + m1 * r; X[I + 2] = q[2] + m2 * r
        acc[0] += m0; acc[1] += m1; acc[2] += m2; acc[3] = Math.max(acc[3], dep)
      }
    }
  }
  return {
    /** Kontakt von Partikel i (Radius r) mit den Dreiecken auflösen; false = außerhalb des Gitters (dann Boden-Netz) */
    hit(X: Float64Array, Q: Float64Array, i: number, r: number) {
      const I = i * 3
      for (let k = 0; k < 3; k++) {
        const lo = Math.min(X[I + k], Q[I + k]) - r, hi = Math.max(X[I + k], Q[I + k]) + r
        if (hi < mn[k] - C || lo > mx[k] + C) return false
        // Zellen über die ganze Strecke dieses Schritts (vorige → jetzige Lage), sonst entwischt ein schnelles Partikel der Wand-Zelle
        box[k * 2] = cell(lo, k); box[k * 2 + 1] = cell(hi, k)
      }
      resolve(X, Q, I, r)
      const sl = len3(acc[0], acc[1], acc[2])
      if (sl < 1e-9) return true
      friction(X, Q, i, acc[0] / sl, acc[1] / sl, acc[2] / sl, acc[3])
      resolve(X, Q, I, r) // Reibung mit gemittelter Normale kann in einer Ecke in die andere Fläche schieben
      return true
    },
  }
}
/** nächster Punkt des Dreiecks T[o..o+9) zu p → out (Ericson, Real-Time Collision Detection 5.1.5); u, v = Anteile von ab, ac */
function closest(T: Float32Array, o: number, px: number, py: number, pz: number, out: number[]) {
  const ax = T[o], ay = T[o + 1], az = T[o + 2]
  const abx = T[o + 3] - ax, aby = T[o + 4] - ay, abz = T[o + 5] - az, acx = T[o + 6] - ax, acy = T[o + 7] - ay, acz = T[o + 8] - az
  const apx = px - ax, apy = py - ay, apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz
  let u = 0, v = 0
  if (d1 > 0 || d2 > 0) {
    const bpx = px - T[o + 3], bpy = py - T[o + 4], bpz = pz - T[o + 5]
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz
    const cpx = px - T[o + 6], cpy = py - T[o + 7], cpz = pz - T[o + 8]
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4
    if (d3 >= 0 && d4 <= d3) u = 1
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) u = d1 / (d1 - d3)
    else if (d6 >= 0 && d5 <= d6) v = 1
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) v = d2 / (d2 - d6)
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { v = (d4 - d3) / (d4 - d3 + (d5 - d6)); u = 1 - v }
    else { const den = 1 / (va + vb + vc); u = vb * den; v = vc * den }
  }
  out[0] = ax + abx * u + acx * v; out[1] = ay + aby * u + acy * v; out[2] = az + abz * u + acz * v
}
