// Bullet Impacts (Option impacts, Berat 21.10.): je Schuss EIN kleines Kästchen, rot = Spieler getroffen, blau = Map-Treffer.
// Keine Drahtgitter, keine Schusslinie, keine Löcher. Je Runde statisch (Position + Farbe je Instanz), sichtbar 4 s ab Schuss-Tick
// per uTick im Shader → 1 Draw-Call. Rot ohne Strahl (player_hurt + Abstand zur Körperachse); Blau braucht den Map-Strahl:
// lazy über hitOf (Cache mit den Tracern geteilt), zuerst sichtbare Schüsse, höchstens 16 Strahlen bzw. ~1,2 ms je Bild.
import * as THREE from 'three'
import { EV, newSample, roundAt, sampleTrack, upperBound, type CS3D } from '../../../shared/cs3d'
import { HU, eyeZ, worldToGltf } from '../contracts'

const D2R = Math.PI / 180
const MAX = 512 // Schüsse je Runde (gemessen höchstens ~270)
const SHOW_S = 4
// Würfelkante (u), auf dem Bildschirm MIN_PX bis MAX_PX (bei 1080 Zeilen): nahe Treffer (Sprung-Spray in die Mauer, 20–40 u) sonst ~100 px
const BOX_U = 3, MIN_PX = 5, MAX_PX = 10
const NEAR_U = 20 // Strahl höchstens so weit an der Körperachse vorbei = dieser Spieler getroffen
const BODY_U = 16 // Kästchen auf diesem Abstand zur Achse (Eintritt), nicht im Körper versteckt
const RAYS = 16, RAY_MS = 1.2
const HIDE = 1e9 // Tick: noch nicht gerechnet bzw. kein Treffer → unsichtbar

const VERT = /* glsl */ `
attribute float aTick;
uniform float uTick; uniform float uHold; uniform float uPx;
varying vec3 vC;
void main() {
  vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vC = instanceColor * (0.75 + 0.25 * normal.y);
  float k = length(cameraPosition - c) * uPx; // Faktor für MIN_PX
  vec3 P = c + position * clamp(1.0, k, k * ${(MAX_PX / MIN_PX).toFixed(2)});
  gl_Position = uTick >= aTick && uTick < aTick + uHold ? projectionMatrix * viewMatrix * vec4(P, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`
const FRAG = /* glsl */ `varying vec3 vC; void main() { gl_FragColor = vec4(vC, 1.0); }`

/**
 * hitU/hitOf: Abstand (u) von Schuss i bis zur Map, Infinity = keiner; hitU[i] NaN = noch nicht gerechnet, hitOf rechnet und cacht.
 */
