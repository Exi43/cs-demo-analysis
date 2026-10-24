// Test-Ersatz/-Hülle für replay3d/effects: merkt sich den EffectsContext (window.__fx: Raycast/Mündung prüfen) und erlaubt dem Test
// eine feste Kamera (window.__cam) nach dem Kamera-Update der Engine: pos + at (lookAt) oder pos + rot (Euler YXZ wie CS2-Posen),
// fov = vertikal; mapOnly blendet alles außer der Map (erstes Szenen-Kind) und den Lichtern aus (Ladebild-Vergleich).
// wrap(real) legt das um die echten Effekte (--real-effects), ohne real zeichnet der Ersatz nichts.
import * as THREE from 'three'
import type { CreateEffects } from '../../src/renderer/replay3d/contracts'

export const wrap = (real?: CreateEffects): CreateEffects => ctx => {
  const w = window as any
  w.__fx = ctx
  const fx = real?.(ctx) ?? { post: Object.assign(new THREE.Scene(), { visible: false }), update() {}, dispose() {}, pending: () => false }
  return {
    post: fx.post,
    pending: () => fx.pending(),
    update(tick) {
      const c = w.__cam as { pos: number[]; at?: number[]; rot?: number[]; fov?: number; mapOnly?: boolean } | undefined
      if (c) {
        ctx.camera.position.fromArray(c.pos)
        if (c.rot) ctx.camera.rotation.set(c.rot[0], c.rot[1], c.rot[2], 'YXZ'); else ctx.camera.lookAt(new THREE.Vector3().fromArray(c.at!))
        if (c.fov && ctx.camera.fov !== c.fov) { ctx.camera.fov = c.fov; ctx.camera.updateProjectionMatrix() }
        ctx.camera.updateMatrixWorld()
        if (c.mapOnly) ctx.scene.children.forEach((o, i) => { if (i > 0 && !(o as THREE.Light).isLight) o.visible = false })
      }
      fx.update(tick)
    },
    dispose: () => fx.dispose(),
  }
}
export const createEffects = wrap()
