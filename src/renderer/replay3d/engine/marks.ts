// Markierungen der Utility-Vorschau (Lineup ohne Demo, Engine.setMarks): angenäherte Flugbahn als dünne Röhre, Ziel als Ring am Boden
// (Radius wie der Landekreis der Flugbahn, effects/trails.ts) mit senkrechtem Strahl. Immer sichtbar (depthTest aus, nach der Welt),
// ohne Nebel; Farben linear, der Endpass (post.ts) tonemappt sie wie die Szene. 3 Draw-Calls.
import * as THREE from 'three'
import { HU, worldToGltf, type LineupMarks } from '../contracts'

const PATH_M = 0.045 // Röhrenradius (m): bei 10 m Abstand ≈ 6 px hoch bei 1080 Zeilen
const NEAR_M = 1.5 // Röhre erst ab diesem Abstand vom Abwurf: direkt vor dem Auge füllte ihr Querschnitt das Bild
const RING_U = 28

export function createMarks(scene: THREE.Scene, m: LineupMarks) {
  const v = (p: [number, number, number]) => worldToGltf(p[0], p[1], p[2], new THREE.Vector3())
  const mat = (color: [number, number, number], opacity: number) =>
    new THREE.MeshBasicMaterial({ color: new THREE.Color(...color), transparent: true, opacity, depthTest: false, depthWrite: false, fog: false, side: THREE.DoubleSide })
  const g = new THREE.Group(), t = v(m.target), pts = m.path.map(v), far = pts.filter(p => p.distanceTo(pts[0]) > NEAR_M)
  if (far.length > 1) g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(far), far.length * 2, PATH_M, 6), mat([1.6, 1.05, 0.2], 0.85)))
  const ring = new THREE.Mesh(new THREE.RingGeometry(RING_U * HU * 0.78, RING_U * HU, 48).rotateX(-Math.PI / 2), mat([1.8, 0.25, 0.12], 0.95))
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.4, 8).translate(0, 1.2, 0), mat([1.8, 0.25, 0.12], 0.55))
  ring.position.copy(t).y += 0.03
  beam.position.copy(t)
  g.add(ring, beam)
  g.traverse(o => { o.renderOrder = 30; o.frustumCulled = false })
  scene.add(g)
  return {
    dispose() {
      g.removeFromParent()
      g.traverse(o => { const x = o as THREE.Mesh; if (x.isMesh) { x.geometry.dispose(); (x.material as THREE.Material).dispose() } })
    },
  }
}