export function createImpacts(scene: THREE.Scene, d: CS3D, hitU: Float32Array, hitOf: (i: number) => number) {
  const S = d.shot, E = d.evt, rate = d.header.tickrate
  const U = { uTick: { value: 0 }, uHold: { value: SHOW_S * rate }, uPx: { value: 0 } }
  const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: U })
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(BOX_U * HU, BOX_U * HU, BOX_U * HU), mat, MAX)
  const aTick = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1)
  mesh.geometry.setAttribute('aTick', aTick)
  mesh.frustumCulled = false; mesh.renderOrder = 25
  // Farben direkt als Bildschirmwerte (Shader ohne Farbraum-Umrechnung)
  const RED = new THREE.Color().setRGB(1, 0.12, 0.1), BLUE = new THREE.Color().setRGB(0.2, 0.45, 1)
  mesh.setColorAt(0, BLUE) // instanceColor vor dem ersten Bild anlegen (Shader-Variante)
  const done = new Uint8Array(MAX), smp = newSample(), v = new THREE.Vector3(), m4 = new THREE.Matrix4()
  let round = -1, i0 = 0, i1 = 0, cur = 0, left = 0, dirty = false

  const put = (q: number, tick: number, col: THREE.Color) => {
    mesh.setMatrixAt(q, m4.makeTranslation(v)); mesh.setColorAt(q, col); aTick.array[q] = tick; dirty = true
  }

  function build(r: number) {
    const R = d.header.rounds[r], last = R.firstTick + (R.nFrames - 1) * d.header.frameStep
    const kOf = new Int16Array(256).fill(-1) // Spieler-Index → Track der Runde (255 = unbekannt)
    R.tracks.forEach((p, k) => (kOf[p] = k))
    // shortcut: mehr als 512 Schüsse je Runde werden abgeschnitten (gemessen höchstens ~270), sonst Puffer vergrößern
    i0 = upperBound(S.tick, R.firstTick - 1); i1 = Math.min(upperBound(S.tick, last), i0 + MAX); cur = i0; left = 0
    done.fill(0); (aTick.array as Float32Array).fill(HIDE)
    for (let i = i0; i < i1; i++) {
      const pi = S.pitch[i] * D2R, ya = S.yaw[i] * D2R, dx = Math.cos(pi) * Math.cos(ya), dy = Math.cos(pi) * Math.sin(ya), dz = -Math.sin(pi)
      const h2 = dx * dx + dy * dy
      let best = NEAR_U
      // Opfer von player_hurt am Schuss-Tick bis +1, an dessen Körperachse (Füße bis Kopf) der Strahl am nächsten vorbeigeht
      for (let j = upperBound(E.tick, S.tick[i] - 1); j < E.tick.length && E.tick[j] <= S.tick[i] + 1; j++) {
        const k = kOf[E.player[j]]
        if (E.type[j] !== EV.player_hurt || E.player[j] === S.player[i] || k < 0 || h2 < 1e-6) continue
        sampleTrack(d, r, k, E.tick[j], smp)
        const t = ((smp.x - S.x[i]) * dx + (smp.y - S.y[i]) * dy) / h2
        const px = S.x[i] + dx * t, py = S.y[i] + dy * t, pz = S.z[i] + dz * t
        const dist = Math.hypot(px - smp.x, py - smp.y, pz - Math.min(eyeZ(smp.z, smp.duck) + 8, Math.max(smp.z, pz)))
        if (t <= 0 || dist >= best) continue
        best = dist
        const back = Math.sqrt(BODY_U * BODY_U - Math.min(BODY_U, dist) ** 2)
        worldToGltf(px - dx * back, py - dy * back, pz - dz * back, v)
      }
      if (best < NEAR_U) { put(i - i0, S.tick[i], RED); done[i - i0] = 1 } else left++
    }
    mesh.count = i1 - i0
  }

  /** Map-Strahl für Schuss i (blau); false = Budget dieses Bilds leer */
  let n = 0, t0 = 0
  function ray(i: number): boolean {
    const q = i - i0
    if (done[q]) return true
    const cached = !Number.isNaN(hitU[i])
    if (!cached && (n >= RAYS || performance.now() - t0 > RAY_MS)) return false
    if (!cached) n++
    const h = hitOf(i)
    if (h < 4096) {
      const pi = S.pitch[i] * D2R, ya = S.yaw[i] * D2R, D = h - 0.5
      worldToGltf(S.x[i] + Math.cos(pi) * Math.cos(ya) * D, S.y[i] + Math.cos(pi) * Math.sin(ya) * D, S.z[i] - Math.sin(pi) * D, v)
      put(q, S.tick[i], BLUE)
    }
    done[q] = 1; left--
    return true
  }

  return {
    /** on = Option impacts; aus: nicht in der Szene, 0 Strahlen */
    update(tick: number, on: boolean, camera: THREE.PerspectiveCamera) {
      const r = on ? roundAt(d, tick) : -1
      if (r !== round) {
        round = r
        if (r < 0) mesh.removeFromParent(); else { build(r); scene.add(mesh) }
      }
      if (r < 0) return
      U.uTick.value = tick
      U.uPx.value = ((2 * Math.tan((camera.fov * D2R) / 2)) / 1080) * MIN_PX / (BOX_U * HU)
      if (left) {
        n = 0; t0 = performance.now()
        // zuerst die gerade sichtbaren Schüsse, dann der Rest der Runde
        let ok = true
        for (let i = Math.max(i0, upperBound(S.tick, tick - U.uHold.value)); ok && i < i1 && S.tick[i] <= tick; i++) ok = ray(i)
        while (ok && cur < i1) if ((ok = ray(cur))) cur++
      }
      if (dirty) {
        dirty = false
        mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor!.needsUpdate = true; aTick.needsUpdate = true
      }
    },
    /** Strahlen offen (Option an): in der Pause weiter Bilder zeichnen */
    pending: () => round >= 0 && left > 0,
    dispose() { mesh.removeFromParent(); mesh.geometry.dispose(); mat.dispose() },
  }
}
