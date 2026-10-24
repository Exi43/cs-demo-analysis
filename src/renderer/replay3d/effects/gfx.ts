// Gemeinsame GPU-Bausteine der Effekte: Rauschen, instanzierte Sprite-/Streifen-Puffer, Licht-Pool, Vollbild-Overlay.
// Alles mit fester Kapazität angelegt; pro Bild werden nur Float32Arrays beschrieben und die benutzten Bereiche hochgeladen.
import * as THREE from 'three'
import type { CS3D } from '../../../shared/cs3d'
import type { WeaponAssets } from '../../../shared/assets3d'

/** deterministischer Zufall 0..1 aus einer Ganzzahl (gleiches Bild bei jedem Sprung) */
export function hash(a: number): number {
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b); a = Math.imul(a ^ (a >>> 16), 0x45d9f3b)
  return ((a ^ (a >>> 16)) >>> 0) / 4294967296
}

/** weapons.vdata m_nTracerFrequency, solange WeaponAsset.tracerFreq fehlt: diese Gewehre/SMGs jede 3. Kugel, sonst jede, mit Schalldämpfer/MP5-SD nie */
const TRACER3 = new Set(['ak47', 'm4a1', 'm4a1_silencer', 'galilar', 'famas', 'aug', 'sg556', 'mp7', 'mp9', 'mac10', 'p90', 'ump45', 'bizon'])
const SPRAY_GAP = 0.15 // s: längere Pause zwischen zwei Schüssen derselben Waffe = neue Salve (Automatik schießt alle ≤ 0.1 s)

/** je Schuss 1 = zieht einen Tracer: jede n-te Kugel einer Salve ab der ersten (Zähler je Spieler; neue Salve bei Waffenwechsel oder Pause > SPRAY_GAP) */
export function tracerShots(S: CS3D['shot'], weapons: WeaponAssets, rate: number): Uint8Array {
  const freqOf = (def: number, sil: boolean) => {
    const w = weapons[def], f = w?.tracerFreq
    if (f !== undefined) return Array.isArray(f) ? f[sil ? 1 : 0] : f
    const c = w?.className.replace('weapon_', '') ?? ''
    return sil || c === 'mp5sd' ? 0 : TRACER3.has(c) ? 3 : 1
  }
  const out = new Uint8Array(S.tick.length)
  const lastT = new Float64Array(256).fill(-Infinity), lastW = new Int32Array(256).fill(-1), cnt = new Int32Array(256)
  for (let i = 0; i < S.tick.length; i++) {
    const p = S.player[i], w = S.weapon[i]
    cnt[p] = w === lastW[p] && S.tick[i] - lastT[p] <= SPRAY_GAP * rate ? cnt[p] + 1 : 0
    lastT[p] = S.tick[i]; lastW[p] = w
    const f = freqOf(w, S.silenced[i] === 1)
    out[i] = f > 0 && cnt[p] % f === 0 ? 1 : 0
  }
  return out
}

/** kachelbares Value-Noise 32³ (3 Oktaven) für Rauch und Feuer */
export function noiseTexture(N = 32): THREE.Data3DTexture {
  let seed = 1234567
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
  const oct: [number, number, Float32Array][] = [[4, 0.55], [8, 0.3], [16, 0.15]].map(([f, w]) => [f, w, Float32Array.from({ length: f * f * f }, rnd)])
  const sm = (t: number) => t * t * (3 - 2 * t)
  const out = new Uint8Array(N * N * N)
  for (let z = 0, o = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++, o++) {
    let v = 0
    for (const [f, w, L] of oct) {
      const fx = (x * f) / N, fy = (y * f) / N, fz = (z * f) / N
      const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz), x1 = (x0 + 1) % f, y1 = (y0 + 1) % f, z1 = (z0 + 1) % f
      const tx = sm(fx - x0), ty = sm(fy - y0), tz = sm(fz - z0)
      const l = (i: number, j: number, k: number) => L[(k * f + j) * f + i]
      const a = l(x0, y0, z0) + (l(x1, y0, z0) - l(x0, y0, z0)) * tx, b = l(x0, y1, z0) + (l(x1, y1, z0) - l(x0, y1, z0)) * tx
      const c = l(x0, y0, z1) + (l(x1, y0, z1) - l(x0, y0, z1)) * tx, e = l(x0, y1, z1) + (l(x1, y1, z1) - l(x0, y1, z1)) * tx
      v += w * ((a + (b - a) * ty) + ((c + (e - c) * ty) - (a + (b - a) * ty)) * tz)
    }
    out[o] = Math.round(v * 255)
  }
  const t = new THREE.Data3DTexture(out, N, N, N)
  t.format = THREE.RedFormat; t.type = THREE.UnsignedByteType
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping
  t.minFilter = t.magFilter = THREE.LinearFilter
  t.needsUpdate = true
  return t
}

