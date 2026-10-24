// Farbanpassung der CS2-Shader (g_m*ColorAdjust, Handschuhe und Map-Blend-Layer): gemeinsam für main (Map-Bau) und renderer (Handschuhe).
// Farbanpassung der neuen Kits, nachgebaut aus den nativen VFX-Ausdrucks-Funktionen (materialsystem2.dll statisch, Befund G/README):
// g_m*ColorAdjust = MatrixMultiply(MatrixColorTint2(tint, 1), MatrixColorCorrect2((Kontrast, Sättigung, Helligkeit), TextureAverageColor)).
// Matrizen zeilenweise (16 Zahlen), angewandt als M·(rgb, 1).
type M4 = number[]
const mm = (...ms: M4[]) => ms.reduce((a, b) => a.map((_, k) => { const r = k & 12, c = k & 3; return a[r] * b[c] + a[r + 1] * b[4 + c] + a[r + 2] * b[8 + c] + a[r + 3] * b[12 + c] }))
const dg = (x: number, y: number, z: number): M4 => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]
const tl = (x: number, y: number, z: number): M4 => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]
const LN = [0.2125, 0.7154, 0.0721].map((v, _, l) => v / Math.hypot(...l))
/** MatrixAxisToAxis(LN, z): dreht die Luminanz-Achse auf z (Rodrigues wie die DLL) */
const ROT: M4 = (() => {
  const s = Math.hypot(LN[0], LN[1]), x = LN[1] / s, y = -LN[0] / s, c = LN[2], t = 1 - c
  return [x * x * t + c, x * y * t, y * s, 0, x * y * t, y * y * t + c, -x * s, 0, -y * s, x * s, c, 0, 0, 0, 0, 1]
})()
const ROT_T: M4 = ROT.map((_, k) => ROT[(k & 3) * 4 + (k >> 2)])
const TO_LUM = mm(ROT, dg(LN[0], LN[1], LN[2])), FROM_LUM = mm(dg(1 / LN[0], 1 / LN[1], 1 / LN[2]), ROT_T)
/** Matrix der vfx-Farbanpassung eines Layers; tint/avg linear wie im vmat bzw. der vtex-Reflectivity */
export function colorAdjust(tint: number[], contrast: number, saturation: number, brightness: number, avg: number[]): M4 {
  const [r, g, b] = tint, mx = Math.max(r, g, b), sat = mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0 // HSV-Sättigung des Tints
  const t = TO_LUM, tp = [0, 1, 2].map(i => t[i * 4] * r + t[i * 4 + 1] * g + t[i * 4 + 2] * b), k = 1 - sat * sat // MatrixColorTint2(tint, 1)
  const tint2 = mm(FROM_LUM, tl(tp[0], tp[1], (1 - k) * tp[2]), dg(1 - sat, 1 - sat, k), tl(-tp[0], -tp[1], 0), TO_LUM)
  const correct = mm(FROM_LUM, dg(saturation, saturation, 1), TO_LUM, dg(brightness, brightness, brightness), tl(avg[0], avg[1], avg[2]), dg(contrast, contrast, contrast), tl(-avg[0], -avg[1], -avg[2]))
  return mm(tint2, correct)
}
