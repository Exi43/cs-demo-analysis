// CS2-Smoke: Voxel-Flutung ab dem Detonationspunkt (Wände/Decken per raycast), gerendert als Kugel-Impostoren je Voxel
// (instanziert, ein Draw-Call pro Smoke). Aufbau ~1.1 s von innen nach außen, Ausblenden in den letzten 3 s vor
// smokegrenade_expired (Rand zuerst), HE reißt ein Kugelloch (füllt sich in 5 s), Schüsse stanzen dünne Tunnel. Kamera im Rauch → Vollbild-Grau.
// Die echte Voxel-Form steht in der Demo (m_VoxelFrameData), demoparser2 liefert davon aber nur ein Byte → Flutung + Loch/Tunnel nachgebaut.
// Low (options.ts lowQuality, live umschaltbar wie fire.ts): dieselbe Flutung (gleiche Hülle, Kamera-Dichte, HE-Loch), ohne Schuss-Tunnel,
// gezeichnet wird nur jedes zweite Voxel (Schachbrett) mit gleichem Radius, höherer Dichte und einem Rauschzugriff → etwa halbe Füllrate.
// Beide Voxel-Sätze liegen je Smoke bereit; Umschalten lädt nur die Instanz-Attribute neu, kein neues Programm (Uniform uLow).
import * as THREE from 'three'
import { NADE } from '../../../shared/cs3d'
import { floorLayer, parseFloorGrid, type FloorGrid } from '../../../shared/assets3d'
import { HU, worldToGltf, type EffectsContext } from '../contracts'
import { getOptions } from '../options'
import { hash, type Shared } from './gfx'

const C = 20 // Voxel (u)
const BUDGET = 760 // Voxel ≈ 6 Mio. u³: auf freier Fläche Kuppel r ≈ 160 u, ≈ 125 u hoch (Annahme nach CS2-Screenshots, ungemessen)
const RMAX = 330 // u, weiteste Ausbreitung (Gänge)
const UP = 1.35, DOWN = 0.85 // Höhe zählt mehr als Breite → flache Kuppel; nach unten fließt der Rauch leichter
const GROW = 1.1 // s bis voll ausgebreitet
const SMOKE_FADE = 3 // s Ausblenden vor smokegrenade_expired (det → expired gemessen 22.06 s)
const SLOTS = 10
// HE (CS2 smoke_volume-Pixelshader, statisch gelesen): frei bis 200 u, Rand bis 240 u, wirkt bis 250 u; Druckwelle schiebt den Rand
// um (1 − smoothstep(0, 2, t))^128 · 250 u nach innen (Loch nach 0.1 s halb, nach 0.2 s ganz offen); Nachfüllen überall gleich smoothstep(0.5, 5, t)^1.8;
// nur HE ab 0.4 s nach Smoke-Beginn; höchstens 5 HE je Smoke
const HE_IN = 200, HE_EDGE = 40, HE_FX = 250, HE_SHOCK = 250, HE_END = 5, HE_N = 5 // u, s
// Schüsse (gleicher Shader): Tunnel 20 u, schließt sich linear über die Lebenszeit, die letzten 100 u vor dem Einschlag bleiben zu (CS2: 16 Spuren)
const SHOT_R = 20, SHOT_END = 100, SHOT_LIFE = 0.8, SHOT_N = 8 // u, s (Lebenszeit = SHOT_WIN in index.ts; CS2-Einheit unbelegt)
const GX = 41, GZ = 25, NCELL = GX * GX * GZ // Suchgitter ±20 / ±12 Voxel um den Start
const RW = C * 1.5 * 1.25 // u, größter Kugelradius (uSize × Größenfaktor): so weit nach Wänden suchen
const LOW_DENS = 2 // Low: Dichte je gezeichnetem Voxel (halbe Anzahl, gleicher Radius: größere Kugeln kosten GPU wie mehr Kugeln, Messung F/smokecmp)

