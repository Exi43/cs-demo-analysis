// Granaten-Flugbahn bei X-Ray (Bild 9): gelbe Bahn bis zur aktuellen Position, Abprall-Marken an Pfad-Knicken, roter Landekreis.
// Je Runde EINMAL statisch gebaut (alle Granatentypen); pro Bild nur Uniform uTick → keine Uploads, 2 Draw-Calls, depthTest aus.
import * as THREE from 'three'
import { roundAt, upperBound, type CS3D } from '../../../shared/cs3d'
import { HU, worldToGltf } from '../contracts'

const D2R = Math.PI / 180
const HOLD_S = 3 // s Ausblenden nach der Detonation
const RING_U = 28 // u Radius Landekreis
const KINK_U = 4 // u: 2. Differenz der 32-Hz-Punkte (ohne Schwerkraft) darüber = Abprall
const GRAVITY = 800 // u/s² (sv_gravity)
const LINE_PX = 7, MARK_PX = 7 // Breite der Bahn, Radius der Abprall-Marke (px bei 1080 Zeilen)

const SEG_VERT = /* glsl */ `
attribute vec4 iA; // xyz Anfang (m), w Tick
attribute vec4 iB; // xyz Ende (m), w Tick
attribute float iDet;
uniform float uTick; uniform float uHold; uniform float uPx;
varying float vA; varying float vY;
void main() {
  float f = clamp((uTick - iA.w) / max(1.0, iB.w - iA.w), 0.0, 1.0); // nur bis zur aktuellen Position
  vec3 P = mix(iA.xyz, iB.xyz, position.x * f), toCam = cameraPosition - P, s = cross(iB.xyz - iA.xyz, toCam);
  P += s / max(1e-6, length(s)) * position.y * length(toCam) * uPx * ${LINE_PX}.0;
  vA = 1.0 - clamp((uTick - iDet) / uHold, 0.0, 1.0); vY = position.y * 2.0;
  gl_Position = uTick >= iA.w && vA > 0.0 ? projectionMatrix * viewMatrix * vec4(P, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`
const SEG_FRAG = /* glsl */ `
varying float vA; varying float vY;
void main() { float c = 1.0 - abs(vY); gl_FragColor = vec4(mix(vec3(1.0, 0.72, 0.08), vec3(1.0, 0.97, 0.7), c * c), smoothstep(0.0, 0.6, c) * vA); }`
const MARK_VERT = /* glsl */ `
attribute vec4 iP; // xyz (m), w sichtbar ab Tick
attribute vec3 iQ; // x Detonation, y Art (0 Landekreis flach am Boden, 1 Abprall-Marke zur Kamera), z Radius (m bzw. px)
uniform float uTick; uniform float uHold; uniform float uPx;
varying vec2 vUv; varying float vA; varying float vK;
void main() {
  vec3 P = iP.xyz;
  if (iQ.y < 0.5) P += vec3(position.x, 0.0, position.y) * iQ.z + vec3(0.0, 0.03, 0.0);
  else P += (vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]) * position.x + vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]) * position.y) * length(cameraPosition - P) * uPx * iQ.z;
  vUv = position.xy; vK = iQ.y; vA = 1.0 - clamp((uTick - iQ.x) / uHold, 0.0, 1.0);
  gl_Position = uTick >= iP.w && vA > 0.0 ? projectionMatrix * viewMatrix * vec4(P, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`
const MARK_FRAG = /* glsl */ `
varying vec2 vUv; varying float vA; varying float vK;
void main() {
  float r = length(vUv), ring = smoothstep(0.62, 0.74, r) * (1.0 - smoothstep(0.88, 1.0, r));
  float a = vK < 0.5 ? ring + 1.0 - smoothstep(0.07, 0.12, r) : ring;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vK < 0.5 ? vec3(1.0, 0.16, 0.1) : vec3(1.0, 0.85, 0.25), a * vA);
}`

/** Instanz-Geometrie aus einem Grund-Quad; attrs: Name → [Daten, Größe] */
function instanced(base: THREE.BufferGeometry, n: number, attrs: Record<string, [Float32Array, number]>) {
  const g = new THREE.InstancedBufferGeometry()
  g.setIndex(base.index); g.setAttribute('position', base.getAttribute('position'))
  for (const [k, [a, s]] of Object.entries(attrs)) g.setAttribute(k, new THREE.InstancedBufferAttribute(a, s))
  g.instanceCount = n
  return g
}

