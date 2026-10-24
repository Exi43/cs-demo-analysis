// CS2-Crosshair-Sharecodes dekodieren (Quelle: CCSPlayerController.m_szCrosshairCodes, demoparser2 'crosshair_code').
//   "CS" + 44 Zeichen  → 32 Bytes, Version 1   (cs2-v1, seit 30.09.2026; Pixel-Einheiten, Outline-Farbe, Scope-Dot)
//   "CSGO-xxxxx-…"     → 18 Bytes, Version 1   (legacy-v1, alte CS:GO/CS2-Einheiten bis 22.09.2026)
//                                    Version 3/4 (legacy-v3/v4, Pixel-Einheiten 22.–30.09.2026)
// Base57, erstes Zeichen = niederwertigste Ziffer, Bytes big-endian, Byte 0 = Summe(Bytes 1..n) % 256, Byte 1 = Version.
// Layout nach akiver/csgo-sharecode (MIT) + dessen Testvektoren; eigene Implementierung (Spike fp/crosshair, 2435 Tests).
// Reines TS, läuft in Main (parse3d dekodiert beim Import) und Renderer (toRender).

const DICTIONARY = 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789'

/** Pixel-Crosshair (cs2-v1, legacy-v3, legacy-v4). Längen in Pixeln bei screenHeight. */
export interface PixelCrosshair {
  format: 'cs2-v1' | 'legacy-v3' | 'legacy-v4'
  /** 0 Dynamic Cross, 1 Dynamic Circle, 2 Dynamic Cross (Legacy), 3 Static Circle, 4 Static Cross,
   *  5 Static Cross (Shot Feedback), 6 Dot Only, 7 Dynamic Quad, 8 Static Square, 9 Static Quad */
  style: number
  followRecoil: boolean
  centerDotEnabled: boolean
  tStyleEnabled: boolean
  /** 0 keine, 1 voll, 2 halb (nur oben/links). legacy-v3: outlineEnabled → 1 */
  outlineMode: number
  red: number; green: number; blue: number; alpha: number
  /** nur cs2-v1; sonst Schwarz 255 */
  outlineRed: number; outlineGreen: number; outlineBlue: number; outlineAlpha: number
  gap: number
  length: number
  thickness: number
  dynamicSpreadLimit: number
  splitDistance: number
  innerSplitAlpha: number
  outerSplitAlpha: number
  splitSizeRatio: number
  screenHeight: number
  /** nur cs2-v1 (cl_ironsight_dot_scale / cl_ironsight_usecrosshaircolor) */
  scopeDotScale: number
  scopeDotUseCrosshairColor: boolean
}

/** Alte CS:GO-Einheiten (cl_crosshairsize/gap/thickness als Float). */
export interface LegacyV1Crosshair {
  format: 'legacy-v1'
  gap: number
  outlineThickness: number
  red: number; green: number; blue: number; alpha: number
  splitDistance: number
  followRecoil: boolean
  fixedCrosshairGap: number
  /** 0 rot, 1 grün, 2 gelb, 3 blau, 4 cyan, 5 eigene RGB */
  color: number
  outlineEnabled: boolean
  innerSplitAlpha: number
  outerSplitAlpha: number
  splitSizeRatio: number
  thickness: number
  centerDotEnabled: boolean
  deployedWeaponGapEnabled: boolean
  alphaEnabled: boolean
  tStyleEnabled: boolean
  /** alte Styles 0-5 (0 Default, 1 Default Static, 2 Classic, 3 Classic Dynamic, 4 Classic Static, 5 Legacy) */
  style: number
  length: number
}

export type Crosshair = PixelCrosshair | LegacyV1Crosshair

const CS2_RE = new RegExp(`^CS[${DICTIONARY}]{44}$`)
const LEGACY_RE = new RegExp(`^CSGO(-?[${DICTIONARY}]{5}){5}$`)

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const i8 = (b: number) => (b << 24) >> 24
const i16 = (lo: number, hi: number) => ((lo | (hi << 8)) << 16) >> 16
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0

