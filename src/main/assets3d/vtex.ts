// Native CS2-Texturen (Critic P1-6): vtex_c (Source-2-Resource, BCn-Mips, je Mip ggf. LZ4) lesen und unverändert als KTX2
// durchreichen. Die GPU behält BC1/BC7 komprimiert (4–8× weniger VRAM als RGBA8 aus WebP), three lädt sie per KTX2Loader
// ohne Transcoder (vkFormat gesetzt). Nur 2D-Texturen ohne Sonderfälle (Würfel/Volumen/Nicht-Zweierpotenz) → sonst null = WebP-Pfad.

/** VTEX_FORMAT → Bytes je 4×4-Block und vkFormat [linear, sRGB] */
const FORMATS: Record<number, { block: number; vk: [number, number]; model: number }> = {
  1: { block: 8, vk: [133, 134], model: 128 }, // DXT1 → BC1_RGBA (wie VRF: 1-Bit-Alpha wird dekodiert)
  2: { block: 16, vk: [137, 138], model: 130 }, // DXT5 → BC3
  20: { block: 16, vk: [145, 146], model: 134 }, // BC7
  21: { block: 16, vk: [141, 141], model: 132 }, // ATI2N → BC5 (nur linear)
  19: { block: 16, vk: [0, 0], model: 0 }, // BC6H (Lightmap): nur bc6h() auf der CPU, KTX2Loader lädt es nicht roh
}
export const BC6H = 19

export interface Vtex { w: number; h: number; format: number; /** Mip 0 = größte */ mips: Uint8Array[] }

/** vtex_c → Mips; null = nicht durchreichbar (unbekanntes Format, Würfel/Volumen, Nicht-Zweierpotenz, Datei kaputt) */
export function readVtex(b: Uint8Array): Vtex | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (b.length < 16 || v.getUint16(4, true) !== 12) return null
  const bo = 8 + v.getUint32(8, true), nb = v.getUint32(12, true)
  let data = -1, size = 0
  for (let i = 0; i < nb; i++) {
    const p = bo + i * 12
    if (String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]) === 'DATA') { data = p + 4 + v.getUint32(p + 4, true); size = v.getUint32(p + 8, true) }
  }
  if (data < 0) return null
  const flags = v.getUint16(data + 2, true), w = v.getUint16(data + 20, true), h = v.getUint16(data + 22, true), depth = v.getUint16(data + 24, true)
  const format = b[data + 26], nMips = b[data + 27], F = FORMATS[format]
  // 0x10 Würfel, 0x20 Volumen; 0x40 Array mit einer Lage (Lightmaps) liegt wie 2D
  if (!F || depth > 1 || flags & 0x30 || !w || !h || !nMips) return null
  let packed: number[] | null = null
  const eo = data + 32 + v.getUint32(data + 32, true), ne = v.getUint32(data + 36, true)
  for (let i = 0; i < ne; i++) {
    const p = eo + i * 12, type = v.getUint32(p, true), o = p + 4 + v.getUint32(p + 4, true)
    if (type === 4) { const n = v.getUint32(o + 8, true); packed = Array.from({ length: n }, (_, k) => v.getInt32(o + 12 + k * 4, true)) }
    // Metadaten: Nutzfläche kleiner als die Textur (z. B. 1×1 in 4×4) → VRF schneidet zu, roh passt das nicht
    if (type === 6) { const nw = v.getUint16(o + 2, true), nh = v.getUint16(o + 4, true); if (nw && nh && (nw !== w || nh !== h)) return null }
  }
  const levelBytes = (l: number) => Math.max(1, Math.ceil((w >> l) / 4)) * Math.max(1, Math.ceil((h >> l) / 4)) * F.block
  // Mips liegen hinter dem DATA-Block, kleinste zuerst
  const mips: Uint8Array[] = []
  let o = data + size
  for (let l = nMips - 1; l >= 0; l--) {
    const raw = levelBytes(l), n = packed?.[l] ?? raw
    if (o + n > b.length) return null
    mips[l] = n < raw ? lz4(b.subarray(o, o + n), raw) : b.slice(o, o + n)
    if (mips[l].length !== raw) return null
    o += n
  }
  return { w, h, format, mips }
}

