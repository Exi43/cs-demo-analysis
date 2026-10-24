// Granaten-Kamera (Option nadeCam, Bild 9): kleines Bild der fliegenden Granate. Rendert die Szene linear in ein eigenes kleines
// HDR-Ziel (gleiche Programme wie der Hauptpass, also kein Shader-Bau beim ersten Einsatz); die Engine zeichnet es mit dem Endpass
// (post.ts draw) in den PiP-Rahmen. Billig gehalten (Paket B, vorher +333 Draw-Calls, 28 statt 60 fps): far 25 m, nur jedes 2. Bild
// neu (dazwischen das letzte Bild), Agenten außerhalb des Bildes sondert three selbst aus (agents.ts, feste Hülle), in Low aus.
// Kamera sieht nur Layer 0 (Schilder auf Layer 1, Viewmodel eigene Szene). Ohne Granate im Flug: null, kein Draw-Call.
// shortcut: steckt die Hauptkamera im Rauch, färbt das Rauch-Overlay der Effekte (Layer 0) auch dieses Bild grau.
import * as THREE from 'three'
import { nadeInFlight } from '../../../shared/cs3d'
import { worldToGltf, type Replay3DData } from '../contracts'
import { getOptions } from '../options'

const BACK_M = 0.6 // Kamera hinter dem Projektil
const FAR_M = 25 // im ~330×186-Bild ist Fernes nur wenige Pixel groß; three sondert so die Map-Teile dahinter aus (Draw-Calls)
/** Sprung (Ticks) seit dem letzten gerenderten Bild, ab dem sofort neu gerendert wird */
const JUMP = 8

export interface NadeCam {
  /**
   * HDR-Bild (linear) der Granate für ein PiP von w×h Zeichenpuffer-Pixeln; focus = Spieler-Index (header.players), dessen Granate
   * Vorrang hat, sonst die jüngste im Flug. null = aus, Low oder keine Granate: nichts gezeichnet.
   */
  render(tick: number, w: number, h: number, focus?: number): THREE.Texture | null
  dispose(): void
}

/** enabled = false (Low): render liefert immer null */
export function createNadeCam(renderer: THREE.WebGLRenderer, scene: THREE.Scene, data: Replay3DData, enabled: boolean): NadeCam {
  const d = data.d, N = d.nade, Pt = d.path
  const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, FAR_M)
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: true, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter })
  const p = new THREE.Vector3(), q = new THREE.Vector3(), dir = new THREE.Vector3(1, 0, 0)
  let lastI = -1, lastT = NaN, skip = false

  /** Pfadposition von Granate i bei tick (linear zwischen den 32-Hz-Punkten, an den Enden geklemmt), three-Welt */
  function at(i: number, tick: number, out: THREE.Vector3) {
    let lo = N.pathStart[i], hi = N.pathStart[i + 1] - 1
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (Pt.tick[m] <= tick) lo = m; else hi = m }
    const k = Math.min(1, Math.max(0, (tick - Pt.tick[lo]) / Math.max(1, Pt.tick[hi] - Pt.tick[lo])))
    return worldToGltf(Pt.x[lo] + (Pt.x[hi] - Pt.x[lo]) * k, Pt.y[lo] + (Pt.y[hi] - Pt.y[lo]) * k, Pt.z[lo] + (Pt.z[hi] - Pt.z[lo]) * k, out)
  }

  return {
    render(tick, w, h, focus = -1) {
      w = Math.round(w); h = Math.round(h)
      if (!enabled || !getOptions().nadeCam || w < 1 || h < 1) return null
      const i = nadeInFlight(d, tick, focus)
      if (i < 0) { lastI = -1; return null }
      const fresh = i !== lastI || !(Math.abs(tick - lastT) < JUMP) || rt.width !== w || rt.height !== h
      skip = !fresh && !skip
      if (skip) return rt.texture // jedes 2. Bild: das letzte zeigen
      lastI = i; lastT = tick
      const t = Math.min(tick, N.detTick[i]) // nach der Detonation stehen bleiben
      at(i, t, p)
      at(i, t + 2, q).sub(at(i, t - 2, cam.position)) // Flugrichtung über ±1 Pfadpunkt
      if (q.lengthSq() > 1e-8) dir.copy(q).normalize() // liegt die Granate still: letzte Richtung behalten
      cam.position.copy(p).addScaledVector(dir, -BACK_M)
      cam.lookAt(q.copy(p).add(dir))
      cam.aspect = w / h; cam.updateProjectionMatrix(); cam.updateMatrixWorld()
      rt.setSize(w, h)
      const sm = renderer.shadowMap, auto = sm.autoUpdate, need = sm.needsUpdate, prev = renderer.getRenderTarget(), mw = scene.matrixWorldAutoUpdate
      sm.autoUpdate = false; sm.needsUpdate = false // Schatten aus dem Hauptpass
      scene.matrixWorldAutoUpdate = false // Matrizen stehen seit dem Hauptpass desselben Bildes (spart den zweiten Szenen-Durchlauf)
      renderer.setRenderTarget(rt); renderer.render(scene, cam); renderer.setRenderTarget(prev)
      sm.autoUpdate = auto; sm.needsUpdate = need; scene.matrixWorldAutoUpdate = mw
      return rt.texture
    },
    dispose() { rt.dispose() },
  }
}