function charsToBytes(chars: string, byteLength: number): Uint8Array | null {
  let big = 0n
  for (let i = chars.length - 1; i >= 0; i--) {
    const d = DICTIONARY.indexOf(chars[i])
    if (d < 0) return null
    big = big * 57n + BigInt(d)
  }
  if (big >> BigInt(byteLength * 8)) return null // passt nicht in byteLength Bytes
  const out = new Uint8Array(byteLength)
  for (let i = byteLength - 1; i >= 0; i--) { out[i] = Number(big & 0xffn); big >>= 8n }
  return out
}
const checksumOk = (b: Uint8Array) => { let s = 0; for (let i = 1; i < b.length; i++) s += b[i]; return (s & 0xff) === b[0] }

/** Liefert null bei ungültigem/unbekanntem Code (Format, Prüfsumme, Version, screenHeight 0). */
export function decodeCrosshair(code: string): Crosshair | null {
  code = code.trim()
  if (CS2_RE.test(code)) {
    const b = charsToBytes(code.slice(2), 32)
    if (!b || !checksumOk(b) || b[1] !== 1) return null
    const h = b[2] | (b[3] << 8)
    if (h === 0) return null
    const bits = u32(b, 18)
    return {
      format: 'cs2-v1',
      style: Math.min(b[4] & 0x1f, 9),
      followRecoil: (b[4] & 0x20) !== 0,
      centerDotEnabled: (b[4] & 0x40) !== 0,
      tStyleEnabled: (b[4] & 0x80) !== 0,
      outlineMode: Math.min(b[13] >> 6, 2),
      red: b[5], green: b[6], blue: b[7], alpha: b[8],
      outlineRed: b[9], outlineGreen: b[10], outlineBlue: b[11], outlineAlpha: b[12],
      gap: clamp(i16(b[14], b[15]), -3840, 3840),
      length: b[16],
      thickness: Math.min(b[13] & 0x3f, 32),
      dynamicSpreadLimit: b[17],
      splitDistance: bits & 0x7f,
      innerSplitAlpha: Math.min((bits >>> 7) & 0x7f, 100) / 100,
      outerSplitAlpha: (Math.min((bits >>> 14) & 0x7f, 70) + 30) / 100,
      splitSizeRatio: Math.min((bits >>> 21) & 0x7f, 100) / 100,
      screenHeight: Math.max(h, 240),
      scopeDotScale: Math.min((b[22] + 10) / 100, 2),
      scopeDotUseCrosshairColor: ((bits >>> 28) & 1) === 1,
    }
  }
  if (LEGACY_RE.test(code)) {
    const b = charsToBytes(code.slice(4).replace(/-/g, ''), 18)
    if (!b || !checksumOk(b)) return null
    if (b[1] === 1) {
      return {
        format: 'legacy-v1',
        gap: i8(b[2]) / 10,
        outlineThickness: b[3] / 2,
        red: b[4], green: b[5], blue: b[6], alpha: b[7],
        splitDistance: b[8] & 0x7f,
        followRecoil: (b[8] & 0x80) !== 0,
        fixedCrosshairGap: i8(b[9]) / 10,
        color: b[10] & 7,
        outlineEnabled: (b[10] & 8) !== 0,
        innerSplitAlpha: (b[10] >> 4) / 10,
        outerSplitAlpha: (b[11] & 0xf) / 10,
        splitSizeRatio: (b[11] >> 4) / 10,
        thickness: b[12] / 10,
        centerDotEnabled: (b[13] & 0x10) !== 0,
        deployedWeaponGapEnabled: (b[13] & 0x20) !== 0,
        alphaEnabled: (b[13] & 0x40) !== 0,
        tStyleEnabled: (b[13] & 0x80) !== 0,
        style: (b[13] & 0xf) >> 1,
        length: (((b[15] & 0x1f) << 8) + b[14]) / 10,
      }
    }
    if (b[1] === 3 || b[1] === 4) {
      const v4 = b[1] === 4
      const bits = u32(b, 10)
      return {
        format: v4 ? 'legacy-v4' : 'legacy-v3',
        style: Math.min(b[2] & 0x0f, v4 ? 8 : 7),
        followRecoil: (b[2] & 0x10) !== 0,
        centerDotEnabled: (b[2] & 0x40) !== 0,
        tStyleEnabled: (b[2] & 0x80) !== 0,
        outlineMode: v4 ? Math.min((bits >>> 28) & 3, 2) : (b[2] & 0x20) ? 1 : 0,
        red: b[3], green: b[4], blue: b[5], alpha: b[6],
        outlineRed: 0, outlineGreen: 0, outlineBlue: 0, outlineAlpha: 255,
        gap: b[7],
        length: b[8],
        thickness: (bits >>> 23) & 0x1f,
        dynamicSpreadLimit: b[9],
        splitDistance: bits & 0x7f,
        innerSplitAlpha: Math.min(((bits >>> 7) & 0x1f) / 20, 1),
        outerSplitAlpha: Math.min((((bits >>> 12) & 0xf) + 6) / 20, 1),
        splitSizeRatio: Math.min((bits >>> 16) & 0x7f, 100) / 100,
        screenHeight: Math.max(b[14] | (b[15] << 8), 240),
        scopeDotScale: 1,
        scopeDotUseCrosshairColor: false,
      }
    }
  }
  return null
}