/** LZ4-Block (ohne Frame) → genau len Bytes */
export function lz4(src: Uint8Array, len: number): Uint8Array {
  const dst = new Uint8Array(len)
  let s = 0, d = 0
  while (s < src.length) {
    const tok = src[s++]
    let lit = tok >> 4
    if (lit === 15) for (let x = 255; x === 255;) { x = src[s++]; lit += x }
    dst.set(src.subarray(s, s + lit), d); s += lit; d += lit
    if (s >= src.length) break
    const off = src[s] | (src[s + 1] << 8); s += 2
    let m = (tok & 15) + 4
    if ((tok & 15) === 15) for (let x = 255; x === 255;) { x = src[s++]; m += x }
    if (off === 0 || off > d || d + m > len) throw new Error('LZ4: corrupt block')
    for (const e = d + m; d < e; d++) dst[d] = dst[d - off]
  }
  if (d !== len) throw new Error('LZ4: wrong length')
  return dst
}

/**
 * KTX2 (KHR_texture_basisu-Nutzlast mit festem vkFormat) aus den Mips bis maxSize Kantenlänge. Ohne Superkompression:
 * zstd spart −31 % Platte (Stufe 19), kostet aber +0,66 s Laden und ~0,9 s Hauptthread-Block in KTX2Loader (Dust2 gemessen) → aus.
 * DFD minimal: three liest nur Primaries/Transfer (sRGB oder linear), ktx-parse/gltf-transform die Größe.
 */
export function ktx2(t: Vtex, maxSize: number, srgb: boolean): Uint8Array {
  const F = FORMATS[t.format]
  let first = 0
  while (first < t.mips.length - 1 && Math.max(t.w >> first, t.h >> first) > maxSize) first++
  const levels = t.mips.slice(first), n = levels.length, dfdOff = 80 + n * 24, dfdLen = 44
  let total = dfdOff + dfdLen
  const offs: number[] = []
  for (let i = n - 1; i >= 0; i--) { total = (total + 15) & ~15; offs[i] = total; total += levels[i].length } // kleinste zuerst, 16-B-ausgerichtet
  const out = new Uint8Array(total), v = new DataView(out.buffer)
  out.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a])
  const u32 = (o: number, x: number) => v.setUint32(o, x, true), u64 = (o: number, x: number) => v.setBigUint64(o, BigInt(x), true)
  ;[F.vk[srgb ? 1 : 0], 1, Math.max(1, t.w >> first), Math.max(1, t.h >> first), 0, 0, 1, n, 0].forEach((x, i) => u32(12 + i * 4, x))
  u32(48, dfdOff); u32(52, dfdLen) // kvd/sgd leer
  for (let i = 0; i < n; i++) { u64(80 + i * 24, offs[i]); u64(88 + i * 24, levels[i].length); u64(96 + i * 24, levels[i].length) }
  // DFD: Gesamtlänge, Basic-Block (Version 2, 40 B), Farbmodell BCn, BT.709, sRGB/linear, 4×4-Block, ein Sample über den Block
  u32(dfdOff, dfdLen); u32(dfdOff + 4, 0); v.setUint16(dfdOff + 8, 2, true); v.setUint16(dfdOff + 10, 40, true)
  out.set([F.model, 1, srgb ? 2 : 1, 0, 3, 3, 0, 0, F.block], dfdOff + 12)
  out[dfdOff + 30] = F.block * 8 - 1; u32(dfdOff + 40, 0xffffffff)
  for (let i = 0; i < n; i++) out.set(levels[i], offs[i])
  return out
}

// ---------------------------------------------------------------- BC6H (unsigned) auf der CPU
// Die Lightmap irradiance.vtex_c ist BC6H 8192² (Dust2): VRF braucht zum Dekodieren 6.3 GB RAM (gemessen), das hier ~0.5 GB.
// Bit-Layouts der 14 Modi nach der D3D11-Spezifikation (Feld, erstes Bit, letztes Bit; gelesen ab LSB, rw11-10 = umgekehrt).