export function createTrails(scene: THREE.Scene, d: CS3D) {
  const N = d.nade, Pt = d.path, rate = d.header.tickrate
  const U = { uTick: { value: 0 }, uHold: { value: HOLD_S * rate }, uPx: { value: 0 } }
  const mat = (vertexShader: string, fragmentShader: string) => new THREE.ShaderMaterial({
    vertexShader, fragmentShader, uniforms: U, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  })
  const segQuad = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0), markQuad = new THREE.PlaneGeometry(2, 2)
  const seg = new THREE.Mesh(new THREE.BufferGeometry(), mat(SEG_VERT, SEG_FRAG))
  const mark = new THREE.Mesh(new THREE.BufferGeometry(), mat(MARK_VERT, MARK_FRAG))
  for (const m of [seg, mark]) { m.frustumCulled = false; m.matrixAutoUpdate = false; m.renderOrder = 30 }
  const v = new THREE.Vector3()
  let round = -1

  /** Abweichung der 2. Differenz am Pfadpunkt j von der Schwerkraft (u); 0 am Rand */
  const kink = (j: number, s: number, e: number) => {
    if (j <= s || j >= e - 1) return 0
    const dt = (Pt.tick[j + 1] - Pt.tick[j - 1]) / 2 / rate
    return Math.hypot(Pt.x[j + 1] - 2 * Pt.x[j] + Pt.x[j - 1], Pt.y[j + 1] - 2 * Pt.y[j] + Pt.y[j - 1], Pt.z[j + 1] - 2 * Pt.z[j] + Pt.z[j - 1] + GRAVITY * dt * dt)
  }

  function build(r: number) {
    const R = d.header.rounds[r], last = R.firstTick + (R.nFrames - 1) * d.header.frameStep
    const A: number[] = [], B: number[] = [], Det: number[] = [], MP: number[] = [], MQ: number[] = []
    for (let i = upperBound(N.throwTick, R.firstTick - 1); i < N.type.length && N.throwTick[i] <= last; i++) {
      const s = N.pathStart[i], e = N.pathStart[i + 1], det = N.detTick[i]
      if (e - s < 2) continue
      for (let j = s; j + 1 < e; j++) {
        worldToGltf(Pt.x[j], Pt.y[j], Pt.z[j], v); A.push(v.x, v.y, v.z, Pt.tick[j])
        worldToGltf(Pt.x[j + 1], Pt.y[j + 1], Pt.z[j + 1], v); B.push(v.x, v.y, v.z, Pt.tick[j + 1])
        Det.push(det)
        const k = kink(j, s, e) // lokales Maximum: ein Abprall knickt oft zwei Punkte hintereinander
        if (k > KINK_U && k >= kink(j - 1, s, e) && k > kink(j + 1, s, e)) {
          worldToGltf(Pt.x[j], Pt.y[j], Pt.z[j], v); MP.push(v.x, v.y, v.z, Pt.tick[j]); MQ.push(det, 1, MARK_PX)
        }
      }
      worldToGltf(Pt.x[e - 1], Pt.y[e - 1], Pt.z[e - 1], v); MP.push(v.x, v.y, v.z, N.throwTick[i]); MQ.push(det, 0, RING_U * HU) // Vorschau ab Wurf
    }
    seg.geometry.dispose(); mark.geometry.dispose()
    seg.geometry = instanced(segQuad, Det.length, { iA: [new Float32Array(A), 4], iB: [new Float32Array(B), 4], iDet: [new Float32Array(Det), 1] })
    mark.geometry = instanced(markQuad, MQ.length / 3, { iP: [new Float32Array(MP), 4], iQ: [new Float32Array(MQ), 3] })
    seg.visible = Det.length > 0; mark.visible = MQ.length > 0
  }

  return {
    /** on = xray && nadeTrails; aus: nicht in der Szene (0 Draw-Calls) */
    update(tick: number, on: boolean, camera: THREE.PerspectiveCamera) {
      const r = on ? roundAt(d, tick) : -1
      if (r !== round) {
        round = r
        if (r < 0) { seg.removeFromParent(); mark.removeFromParent() } else { build(r); scene.add(seg, mark) }
      }
      if (r < 0) return
      U.uTick.value = tick
      U.uPx.value = (2 * Math.tan((camera.fov * D2R) / 2)) / 1080 // m je px und m Abstand (Breite in px bei 1080 Zeilen)
    },
    dispose() {
      for (const m of [seg, mark]) { m.removeFromParent(); m.geometry.dispose(); m.material.dispose() }
      segQuad.dispose(); markQuad.dispose()
    },
  }
}
