// Voice-Chat aus CS2-Demos lesen (svc_VoiceData, Opus 48 kHz).
// demoparser2 bietet das unter Windows nicht an, daher ein eigener kleiner Frame-Leser.

/** seq = CMsgVoiceAudio.section_number (+1 pro Paket, Lücke = verlorenes Paket) */
export interface VoicePacket { tick: number; steamid: string; opus: Uint8Array; seq?: number }

function varint(b: Uint8Array, p: { i: number }) { let r = 0, s = 0, x; do { x = b[p.i++]; r |= (x & 0x7f) << s; s += 7 } while (x & 0x80); return r >>> 0 }

function unsnappy(src: Uint8Array) {
  const p = { i: 0 }; const out = new Uint8Array(varint(src, p)); let o = 0
  while (p.i < src.length) {
    const tag = src[p.i++], t = tag & 3
    if (t === 0) {
      let l = tag >> 2
      if (l >= 60) { const n = l - 59; l = 0; for (let k = 0; k < n; k++) l |= src[p.i++] << (8 * k) }
      l += 1; out.set(src.subarray(p.i, p.i + l), o); o += l; p.i += l
    } else {
      let l: number, off: number
      if (t === 1) { l = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[p.i++] }
      else if (t === 2) { l = (tag >> 2) + 1; off = src[p.i] | (src[p.i + 1] << 8); p.i += 2 }
      else { l = (tag >> 2) + 1; off = src[p.i] | (src[p.i + 1] << 8) | (src[p.i + 2] << 16) | (src[p.i + 3] << 24); p.i += 4 }
      for (let k = 0; k < l; k++, o++) out[o] = out[o - off]
    }
  }
  return out
}

type Fields = Record<number, (number | Uint8Array)[]>
/** Protobuf-Felder (varint als Zahl, fixed32/64 und len als Bytes) */
export function proto(b: Uint8Array): Fields {
  const p = { i: 0 }, f: Fields = {}
  while (p.i < b.length) {
    const key = varint(b, p), no = key >>> 3, wt = key & 7
    let v: number | Uint8Array
    if (wt === 0) v = varint(b, p)
    else if (wt === 2) { const l = varint(b, p); v = b.subarray(p.i, p.i + l); p.i += l }
    else if (wt === 1) { v = b.subarray(p.i, p.i + 8); p.i += 8 }
    else if (wt === 5) { v = b.subarray(p.i, p.i + 4); p.i += 4 }
    else break
    ;(f[no] ??= []).push(v)
  }
  return f
}

class Bits {
  bit = 0
  b: Uint8Array
  constructor(b: Uint8Array) { this.b = b }
  left() { return this.b.length * 8 - this.bit }
  read(n: number) { let r = 0; for (let k = 0; k < n; k++) { const i = this.bit++; r |= ((this.b[i >> 3] >> (i & 7)) & 1) << k } return r >>> 0 }
  ubitvar() { let r = this.read(6); const x = r & 0x30; if (x === 0x10) r = (r & 15) | (this.read(4) << 4); else if (x === 0x20) r = (r & 15) | (this.read(8) << 4); else if (x === 0x30) r = (r & 15) | (this.read(28) << 4); return r }
  varint() { let r = 0, s = 0, x; do { x = this.read(8); r |= (x & 0x7f) << s; s += 7 } while (x & 0x80 && s < 35); return r >>> 0 }
  bytes(n: number) { const o = new Uint8Array(n); for (let k = 0; k < n; k++) o[k] = this.read(8); return o }
}

const SVC_VOICE_DATA = 47
const OPUS = 2
/** GE_SosStartSoundEvent (Server-Sounds: Schritte, Landungen, Aufprall liegender Waffen …), für parse3d im selben Durchlauf */
const GE_SOS_START = 208