// ------------------------------------------------------------------ Normalisierung für den Renderer

/** Einheitliche Render-Parameter: Längen in "Referenz-Pixeln" bei screenHeight (Renderer skaliert auf Zielhöhe). */
export interface CrosshairRender {
  style: number
  /** Abstand Rand Mittelquadrat (thickness²) → inneres Balkenende */
  gap: number
  length: number
  thickness: number
  dot: boolean
  tStyle: boolean
  color: [number, number, number, number]
  outlineMode: number
  outlineColor: [number, number, number, number]
  /** Outline-Breite in Referenz-Pixeln (CS2 Pixel-System: 1) */
  outlineThickness: number
  screenHeight: number
  dynamicSpreadLimit: number
  splitDistance: number; innerSplitAlpha: number; outerSplitAlpha: number; splitSizeRatio: number
}

const LEGACY_COLORS: [number, number, number][] = [[250, 50, 50], [50, 250, 50], [250, 250, 50], [50, 50, 250], [50, 250, 250]]
/** alte Styles → neue: 0/3/5 dynamisch → 2 (Dynamic Cross Legacy), 1/2/4 statisch → 4 (Static Cross) */
const LEGACY_STYLE = [2, 4, 4, 2, 4, 2]

export function toRender(c: Crosshair): CrosshairRender {
  if (c.format !== 'legacy-v1') {
    return {
      style: c.style, gap: c.gap, length: c.length, thickness: c.thickness,
      dot: c.centerDotEnabled || c.style === 6, tStyle: c.tStyleEnabled,
      color: [c.red, c.green, c.blue, c.alpha], outlineMode: c.outlineMode,
      outlineColor: [c.outlineRed, c.outlineGreen, c.outlineBlue, c.outlineAlpha], outlineThickness: 1,
      screenHeight: c.screenHeight, dynamicSpreadLimit: c.dynamicSpreadLimit,
      splitDistance: c.splitDistance, innerSplitAlpha: c.innerSplitAlpha, outerSplitAlpha: c.outerSplitAlpha, splitSizeRatio: c.splitSizeRatio,
    }
  }
  // shortcut: Näherung für Demos vor dem 22.09.2026 (CS:GO-Muster YRES(x) = x·H/480, Abstand Mitte → Balken = 4 + gap),
  // nicht gegen CS2 verifiziert; bei Bedarf mit Screenshot einer alten Demo nachkalibrieren
  const rgb = c.color === 5 ? [c.red, c.green, c.blue] : LEGACY_COLORS[c.color] ?? LEGACY_COLORS[1]
  return {
    style: LEGACY_STYLE[c.style] ?? 4,
    gap: 4 + c.gap - c.thickness / 2, length: c.length, thickness: c.thickness,
    dot: c.centerDotEnabled, tStyle: c.tStyleEnabled,
    color: [rgb[0], rgb[1], rgb[2], c.alphaEnabled ? c.alpha : 200],
    outlineMode: c.outlineEnabled ? 1 : 0, outlineColor: [0, 0, 0, 255], outlineThickness: c.outlineThickness * 480 / 1080,
    screenHeight: 480, dynamicSpreadLimit: 64,
    splitDistance: c.splitDistance, innerSplitAlpha: c.innerSplitAlpha, outerSplitAlpha: c.outerSplitAlpha, splitSizeRatio: c.splitSizeRatio,
  }
}