/** gemeinsame Uniforms aller Effekt-Shader (uClock = Tick/Tickrate, damit Rauschen beim Springen gleich aussieht) */
export interface Shared { uNoise: { value: THREE.Data3DTexture }; uClock: { value: number } }

const SPRITE_VERT = /* glsl */ `
attribute vec4 iPos; // xyz three-Welt, w = Größe (m)
attribute vec4 iCol; // rgb linear (HDR), a = Deckkraft
attribute vec4 iPar; // x Art, y Drehung, z Zufall, w: 0 Billboard, 1 flach am Boden, 2 aufrecht (Fuß am Punkt)
varying vec2 vUv; varying vec4 vCol; varying vec3 vPar;
void main() {
  vUv = uv; vCol = iCol; vPar = iPar.xyz;
  vec4 mv;
  if (iPar.w > 1.5) {
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), cameraPosition - iPos.xyz) + vec3(1e-4, 0.0, 0.0));
    mv = viewMatrix * vec4(iPos.xyz + right * position.x * iPos.w * 0.6 + vec3(0.0, (position.y + 0.5) * iPos.w, 0.0), 1.0);
  } else {
    float c = cos(iPar.y), s = sin(iPar.y);
    vec2 q = mat2(c, s, -s, c) * position.xy * iPos.w;
    if (iPar.w > 0.5) mv = viewMatrix * vec4(iPos.xyz + vec3(q.x, 0.0, -q.y), 1.0); // Vorderseite nach oben
    else { mv = viewMatrix * vec4(iPos.xyz, 1.0); mv.xy += q; }
  }
  gl_Position = projectionMatrix * mv;
}`