interface Fill {
  n: number; light: number
  /** je Voxel: Mittelpunkt relativ zu center (three, m) */ pos: Float32Array
  /** je Voxel: Ankunft (s), Rand 0..1, Sonne 0..1, Zufall */ data: Float32Array
  /** je Voxel: Umgebungslicht rgb (Lightmap-Einheiten), Größenfaktor */ amb: Float32Array
  /** Low: Schachbrett-Hälfte der Voxel, Anzahl und Attribut-Puffer wie pos/data/amb */
  dn: number; dPos: Float32Array; dData: Float32Array; dAmb: Float32Array
  cells: Map<number, number>; ox: number; oy: number; oz: number
  center: THREE.Vector3; radius: number
}

const VERT = /* glsl */ `
attribute vec4 aPos; attribute vec4 aData; attribute vec4 aAmb;
uniform float uAge, uFade, uSize;
varying float vAlpha; varying vec3 vCenter; varying float vR; varying vec3 vAmb; varying float vSun; varying float vSeed;
varying vec3 vViewC; varying vec3 vView;
void main() {
  float grow = smoothstep(0.0, 0.45, uAge - aData.x);
  float fade = clamp(uFade * 2.0 - aData.y, 0.0, 1.0); // Rand verschwindet zuerst
  float r = uSize * aAmb.w * mix(0.3, 1.0, grow) * mix(0.75, 1.0, fade);
  vec4 wc = modelMatrix * vec4(aPos.xyz, 1.0);
  vec4 mv = viewMatrix * wc;
  float z0 = -mv.z;
  vAlpha = grow * fade * smoothstep(r * 0.4, r * 2.2, z0); // nahe Kugeln weg, das Overlay übernimmt
  vCenter = wc.xyz; vR = r; vAmb = aAmb.rgb; vSun = aData.z; vSeed = aData.w; vViewC = mv.xyz;
  // Quad an die Kugel-Vorderseite, senkrecht zum Strahl zur Kugelmitte: dort ist der Umriss ein Kreis (Radius hs), auch am
  // Bildrand (senkrecht zu z schnitt das Quad bis 26 % ab → gerade Kanten). Die Ebene durch die Mitte schnitt sich mit
  // Wänden/Boden; die Tiefe je Pixel setzt der Fragment-Shader (Strahl gegen Kugel)
  float D = max(length(mv.xyz), 1e-3);
  vec3 dir = mv.xyz / D;
  vec3 rt = normalize(cross(dir, abs(dir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0))), up = cross(rt, dir);
  float dq = D - min(r, D * 0.5), hs = dq * r / sqrt(max(D * D - r * r, 0.09 * r * r));
  mv.xyz = dir * dq + (rt * position.x + up * position.y) * 2.0 * hs;
  vView = mv.xyz;
  gl_Position = vAlpha < 0.003 ? vec4(0.0, 0.0, -2.0, 1.0) : projectionMatrix * mv;
}`
const FRAG = /* glsl */ `
uniform mat4 projectionMatrix; // three deklariert sie nur im Vertex-Shader
uniform sampler3D uNoise; uniform float uClock, uDensity, uLow;
uniform vec3 uSunDir, uSunCol, uAlbedo;
uniform vec4 uHole[${HE_N}]; uniform float uHoleF[${HE_N}]; uniform vec4 uShotA[${SHOT_N}]; uniform vec4 uShotB[${SHOT_N}];
varying float vAlpha; varying vec3 vCenter; varying float vR; varying vec3 vAmb; varying float vSun; varying float vSeed;
varying vec3 vViewC; varying vec3 vView;
void main() {
  // Strahl Kamera → Pixel gegen die Kugel (Ansichtsraum): h = halbe Sehne (Dicke), Tiefe = Vorderseite der Kugel,
  // damit Agenten vor der Kugel sichtbar bleiben und Wände nur dort verdecken, wo sie wirklich davor liegen
  vec3 rd = normalize(vView);
  float b = dot(rd, vViewC), disc = b * b - dot(vViewC, vViewC) + vR * vR;
  if (disc <= 0.0) discard;
  float h = sqrt(disc) / vR;
  vec3 hit = rd * max(b - sqrt(disc), 0.06);
  vec4 cp = projectionMatrix * vec4(hit, 1.0);
  gl_FragDepth = cp.z / cp.w * 0.5 + 0.5;
  vec3 nw = normalize(((hit - vViewC) / vR) * mat3(viewMatrix)); // Kugelnormale in Weltkoordinaten
  vec3 w = vCenter + nw * vR * 0.6; // Rauschen im Weltraum → Nachbarkugeln gehen ineinander über
  float n = texture(uNoise, w * 0.3 + vec3(vSeed, uClock * 0.02, vSeed * 0.7)).r;
  float nn = n * (uLow > 0.5 ? n : texture(uNoise, w * 0.8 - vec3(0.0, uClock * 0.04, 0.0)).r); // Low: ein Rauschzugriff
  // weicher Rand (h³, breite Rauschkante): sonst sieht man jede Kugel als Scheibe mit Umriss
  float a = (1.0 - exp(-uDensity * h * h * h * (0.3 + 3.2 * nn))) * smoothstep(0.02, 0.75, h * (0.4 + n)) * vAlpha;
  // HE-Loch (CS2): frei bis H.w, weicher Rand (verrauscht), überall gleich nachgefüllt um uHoleF
  for (int i = 0; i < ${HE_N}; i++) { vec4 H = uHole[i]; if (uHoleF[i] < 1.0) a *= min(1.0, smoothstep(H.w, H.w + ${(HE_EDGE * HU).toFixed(4)}, distance(w, H.xyz) + (n - 0.5) * ${(HE_EDGE * HU).toFixed(4)}) + uHoleF[i]); }
  // Schuss-Tunnel (CS2-Formel) am Treffpunkt auf dem Sehstrahl: in Schussrichtung gesehen so breit wie in CS2; A.w = Alter 0..1 (Low: alle aus)
  vec3 hw = vCenter + nw * vR;
  for (int i = 0; i < ${SHOT_N}; i++) {
    vec4 A = uShotA[i]; vec3 B = uShotB[i].xyz;
    if (A.w >= 1.0) continue;
    vec3 ab = B - A.xyz, ap = hw - A.xyz;
    float r = length(ap - ab * clamp(dot(ap, ab) / dot(ab, ab), 0.0, 1.0)) * ${(1 / (SHOT_R * HU)).toFixed(4)};
    float e = 1.0 - clamp(distance(hw, B) * ${(1 / (SHOT_END * HU)).toFixed(4)}, 0.0, 1.0);
    a *= 1.0 - smoothstep(0.0, 1.0, 1.0 - clamp(A.w + clamp(r + e, 0.0, 1.0), 0.0, 1.0));
  }
  if (a < 0.004) discard;
  // Licht kommt aus dem Voxel-Selbstschatten, kaum aus der Kugelnormale (sonst sieht man jede Kugel als hell/dunkle Beule)
  float sun = vSun * (0.92 + 0.08 * dot(nw, uSunDir));
  vec3 c = uAlbedo * (uSunCol * sun + vAmb * (0.95 + 0.05 * nw.y)) * (0.85 + 0.3 * n);
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

export function createSmoke(ctx: EffectsContext, shared: Shared) {
  const d = ctx.data.d, rate = d.header.tickrate, N = d.nade
  const st = ctx.assets.map.settings.sun
  const sunG = new THREE.Vector3(...st.toSunGltf).normalize()
  const sunS = [sunG.z, sunG.x, sunG.y] // glTF → Source
  const sunCol = new THREE.Color().setRGB(...st.colorSRGB, THREE.SRGBColorSpace).multiplyScalar(st.threeIntensity / Math.PI)
  const fills = new Map<number, Fill | null>() // null = in Arbeit
  const queue: number[] = []
  let job: Generator<void, Fill> | null = null, jobNade = -1

  // Boden-Raster mit Lichtsonden (gleiches Format wie das Agenten-Licht); fehlt es, Ersatzwerte per raycast
  let grid: FloorGrid | null | undefined
  const m = ctx.assets.map
  Promise.all([fetch(m.floor), fetch(m.probes)])
    .then(async ([f, p]) => { if (!f.ok || !p.ok) throw new Error('floor/probes'); grid = parseFloorGrid(await f.arrayBuffer(), await p.arrayBuffer()) })
    .catch(() => { grid = null })

  // Suchgitter einmal anlegen (Stempel statt Löschen)
  const stamp = new Int32Array(NCELL), prio = new Float32Array(NCELL)
  const heap = new Int32Array(NCELL)
  let stampId = 0
  const vO = new THREE.Vector3(), vD = new THREE.Vector3()
  const ray = (x: number, y: number, z: number, dx: number, dy: number, dz: number, far: number) =>
    ctx.raycast(worldToGltf(x, y, z, vO), vD.set(dy, dz, dx).normalize(), far * HU) / HU

  function* fill(i: number): Generator<void, Fill> {
    const ox = N.x[i], oy = N.y[i], oz = N.z[i] + 12
    const id = ++stampId
    const cidx = (a: number, b: number, c: number) => ((c + 12) * GX + (b + 20)) * GX + (a + 20)
    const pr = (a: number, b: number, c: number) => C * Math.hypot(a, b, c * (c > 0 ? UP : DOWN))
    let hn = 0
    const push = (c: number, p: number) => { prio[c] = p; let k = hn++; while (k > 0) { const q = (k - 1) >> 1; if (prio[heap[q]] <= p) break; heap[k] = heap[q]; k = q } heap[k] = c }
    const pop = () => {
      const top = heap[0], last = heap[--hn]; let k = 0
      for (;;) { let c = 2 * k + 1; if (c >= hn) break; if (c + 1 < hn && prio[heap[c + 1]] < prio[heap[c]]) c++; if (prio[heap[c]] >= prio[last]) break; heap[k] = heap[c]; k = c }
      heap[k] = last; return top
    }
    const out: number[] = [] // Zellindex, Priorität im Wechsel (nur beim Füllen, nicht pro Bild)
    stamp[cidx(0, 0, 0)] = id; push(cidx(0, 0, 0), 0)
    let rays = 0
    const NB = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]
    while (hn > 0 && out.length < BUDGET * 2) {
      const c = pop(), p = prio[c]
      out.push(c, p)
      const a = (c % GX) - 20, b = (Math.floor(c / GX) % GX) - 20, cz = Math.floor(c / (GX * GX)) - 12
      for (let k = 0; k < 18; k += 3) {
        const na = a + NB[k], nb = b + NB[k + 1], nc = cz + NB[k + 2]
        if (na < -20 || na > 20 || nb < -20 || nb > 20 || nc < -12 || nc > 12) continue
        const q = cidx(na, nb, nc)
        if (stamp[q] === id) continue
        const np = pr(na, nb, nc)
        if (np > RMAX) continue
        if (ray(ox + a * C, oy + b * C, oz + cz * C, NB[k], NB[k + 1], NB[k + 2], C) < C) continue // Wand/Boden/Decke
        stamp[q] = id; push(q, np)
        if (++rays % 48 === 0) yield
      }
    }
    // Ergebnis: Ankunftszeit, Selbstschatten Richtung Sonne, Sonden-Licht
    const n = out.length / 2, maxP = Math.max(C, out[out.length - 1])
    const cells = new Map<number, number>()
    for (let v = 0; v < n; v++) cells.set(out[2 * v], v)
    const pos = new Float32Array(n * 4), data = new Float32Array(n * 4), amb = new Float32Array(n * 4)
    const center = worldToGltf(ox, oy, oz, new THREE.Vector3())
    let fallbackSun = 1
    if (!grid) { fallbackSun = ray(ox, oy, oz + 48, sunS[0], sunS[1], sunS[2], 8000) === Infinity ? 1 : 0.15; yield }
    const P = new THREE.Vector3()
    const sunV = new Float32Array(n), occV = new Uint8Array(n), nbs = new Int32Array(n * 6)
    for (let v = 0; v < n; v++) {
      const c = out[2 * v], a = (c % GX) - 20, b = (Math.floor(c / GX) % GX) - 20, z = Math.floor(c / (GX * GX)) - 12
      const r1 = hash(i * 7919 + v * 3), r2 = hash(i * 7919 + v * 3 + 1), r3 = hash(i * 7919 + v * 3 + 2)
      const sx = ox + (a + (r1 - 0.5) * 0.5) * C, sy = oy + (b + (r2 - 0.5) * 0.5) * C, sz = oz + (z + (r3 - 0.5) * 0.4) * C
      worldToGltf(sx, sy, sz, P).sub(center)
      pos.set([P.x, P.y, P.z, 0], v * 4)
      let occ = 0 // Voxel Richtung Sonne
      for (let s = 1; s <= 6; s++) {
        const sa = Math.round(a + sunS[0] * s), sb = Math.round(b + sunS[1] * s), sc = Math.round(z + sunS[2] * s)
        if (Math.abs(sa) <= 20 && Math.abs(sb) <= 20 && Math.abs(sc) <= 12 && cells.has(cidx(sa, sb, sc))) occ++
      }
      for (let k = 0; k < 18; k += 3) {
        const na = a + NB[k], nb = b + NB[k + 1], nc = z + NB[k + 2]
        nbs[v * 6 + k / 3] = Math.abs(na) <= 20 && Math.abs(nb) <= 20 && Math.abs(nc) <= 12 ? cells.get(cidx(na, nb, nc)) ?? -1 : -1
      }
      // Kugel nicht durch Wand/Boden/Decke ragen lassen: sonst schneidet der Tiefentest sie mit harter, gerader Kante ab
      let wall = RW
      for (let k = 0; k < 18; k += 3) wall = Math.min(wall, ray(sx, sy, sz, NB[k], NB[k + 1], NB[k + 2], wall))
      if ((v & 7) === 7) yield
      let sun = fallbackSun, ar = 0.42, ag = 0.42, ab = 0.44
      const l = grid ? floorLayer(grid, sx, sy, sz, 260) : -1
      if (grid?.probes && l >= 0) {
        const o = l * 19, q = (k: number) => (grid!.probes![o + k] / 255) ** 2 * 4
        ar = ag = ab = 0
        for (let f = 0; f < 6; f++) { const wgt = f === 4 ? 0.3 : f === 5 ? 0.1 : 0.15; ar += q(f * 3) * wgt; ag += q(f * 3 + 1) * wgt; ab += q(f * 3 + 2) * wgt }
        sun = grid.probes[o + 18] / 255
      }
      const t = p01(out[2 * v + 1] / maxP)
      sunV[v] = sun; occV[v] = occ
      data.set([GROW * t * t, t, 0, r1 * 10], v * 4)
      amb.set([ar, ag, ab, Math.min(0.9 + 0.35 * r2, Math.max(wall, 0.3 * C) / (1.5 * C))], v * 4)
    }
    // Sonden an Wänden liegen oft in der Wand/im Schatten → dunkle Flecken im hellen Rauch: Licht über die Nachbarvoxel
    // glätten (Rauch streut ohnehin) und nach unten auf 70 % des Mittels begrenzen
    for (let pass = 0; pass < 2; pass++) {
      const s0 = sunV.slice(), a0 = amb.slice()
      for (let v = 0; v < n; v++) {
        let w = 1, s = s0[v], r = a0[v * 4], g = a0[v * 4 + 1], b = a0[v * 4 + 2]
        for (let k = 0; k < 6; k++) { const q = nbs[v * 6 + k]; if (q >= 0) { w++; s += s0[q]; r += a0[q * 4]; g += a0[q * 4 + 1]; b += a0[q * 4 + 2] } }
        sunV[v] = s / w; amb[v * 4] = r / w; amb[v * 4 + 1] = g / w; amb[v * 4 + 2] = b / w
      }
    }
    let mean = 0
    for (let v = 0; v < n; v++) mean += (amb[v * 4] + amb[v * 4 + 1] + amb[v * 4 + 2]) / (3 * n)
    let lum = 0
    for (let v = 0; v < n; v++) {
      const l = (amb[v * 4] + amb[v * 4 + 1] + amb[v * 4 + 2]) / 3, k = l < 0.7 * mean ? (0.7 * mean) / Math.max(l, 1e-4) : 1
      for (let c = 0; c < 3; c++) amb[v * 4 + c] *= k
      const sun = sunV[v] * (0.35 + 0.65 * Math.exp(-occV[v] * 0.35)) // Mehrfachstreuung: innen nicht schwarz
      data[v * 4 + 2] = sun
      lum += 0.63 * (sun * 0.6 * sunCol.g + amb[v * 4 + 1] * 0.85)
    }
    let radius = 0
    for (let v = 0; v < n; v++) radius = Math.max(radius, Math.hypot(pos[v * 4], pos[v * 4 + 1], pos[v * 4 + 2]))
    // Low-Satz, Schachbrett: jedes ausgelassene Voxel hat bis zu 6 gezeichnete Nachbarn im Abstand C, deren Kugeln (frei r ≈ 1.5–2.2 C) es mit abdecken
    const keep: number[] = []
    for (let v = 0; v < n; v++) { const c = out[2 * v]; if ((((c % GX) + (Math.floor(c / GX) % GX) + Math.floor(c / (GX * GX))) & 1) === 0) keep.push(v) }
    const dn = keep.length, dPos = new Float32Array(dn * 4), dData = new Float32Array(dn * 4), dAmb = new Float32Array(dn * 4)
    keep.forEach((v, k) => { dPos.set(pos.subarray(v * 4, v * 4 + 4), k * 4); dData.set(data.subarray(v * 4, v * 4 + 4), k * 4); dAmb.set(amb.subarray(v * 4, v * 4 + 4), k * 4) })
    return { n, light: lum / Math.max(1, n), pos, data, amb, dn, dPos, dData, dAmb, cells, ox, oy, oz, center, radius: radius + C * 1.4 * HU }
  }
  const p01 = (v: number) => Math.min(1, Math.max(0, v))

  // Slots: je ein Mesh mit eigener Material-Kopie (Programm geteilt)
  const quad = new THREE.PlaneGeometry(1, 1)
  const base = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
    uniforms: {
      ...shared, uAge: { value: 0 }, uFade: { value: 1 }, uSize: { value: C * 1.5 * HU }, uDensity: { value: 2.0 }, uLow: { value: 0 },
      uSunDir: { value: sunG }, uSunCol: { value: sunCol }, uAlbedo: { value: new THREE.Color(0.58, 0.61, 0.66) },
      uHole: { value: Array.from({ length: HE_N }, () => new THREE.Vector4()) }, uHoleF: { value: new Array<number>(HE_N).fill(1) },
      uShotA: { value: Array.from({ length: SHOT_N }, () => new THREE.Vector4(0, 0, 0, 1)) }, uShotB: { value: Array.from({ length: SHOT_N }, () => new THREE.Vector4()) },
    },
  })
  const slots = Array.from({ length: SLOTS }, (_, s) => {
    const g = new THREE.InstancedBufferGeometry()
    g.index = quad.index; g.setAttribute('position', quad.getAttribute('position')); g.setAttribute('uv', quad.getAttribute('uv'))
    const attr = ['aPos', 'aData', 'aAmb'].map(nm => { const a = new THREE.InstancedBufferAttribute(new Float32Array(BUDGET * 4), 4); g.setAttribute(nm, a); return a })
    g.instanceCount = 0
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1)
    const mat = base.clone()
    mat.uniforms.uNoise = shared.uNoise; mat.uniforms.uClock = shared.uClock; mat.uniforms.uSunDir = base.uniforms.uSunDir; mat.uniforms.uSunCol = base.uniforms.uSunCol
    const mesh = new THREE.Mesh(g, mat)
    mesh.renderOrder = 10; mesh.frustumCulled = s > 0 // Slot 0 immer im Bild → Programm wird beim ersten Bild kompiliert
    mesh.visible = s === 0
    ctx.scene.add(mesh)
    return { mesh, g, attr, mat, nade: -1, low: false, used: false }
  })

  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3()

  return {
    /** Füll-Arbeit mit Zeitbudget (ms); Smokes im Flug oder aktiv kommen in die Warteschlange */
    work(budgetMs: number) {
      if (grid === undefined) return // Sonden laden noch (nicht im Kreis warten)
      const t0 = performance.now()
      while (performance.now() - t0 < budgetMs) {
        if (!job) {
          const i = queue.shift(); if (i === undefined) return
          job = fill(i); jobNade = i
        }
        const r = job.next()
        if (r.done) { fills.set(jobNade, r.value); job = null }
      }
    },
    pending: () => job !== null || queue.length > 0,
    /** Boden-Raster mit Lichtsonden; undefined = lädt noch, null = fehlt */
    grid: () => grid,
    begin() { for (const s of slots) s.used = false },
    prepare,
    /**
     * Smoke i bei tick zeichnen; he = HE-Granaten [i…] (Löcher), shots = Schuss-Segmente [ax,ay,az,bx,by,bz,alter] (three, m).
     * out.dens = Rauchdichte 0..1 am Kamerapunkt (camS in Source-Units), out.light = Helligkeit für das Overlay.
     */
    draw(i: number, tick: number, he: ArrayLike<number>, nHe: number, shots: Float32Array, nShots: number, cam: THREE.Vector3, camS: [number, number, number], out: { dens: number; light: number }) {
      prepare(i)
      const f = fills.get(i)
      if (!f || tick < N.detTick[i]) return
      const age = (tick - N.detTick[i]) / rate, rem = (N.endTick[i] - tick) / rate
      const fade = p01(rem / SMOKE_FADE)
      if (fade <= 0) return
      // eigener Slot, sonst freier, sonst einer mit gerade unsichtbarer Smoke (aktive verdrängen sich nicht)
      let slot: (typeof slots)[number] | undefined
      for (const s of slots) if (s.nade === i) slot = s
      if (!slot) for (const s of slots) if (!slot && s.nade < 0) slot = s
      if (!slot) for (const s of slots) if (!slot && !s.used && !isActive(s.nade, tick)) slot = s
      if (!slot) return
      const low = getOptions().lowQuality // live umschaltbar
      if (slot.nade !== i || slot.low !== low) {
        slot.nade = i; slot.low = low
        const [aP, aD, aA] = slot.attr, cnt = low ? f.dn : f.n
        ;(aP.array as Float32Array).set(low ? f.dPos : f.pos); (aD.array as Float32Array).set(low ? f.dData : f.data); (aA.array as Float32Array).set(low ? f.dAmb : f.amb)
        for (const a of slot.attr) { a.clearUpdateRanges(); a.addUpdateRange(0, cnt * 4); a.needsUpdate = true }
        slot.g.instanceCount = cnt
        slot.mesh.position.copy(f.center); slot.mesh.updateMatrixWorld()
        slot.g.boundingSphere!.radius = f.radius
      }
      slot.used = true; slot.mesh.visible = true
      const u = slot.mat.uniforms
      u.uAge.value = age; u.uFade.value = fade; u.uLow.value = low ? 1 : 0; u.uDensity.value = 2.0 * (low ? LOW_DENS : 1)
      // HE-Löcher: Innenradius (Druckwelle schiebt ihn anfangs nach innen) und Nachfüllung je HE
      const holes = u.uHole.value as THREE.Vector4[], refill = u.uHoleF.value as number[]
      let h = 0
      for (let k = 0; k < nHe && h < HE_N; k++) {
        const j = he[k], t = (tick - N.detTick[j]) / rate
        if (t < 0 || t >= HE_END || N.detTick[j] < N.detTick[i] + 0.4 * rate) continue
        worldToGltf(N.x[j], N.y[j], N.z[j], tmpA)
        if (tmpA.distanceTo(f.center) > f.radius + HE_FX * HU) continue
        holes[h].set(tmpA.x, tmpA.y, tmpA.z, heInner(t) * HU)
        refill[h++] = heRefill(t)
      }
      const nHole = h
      for (; h < HE_N; h++) refill[h] = 1
      // Schuss-Tunnel: neueste Segmente, die die Hüllkugel schneiden (Low: keine)
      const sa = u.uShotA.value as THREE.Vector4[], sb = u.uShotB.value as THREE.Vector4[]
      let s = 0
      for (let k = low ? -1 : nShots - 1; k >= 0 && s < SHOT_N; k--) {
        const o = k * 7
        if (shots[o + 6] >= SHOT_LIFE) continue
        tmpA.set(shots[o], shots[o + 1], shots[o + 2]); tmpB.set(shots[o + 3], shots[o + 4], shots[o + 5])
        if (segDist(f.center, tmpA, tmpB) > f.radius) continue
        sa[s].set(tmpA.x, tmpA.y, tmpA.z, shots[o + 6] / SHOT_LIFE); sb[s++].set(tmpB.x, tmpB.y, tmpB.z, 0)
      }
      for (; s < SHOT_N; s++) sa[s].w = 1
      // Dichte am Kamerapunkt: belegte, schon angekommene Voxel unter den 8 Nachbarn
      if (cam.distanceTo(f.center) < f.radius) {
        const fx = (camS[0] - f.ox) / C, fy = (camS[1] - f.oy) / C, fz = (camS[2] - f.oz) / C
        const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz)
        let dens = 0
        for (let k = 0; k < 8; k++) {
          const a = x0 + (k & 1), b = y0 + ((k >> 1) & 1), c = z0 + (k >> 2)
          if (a < -20 || a > 20 || b < -20 || b > 20 || c < -12 || c > 12) continue
          const v = f.cells.get(((c + 12) * GX + (b + 20)) * GX + (a + 20))
          if (v === undefined) continue
          const w = (1 - Math.abs(fx - a)) * (1 - Math.abs(fy - b)) * (1 - Math.abs(fz - c))
          dens += w * smooth((age - f.data[v * 4]) / 0.45) * p01(fade * 2 - f.data[v * 4 + 1])
        }
        for (let q = 0; q < nHole; q++) { // Kamera im HE-Loch: Vollbild-Grau mit aufmachen (wie im Shader, ohne Randrauschen)
          const H = holes[q], d = Math.hypot(cam.x - H.x, cam.y - H.y, cam.z - H.z)
          dens *= Math.min(1, smooth((d - H.w) / (HE_EDGE * HU)) + refill[q])
        }
        if (dens > out.dens) { out.dens = dens; out.light = f.light }
      }
    },
    end() {
      for (const s of slots) if (!s.used) s.mesh.visible = false
      const s0 = slots[0]
      if (!s0.used) { s0.mesh.visible = true; s0.g.instanceCount = 0; s0.nade = -1 } // bleibt leer im Bild (vorkompiliert)
    },
    dispose() {
      for (const s of slots) { ctx.scene.remove(s.mesh); s.g.dispose(); s.mat.dispose() }
      quad.dispose(); base.dispose()
    },
  }
  function prepare(i: number) { if (!fills.has(i)) { fills.set(i, null); queue.push(i) } }
  function isActive(j: number, tick: number) { return j >= 0 && N.type[j] === NADE.smoke && tick >= N.detTick[j] && tick < N.endTick[j] }
}

const smooth = (t: number) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t) }
/** HE-Loch t s nach der Detonation: Innenradius (u, < 0 = noch zu) und Nachfüllung 0..1 */
export const heInner = (t: number) => HE_IN - HE_SHOCK * (1 - smooth(t / 2)) ** 128
export const heRefill = (t: number) => smooth((t - 0.5) / (HE_END - 0.5)) ** 1.8
function segDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / (abx * abx + aby * aby + abz * abz || 1)))
  return Math.hypot(p.x - a.x - abx * t, p.y - a.y - aby * t, p.z - a.z - abz * t)
}
