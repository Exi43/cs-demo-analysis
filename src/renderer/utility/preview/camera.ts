// Kamera-Ablauf der Lineup-Vorschau (rein, ohne three): je Tick Ego mit Zoom → Granate folgen → Außenansicht als Kreisfahrt
// von oben um die Wirkung. Ausgeführt von der Engine (setZoom, setView). Test: camera.test.ts.
type V3 = [number, number, number]
/** Überblendung (s) Ego → Granate bzw. → Außenansicht; Außenansicht steht ab der Wirkung so lange (s), dann zurück zum Start */
export const FOLLOW_BLEND = 0.35, OUT_BLEND = 0.8, OUT_S = 5
/** Außenansicht: Kreisfahrt um die Wirkung (Berat: von oben, ein paar Meter weg, 360°) – Abstand in Source-Units (~13 m), Höhe in Grad */
export const ORBIT_DIST = 520, ORBIT_ELEV = 40

/** Kreisfahrt ab Tick det um target, Start hinter dem Werfer (Blick in Wurfrichtung), eine Runde in OUT_S */
export function orbitView(target: V3, from: V3, det: number) {
  const yaw0 = (Math.atan2(from[1] - target[1], from[0] - target[0]) * 180) / Math.PI
  return { orbit: { center: [target[0], target[1], target[2] + 64] as V3, dist: ORBIT_DIST, elev: ORBIT_ELEV, yaw0, turnS: OUT_S, t0: det } }
}
/** Zoom-Stufen (Blickfeld geteilt) */
export const ZOOMS = [1, 2, 4]
const D2R = Math.PI / 180

/** 0 = Ego (vor dem Wurf, oder ohne „Follow grenade“), 1 = Granate folgen bis zur Wirkung, 2 = Außenansicht */
export const phaseAt = (tick: number, throwTick: number, det: number, follow: boolean): 0 | 1 | 2 =>
  !follow || tick < throwTick ? 0 : tick < det ? 1 : 2

/** Zoom gilt vor dem Wurf, danach in 0,3 s weich zurück auf 1 */
export function zoomAt(tick: number, throwTick: number, zoom: number, rate: number): number {
  const k = Math.min(1, Math.max(0, (tick - throwTick) / (0.3 * rate)))
  return zoom + (1 - zoom) * k * k * (3 - 2 * k)
}