/** additiv: 0 weiches Leuchten, 1 Mündungsstern, 2 Flamme, 3 Glut am Boden, 4 Feuerball */
const GLOW_FRAG = /* glsl */ `
uniform sampler3D uNoise; uniform float uClock;
varying vec2 vUv; varying vec4 vCol; varying vec3 vPar;
void main() {
  vec2 p = vUv * 2.0 - 1.0; float r2 = dot(p, p);
  vec3 col = vCol.rgb; float a;
  if (vPar.x < 0.5) a = exp(-r2 * 5.0) * (1.0 - smoothstep(0.7, 1.0, r2));
  else if (vPar.x < 1.5) {
    float ang = atan(p.y, p.x);
    float spikes = pow(abs(cos(ang * 2.5 + vPar.z * 6.283)), 8.0) * (0.6 + 0.4 * texture(uNoise, vec3(ang * 0.3, vPar.z, 0.5)).r);
    a = exp(-r2 * 12.0) * 1.5 + spikes * exp(-r2 * 2.2);
  } else if (vPar.x < 2.5) {
    // Flammenzunge: Rauschen steigt auf, seitlich verweht, oben ausgefranst; Kern gelb, Rand orange-rot
    float n = texture(uNoise, vec3(vUv.x * 0.5 + vPar.z, vUv.y * 0.45 - uClock * 0.9, vPar.z * 3.0)).r;
    float n2 = texture(uNoise, vec3(vUv.x * 1.3 - vPar.z, vUv.y * 1.1 - uClock * 1.7, vPar.z * 5.0 + 0.5)).r;
    float h = vUv.y, w = 0.42 * pow(max(1.0 - h, 0.0), 0.7) * (0.6 + 0.8 * n);
    float x = abs(vUv.x - 0.5 + (n2 - 0.5) * 0.35 * h);
    a = smoothstep(w, w * 0.2, x) * smoothstep(0.95, 0.2, h + (n2 - 0.5) * 0.7) * smoothstep(0.0, 0.12, h);
    col *= mix(vec3(0.9, 0.22, 0.03), vec3(1.0, 0.72, 0.32), a * a * (1.0 - h));
  } else if (vPar.x < 3.5) {
    float n = texture(uNoise, vec3(vUv * 1.3 + vPar.z, uClock * 0.25)).r;
    a = (1.0 - smoothstep(0.1, 1.0, r2)) * smoothstep(0.35, 0.8, n) * 1.4; // fleckige Glut statt Scheibe
  } else {
    // Feuerball: verrauschte Kugel, innen gelb-weiß, außen orange-rot
    float n = texture(uNoise, vec3(vUv * 0.8 + vPar.z, vPar.z * 2.0 + uClock * 0.6)).r;
    float m = smoothstep(0.3, 0.75, n + (1.0 - r2) * 0.55) * (1.0 - smoothstep(0.6, 1.0, r2));
    a = m;
    col *= mix(vec3(0.9, 0.25, 0.05), vec3(1.0, 0.85, 0.55), m * m);
  }
  gl_FragColor = vec4(col * a * vCol.a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

/** normal geblendet: weiche, verrauschte Wolke (Staub, Blut, HE-Rauch, Feuerqualm) */
const PUFF_FRAG = /* glsl */ `
uniform sampler3D uNoise; uniform float uClock;
varying vec2 vUv; varying vec4 vCol; varying vec3 vPar;
void main() {
  vec2 p = vUv * 2.0 - 1.0; float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float n = texture(uNoise, vec3(vUv * 0.6 + vPar.z * 7.0, vPar.z + uClock * 0.04)).r;
  float a = pow(1.0 - r2, 1.2) * smoothstep(0.2, 0.7, n + (1.0 - r2) * 0.4) * vCol.a;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol.rgb * (0.7 + 0.6 * n) * (0.85 - 0.25 * p.y), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

const STREAK_VERT = /* glsl */ `
attribute vec4 iA; // xyz Anfang, w Breite (m)
attribute vec4 iB; // xyz Ende, w Art (0 Tracer, 1 Mündungskegel)
attribute vec4 iCol;
varying vec2 vUv; varying vec4 vCol; varying float vKind;
void main() {
  vec3 P = mix(iA.xyz, iB.xyz, position.x);
  vec3 toCam = cameraPosition - P;
  float w = max(iA.w, length(toCam) * 0.002); // mind. ~1.5 px, sonst flimmern ferne Tracer
  P += normalize(cross(iB.xyz - iA.xyz, toCam) + vec3(1e-6)) * position.y * w;
  vUv = vec2(position.x, position.y + 0.5); vCol = iCol; vKind = iB.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}`
const STREAK_FRAG = /* glsl */ `
uniform sampler3D uNoise; uniform float uClock;
varying vec2 vUv; varying vec4 vCol; varying float vKind;
void main() {
  float across = 1.0 - abs(vUv.y * 2.0 - 1.0); across *= across;
  float along = vKind < 0.5 ? vUv.x * vUv.x : (1.0 - vUv.x) * (0.5 + texture(uNoise, vec3(vUv.x * 0.7, vUv.y * 0.3, vCol.a * 9.0)).r);
  gl_FragColor = vec4(vCol.rgb * across * along, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

export interface SpriteBatch {
  mesh: THREE.Mesh
  /** p = three-Welt (m), size = Durchmesser (m), Farbe linear (darf > 1 sein) */
  add(p: THREE.Vector3, size: number, r: number, g: number, b: number, a: number, kind: number, rot: number, seed: number, mode?: number): void
  flush(): void
}

function instanced(base: THREE.BufferGeometry, cap: number, names: string[]) {
  const g = new THREE.InstancedBufferGeometry()
  g.index = base.index
  g.setAttribute('position', base.getAttribute('position'))
  if (base.getAttribute('uv')) g.setAttribute('uv', base.getAttribute('uv'))
  const arr = names.map(n => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4)
    a.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute(n, a)
    return a
  })
  g.instanceCount = 0
  return { g, arr }
}
function upload(arr: THREE.InstancedBufferAttribute[], n: number) {
  for (const a of arr) { a.clearUpdateRanges(); a.addUpdateRange(0, n * 4); a.needsUpdate = true }
}
function effectMesh(g: THREE.BufferGeometry, m: THREE.Material, order: number) {
  const mesh = new THREE.Mesh(g, m)
  mesh.frustumCulled = false // Instanzen liegen überall; leere Puffer zeichnen nichts
  mesh.renderOrder = order
  mesh.matrixAutoUpdate = false
  return mesh
}

export function spriteBatch(kind: 'glow' | 'puff', cap: number, shared: Shared): SpriteBatch {
  const { g, arr } = instanced(new THREE.PlaneGeometry(1, 1), cap, ['iPos', 'iCol', 'iPar'])
  const [P, C, Q] = arr.map(a => a.array as Float32Array)
  const mat = new THREE.ShaderMaterial({
    vertexShader: SPRITE_VERT, fragmentShader: kind === 'glow' ? GLOW_FRAG : PUFF_FRAG, uniforms: { ...shared },
    transparent: true, depthWrite: false, blending: kind === 'glow' ? THREE.AdditiveBlending : THREE.NormalBlending,
  })
  let n = 0
  return {
    mesh: effectMesh(g, mat, kind === 'glow' ? 9 : 8), // vor den Smokes (10): Rauch verdeckt, was dahinter liegt
    add(p, size, r, gg, b, a, k, rot, seed, mode = 0) {
      if (n >= cap || a <= 0.002 || size <= 0) return
      const o = n++ * 4
      P[o] = p.x; P[o + 1] = p.y; P[o + 2] = p.z; P[o + 3] = size
      C[o] = r; C[o + 1] = gg; C[o + 2] = b; C[o + 3] = a
      Q[o] = k; Q[o + 1] = rot; Q[o + 2] = seed; Q[o + 3] = mode
    },
    flush() { g.instanceCount = n; upload(arr, n); n = 0 },
  }
}

export interface StreakBatch {
  mesh: THREE.Mesh
  add(a: THREE.Vector3, b: THREE.Vector3, width: number, r: number, g: number, bl: number, seed: number, kind: number): void
  flush(): void
}
export function streakBatch(cap: number, shared: Shared): StreakBatch {
  const base = new THREE.BufferGeometry()
  base.setAttribute('position', new THREE.Float32BufferAttribute([0, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0, 0, 0.5, 0], 3))
  base.setIndex([0, 1, 2, 0, 2, 3])
  const { g, arr } = instanced(base, cap, ['iA', 'iB', 'iCol'])
  const [A, B, C] = arr.map(a => a.array as Float32Array)
  const mat = new THREE.ShaderMaterial({
    vertexShader: STREAK_VERT, fragmentShader: STREAK_FRAG, uniforms: { ...shared },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  })
  let n = 0
  return {
    mesh: effectMesh(g, mat, 9),
    add(a, b, w, r, gg, bl, seed, k) {
      if (n >= cap) return
      const o = n++ * 4
      A[o] = a.x; A[o + 1] = a.y; A[o + 2] = a.z; A[o + 3] = w
      B[o] = b.x; B[o + 1] = b.y; B[o + 2] = b.z; B[o + 3] = k
      C[o] = r; C[o + 1] = gg; C[o + 2] = bl; C[o + 3] = seed
    },
    flush() { g.instanceCount = n; upload(arr, n); n = 0 },
  }
}

const DECAL_VERT = /* glsl */ `
attribute vec4 iPos; // xyz Mitte (three-Welt), w Durchmesser (m)
attribute vec4 iNrm; // xyz Flächennormale, w Drehung
attribute vec4 iPar; // x Art (0 Einschussloch, 1 Blut), y Zufall, z Deckkraft (0 = leerer Platz)
varying vec2 vUv; varying vec3 vPar;
void main() {
  vUv = uv; vPar = iPar.xyz;
  vec3 n = iNrm.xyz, t = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0))), b = cross(n, t);
  float c = cos(iNrm.w), s = sin(iNrm.w);
  vec2 q = mat2(c, s, -s, c) * position.xy * iPos.w;
  gl_Position = iPar.z <= 0.0 ? vec4(0.0, 0.0, -2.0, 1.0) : projectionMatrix * viewMatrix * vec4(iPos.xyz + t * q.x + b * q.y + n * 0.004, 1.0);
}`
/** multipliziert die Fläche (Licht der Map bleibt): 1 = unverändert */
const DECAL_FRAG = /* glsl */ `
uniform sampler3D uNoise;
varying vec2 vUv; varying vec3 vPar;
void main() {
  vec2 p = vUv * 2.0 - 1.0; float r = length(p);
  float n = texture(uNoise, vec3(vUv * 0.9, vPar.y)).r, n2 = texture(uNoise, vec3(vUv * 3.1, vPar.y + 0.5)).r;
  vec3 col; float a;
  if (vPar.x < 0.5) { // Einschussloch: dunkler Kern, ausgefranster grauer Abplatzer-Rand
    float core = 1.0 - smoothstep(0.2, 0.3 + 0.12 * n, r), ring = (1.0 - smoothstep(0.45, 0.85 + 0.15 * n2, r)) * (1.0 - core);
    col = mix(vec3(0.62), vec3(0.06), core); a = max(core, ring * 0.45);
  } else { // Blut: Rauschfleck mit Tropfen
    a = clamp(smoothstep(0.56, 0.62, n + (1.0 - r) * 0.55) + smoothstep(0.76, 0.8, n2) * (1.0 - smoothstep(0.55, 1.0, r)), 0.0, 1.0);
    col = vec3(0.3, 0.03, 0.025);
  }
  a *= vPar.z;
  if (a < 0.01) discard;
  gl_FragColor = vec4(mix(vec3(1.0), col, a), 1.0);
}`

export interface DecalBatch {
  mesh: THREE.Mesh
  /** Platz slot belegen: p Mitte, n Normale (three-Welt), size Durchmesser (m), kind 0 Einschussloch / 1 Blut */
  set(slot: number, p: THREE.Vector3, n: THREE.Vector3, size: number, rot: number, kind: number, seed: number): void
  off(slot: number): void
  clear(): void
  /** hochladen, nur wenn sich etwas geändert hat */
  flush(): void
}
/** feste Plätze (Ringpuffer verwaltet der Aufrufer), ein Draw-Call; multiplikativ auf die Map, Tiefe getestet, nicht geschrieben */
export function decalBatch(cap: number, shared: Shared): DecalBatch {
  const { g, arr } = instanced(new THREE.PlaneGeometry(1, 1), cap, ['iPos', 'iNrm', 'iPar'])
  const [P, Nr, Q] = arr.map(a => a.array as Float32Array)
  const mat = new THREE.ShaderMaterial({
    vertexShader: DECAL_VERT, fragmentShader: DECAL_FRAG, uniforms: { uNoise: shared.uNoise },
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    blending: THREE.CustomBlending, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  })
  g.instanceCount = cap
  let dirty = true
  return {
    mesh: effectMesh(g, mat, 7),
    set(slot, p, n, size, rot, kind, seed) {
      const o = slot * 4
      P[o] = p.x; P[o + 1] = p.y; P[o + 2] = p.z; P[o + 3] = size
      Nr[o] = n.x; Nr[o + 1] = n.y; Nr[o + 2] = n.z; Nr[o + 3] = rot
      Q[o] = kind; Q[o + 1] = seed; Q[o + 2] = 1
      dirty = true
    },
    off(slot) { if (Q[slot * 4 + 2]) { Q[slot * 4 + 2] = 0; dirty = true } },
    clear() { Q.fill(0); dirty = true },
    flush() { if (dirty) { upload(arr, cap); dirty = false } },
  }
}

/** Wünsche an den festen Licht-Pool sammeln, pro Bild die stärksten (gewichtet mit Kameraabstand) auf die Lichter legen. Lichtanzahl bleibt konstant. */
export interface LightPool {
  want(p: THREE.Vector3, r: number, g: number, b: number, intensity: number, distance: number): void
  flush(cam: THREE.Vector3): void
}
/** off (Low): alle Wünsche verwerfen, Lichter bleiben mit Intensität 0 in der Szene (gleiche Lichtanzahl → kein neues Programm) */
/** off() = true (Low, live): keine Lichter, flush schaltet die Pool-Lichter aus (Lichtanzahl bleibt, kein neues Programm) */
export function lightPool(lights: THREE.PointLight[], off = () => false): LightPool {
  const MAX = 32, R = new Float32Array(MAX * 8), score = new Float32Array(MAX)
  let n = 0
  for (const l of lights) l.intensity = 0
  return {
    want(p, r, g, b, intensity, distance) {
      if (off() || n >= MAX || intensity <= 0) return
      const o = n++ * 8
      R[o] = p.x; R[o + 1] = p.y; R[o + 2] = p.z; R[o + 3] = r; R[o + 4] = g; R[o + 5] = b; R[o + 6] = intensity; R[o + 7] = distance
    },
    flush(cam) {
      for (let i = 0; i < n; i++) {
        const o = i * 8, dx = R[o] - cam.x, dy = R[o + 1] - cam.y, dz = R[o + 2] - cam.z
        score[i] = R[o + 6] / (1 + (dx * dx + dy * dy + dz * dz) / (R[o + 7] * R[o + 7]))
      }
      for (const l of lights) {
        let best = -1
        for (let i = 0; i < n; i++) if (score[i] > 0 && (best < 0 || score[i] > score[best])) best = i
        if (best < 0) { l.intensity = 0; continue }
        const o = best * 8
        score[best] = 0
        l.position.set(R[o], R[o + 1], R[o + 2]); l.color.setRGB(R[o + 3], R[o + 4], R[o + 5]); l.intensity = R[o + 6]; l.distance = R[o + 7]; l.decay = 2
      }
      n = 0
    },
  }
}

/**
 * Vollbild-Schicht in Bildschirmwerten (kein Tonemapping): Farbe color (rgb, a = Deckkraft) über einem Bild tex mit Deckkraft shot.value,
 * ein Draw-Call (vormultipliert: rgb = Bild·shot·(1−a) + Farbe·a, Deckkraft 1 − (1−shot)(1−a)). Rauch-Grau: shot 0; Flash: Weiß über
 * dem Nachbild (tex = ctx.captureFrame, leicht aufgehellt). Ein Programm für beide Schichten.
 */
export function overlay() {
  const u = { uColor: { value: new THREE.Vector4(1, 1, 1, 0) }, uTex: { value: null as THREE.Texture | null }, uShot: { value: 0 } }
  const mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */ `uniform vec4 uColor; uniform sampler2D uTex; uniform float uShot; varying vec2 vUv;
void main() {
  vec3 img = uShot > 0.0 ? 1.0 - (1.0 - texture2D(uTex, vUv).rgb) * 0.8 : vec3(0.0);
  gl_FragColor = vec4(img * uShot * (1.0 - uColor.a) + uColor.rgb * uColor.a, 1.0 - (1.0 - uShot) * (1.0 - uColor.a));
}`,
    uniforms: u, transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false, toneMapped: false,
  })
  const mesh = effectMesh(new THREE.PlaneGeometry(2, 2), mat, 1e6)
  return { mesh, color: u.uColor.value, tex: u.uTex, shot: u.uShot }
}