/** Modus-Code → [Endpunkt-Bits, Delta-Bits RGB, transformiert, Layout] */
const MODES: Record<number, [number, number[], boolean, string]> = {
  0: [10, [5, 5, 5], true, 'gy4 by4 bz4 rw0-9 gw0-9 bw0-9 rx0-4 gz4 gy0-3 gx0-4 bz0 gz0-3 bx0-4 bz1 by0-3 ry0-4 bz2 rz0-4 bz3 d0-4'],
  1: [7, [6, 6, 6], true, 'gy5 gz4 gz5 rw0-6 bz0 bz1 by4 gw0-6 by5 bz2 gy4 bw0-6 bz3 bz5 bz4 rx0-5 gy0-3 gx0-5 gz0-3 bx0-5 by0-3 ry0-5 rz0-5 d0-4'],
  2: [11, [5, 4, 4], true, 'rw0-9 gw0-9 bw0-9 rx0-4 rw10 gy0-3 gx0-3 gw10 bz0 gz0-3 bx0-3 bw10 bz1 by0-3 ry0-4 bz2 rz0-4 bz3 d0-4'],
  6: [11, [4, 5, 4], true, 'rw0-9 gw0-9 bw0-9 rx0-3 rw10 gz4 gy0-3 gx0-4 gw10 gz0-3 bx0-3 bw10 bz1 by0-3 ry0-3 bz0 bz2 rz0-3 gy4 bz3 d0-4'],
  10: [11, [4, 4, 5], true, 'rw0-9 gw0-9 bw0-9 rx0-3 rw10 by4 gy0-3 gx0-3 gw10 bz0 gz0-3 bx0-4 bw10 by0-3 ry0-3 bz1 bz2 rz0-3 bz4 bz3 d0-4'],
  14: [9, [5, 5, 5], true, 'rw0-8 by4 gw0-8 gy4 bw0-8 bz4 rx0-4 gz4 gy0-3 gx0-4 bz0 gz0-3 bx0-4 bz1 by0-3 ry0-4 bz2 rz0-4 bz3 d0-4'],
  18: [8, [6, 5, 5], true, 'rw0-7 gz4 by4 gw0-7 bz2 gy4 bw0-7 bz3 bz4 rx0-5 gy0-3 gx0-4 bz0 gz0-3 bx0-4 bz1 by0-3 ry0-5 rz0-5 d0-4'],
  22: [8, [5, 6, 5], true, 'rw0-7 bz0 by4 gw0-7 gy5 gy4 bw0-7 gz5 bz4 rx0-4 gz4 gy0-3 gx0-5 gz0-3 bx0-4 bz1 by0-3 ry0-4 bz2 rz0-4 bz3 d0-4'],
  26: [8, [5, 5, 6], true, 'rw0-7 bz1 by4 gw0-7 by5 gy4 bw0-7 bz5 bz4 rx0-4 gz4 gy0-3 gx0-4 bz0 gz0-3 bx0-5 by0-3 ry0-4 bz2 rz0-4 bz3 d0-4'],
  30: [6, [6, 6, 6], false, 'rw0-5 gz4 bz0 bz1 by4 gw0-5 gy5 by5 bz2 gy4 bw0-5 gz5 bz3 bz5 bz4 rx0-5 gy0-3 gx0-5 gz0-3 bx0-5 by0-3 ry0-5 rz0-5 d0-4'],
  3: [10, [10, 10, 10], false, 'rw0-9 gw0-9 bw0-9 rx0-9 gx0-9 bx0-9'],
  7: [11, [9, 9, 9], true, 'rw0-9 gw0-9 bw0-9 rx0-8 rw10 gx0-8 gw10 bx0-8 bw10'],
  11: [12, [8, 8, 8], true, 'rw0-9 gw0-9 bw0-9 rx0-7 rw11-10 gx0-7 gw11-10 bx0-7 bw11-10'],
  15: [16, [4, 4, 4], true, 'rw0-9 gw0-9 bw0-9 rx0-3 rw15-10 gx0-3 gw15-10 bx0-3 bw15-10'],
}
/** 2-Regionen-Partitionen (Bit i = Pixel i in Region 1) und Anker der Region 1 (wie BC7) */
const PART = [0xcccc, 0x8888, 0xeeee, 0xecc8, 0xc880, 0xfeec, 0xfec8, 0xec80, 0xc800, 0xffec, 0xfe80, 0xe800, 0xffe8, 0xff00, 0xfff0, 0xf000,
  0xf710, 0x008e, 0x7100, 0x08ce, 0x008c, 0x7310, 0x3100, 0x8cce, 0x088c, 0x3110, 0x6666, 0x366c, 0x17e8, 0x0ff0, 0x718e, 0x399c]