/** onSos: rohe CMsgSosStartSoundEvent je Server-Sound (Pfad ohne zweiten Durchlauf durch die Demo) */
export function extractVoice(buf: Uint8Array, onSos?: (tick: number, msg: Uint8Array) => void): VoicePacket[] {
  const out: VoicePacket[] = []
  let pos = 16 // "PBDEMS2\0" + 2× int32
  while (pos < buf.length) {
    const p = { i: pos }
    let cmd = varint(buf, p); const tick = varint(buf, p); const size = varint(buf, p)
    const comp = (cmd & 64) !== 0; cmd &= ~64
    let data = buf.subarray(p.i, p.i + size); pos = p.i + size
    if (cmd === 0) break // DEM_Stop
    if (cmd !== 7 && cmd !== 8 && cmd !== 13) continue // nur Pakete
    if (comp) data = unsnappy(data)
    let pkt: Uint8Array | undefined
    if (cmd === 13) { const fp = proto(data)[2]?.[0] as Uint8Array | undefined; pkt = fp && (proto(fp)[3]?.[0] as Uint8Array) }
    else pkt = proto(data)[3]?.[0] as Uint8Array | undefined
    if (!pkt) continue
    const bits = new Bits(pkt)
    while (bits.left() > 8) {
      const type = bits.ubitvar(), len = bits.varint()
      if (len * 8 > bits.left()) break
      if (type === GE_SOS_START && onSos) { onSos(tick, bits.bytes(len)); continue }
      if (type !== SVC_VOICE_DATA) { bits.bit += len * 8; continue }
      const m = proto(bits.bytes(len))
      const audio = m[1]?.[0] && proto(m[1][0] as Uint8Array)
      const xuid = m[4]?.[0] as Uint8Array | undefined
      if (!audio || audio[1]?.[0] !== OPUS || !xuid) continue
      const opus = audio[2]?.[0] as Uint8Array | undefined
      if (opus?.length) out.push({ tick, steamid: Buffer.from(xuid).readBigUInt64LE().toString(), opus: opus.slice(), seq: audio[4]?.[0] as number | undefined })
    }
  }
  return out
}

// ---- Ogg-Opus-Container (zum Abspielen/Exportieren, ohne Neu-Kodierung) ----
const CRC = new Uint32Array(256).map((_, n) => { let c = n << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; return c >>> 0 })
function oggPage(seg: Uint8Array[], granule: bigint, serial: number, seq: number, flags: number) {
  const lacing: number[] = []
  for (const s of seg) { let l = s.length; while (l >= 255) { lacing.push(255); l -= 255 } lacing.push(l) }
  const body = seg.reduce((a, s) => a + s.length, 0)
  const page = new Uint8Array(27 + lacing.length + body)
  const dv = new DataView(page.buffer)
  page.set([0x4f, 0x67, 0x67, 0x53], 0); page[5] = flags
  dv.setBigUint64(6, granule, true); dv.setUint32(14, serial, true); dv.setUint32(18, seq, true)
  page[26] = lacing.length; page.set(lacing, 27)
  let o = 27 + lacing.length; for (const s of seg) { page.set(s, o); o += s.length }
  let crc = 0; for (const b of page) crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ b) & 255]) >>> 0
  dv.setUint32(22, crc, true)
  return page
}
/** Samples (48 kHz) eines Opus-Pakets aus dem TOC-Byte */
function opusSamples(p: Uint8Array) {
  const cfg = p[0] >> 3, c = p[0] & 3
  const ms = cfg < 12 ? [10, 20, 40, 60][cfg & 3] : cfg < 16 ? [10, 20][cfg & 1] : [2.5, 5, 10, 20][cfg & 3]
  const frames = c === 0 ? 1 : c === 3 ? (p[1] & 63) : 2
  return Math.round(ms * 48 * frames)
}

/** Ogg-Opus-Datei; Pausen zwischen Paketen werden mit Stille-Paketen aufgefüllt (bis max. 2 s) */
export function toOggOpus(packets: VoicePacket[], tickrate = 64): Uint8Array {
  const serial = 0x43534441, pages: Uint8Array[] = []
  const head = new Uint8Array(19); head.set(new TextEncoder().encode('OpusHead')); head[8] = 1; head[9] = 1
  new DataView(head.buffer).setUint32(12, 48000, true)
  const tags = new Uint8Array([...new TextEncoder().encode('OpusTags'), 4, 0, 0, 0, ...new TextEncoder().encode('csda'), 0, 0, 0, 0])
  pages.push(oggPage([head], 0n, serial, 0, 2), oggPage([tags], 0n, serial, 1, 0))
  const SILENCE = new Uint8Array([0xf8, 0xff, 0xfe]) // 20 ms Stille (CELT)
  let granule = 0n, seq = 2, lastTick = packets[0]?.tick ?? 0
  const batch: Uint8Array[] = []
  const flush = (last: boolean) => { if (batch.length) pages.push(oggPage(batch.splice(0), granule, serial, seq++, last ? 4 : 0)) }
  for (const p of packets) {
    const gapMs = ((p.tick - lastTick) / tickrate) * 1000
    for (let k = 0; k < Math.min(100, Math.floor(gapMs / 20) - 1); k++) { batch.push(SILENCE); granule += 960n; if (batch.length >= 50) flush(false) }
    batch.push(p.opus); granule += BigInt(opusSamples(p.opus)); lastTick = p.tick
    if (batch.length >= 50) flush(false)
  }
  flush(true)
  const total = pages.reduce((a, p) => a + p.length, 0), out = new Uint8Array(total)
  let o = 0; for (const p of pages) { out.set(p, o); o += p.length }
  return out
}