const ANCHOR = [15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2]
const W3 = [0, 9, 18, 27, 37, 46, 55, 64], W4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64]
/** Layout → je Bit Ziel (Feld·16 + Bit); Felder: 0–11 = r/g/b × w/x/y/z, 12 = Partition */
const PLAN = new Map(Object.entries(MODES).map(([code, m]) => {
  const out: number[] = []
  for (const tok of m[3].split(' ')) {
    const [, f, a, b] = /^(d|[rgb][wxyz])(\d+)(?:-(\d+))?$/.exec(tok)!
    const field = f === 'd' ? 12 : 'rgb'.indexOf(f[0]) * 4 + 'wxyz'.indexOf(f[1]), lo = +a, hi = b === undefined ? lo : +b
    for (let i = lo; ; i += hi >= lo ? 1 : -1) { out.push(field * 16 + i); if (i === hi) break }
  }
  return [+code, Int16Array.from(out)]
}))

/** BC6H_UF16 → RGB als Halbfloat-Bits (Zeilen von oben), w/h Vielfache von 4 */
export function bc6h(src: Uint8Array, w: number, h: number): Uint16Array {
  const out = new Uint16Array(w * h * 3), q = new Uint32Array(4), e = new Int32Array(13), ep = new Int32Array(12)
  const bw = w >> 2, dv = new DataView(src.buffer, src.byteOffset, src.byteLength)
  const bit = (p: number) => (q[p >> 5] >>> (p & 31)) & 1
  const unq = (x: number, n: number) => n >= 15 ? x : x === 0 ? 0 : x === (1 << n) - 1 ? 0xffff : ((x << 16) + 0x8000) >> n
  for (let k = 0, n = bw * (h >> 2); k < n; k++) {
    for (let i = 0; i < 4; i++) q[i] = dv.getUint32(k * 16 + i * 4, true)
    let code = q[0] & 3, p = 2
    if (code > 1) { code = q[0] & 31; p = 5 }
    const m = MODES[code], plan = PLAN.get(code)
    if (!m) continue // reservierter Modus = schwarz
    e.fill(0)
    for (let i = 0; i < plan!.length; i++, p++) e[plan![i] >> 4] |= bit(p) << (plan![i] & 15)
    const [epb, db, tr] = m, two = p === 82, mask = (1 << epb) - 1
    for (let c = 0; c < 3; c++) for (let j = 0; j < (two ? 4 : 2); j++) {
      let v = e[c * 4 + j]
      if (j && tr) { const s = 32 - db[c]; v = (e[c * 4] + ((v << s) >> s)) & mask } // Delta vorzeichenrichtig zur Basis
      ep[c * 4 + j] = unq(v, epb)
    }
    const part = two ? PART[e[12]] : 0, anchor = two ? ANCHOR[e[12]] : 0, wt = two ? W3 : W4
    const x0 = (k % bw) * 4, y0 = Math.floor(k / bw) * 4
    for (let i = 0; i < 16; i++) {
      const nb = (two ? 3 : 4) - (i === 0 || (two && i === anchor) ? 1 : 0)
      let idx = 0
      for (let b = 0; b < nb; b++) idx |= bit(p++) << b
      const s = (part >> i) & 1, wi = wt[idx], o = ((y0 + (i >> 2)) * w + x0 + (i & 3)) * 3
      for (let c = 0; c < 3; c++) out[o + c] = ((((64 - wi) * ep[c * 4 + s * 2] + wi * ep[c * 4 + s * 2 + 1] + 32) >> 6) * 31) >> 6
    }
  }
  return out
}
