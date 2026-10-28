// Econ-Attribute (Sticker, Charms) der Waffen aus der Demo. demoparser2 0.42 gibt von der Attributliste einer Waffe nur Slot 0–2
// (Paint/Seed/Wear) aus, weapon_stickers liest starr 4er-Gruppen ab Slot 4 (Reverse-Engineering.md 21.10.). Daher hier ein kleiner
// Source-2-Entity-Leser nur für die FullPackets (alle 3840 Ticks = 60 s der komplette Stand aller Entities, inkl. Baselines).
// Portiert aus demoparser2 (sendtables.rs, decoder.rs, path_ops.rs, entities.rs; Bit-Verbrauch je Decoder identisch),
// https://github.com/LaihoE/demoparser, MIT License, Copyright (c) LaihoE. Lizenztext: THIRD_PARTY_NOTICES.md
// shortcut: nur FullPackets → Waffen, die kürzer als 60 s existieren, fehlen; lückenlos ginge nur mit allen Paketen (≈ 10× Parse-Zeit)
import type { Charm3D, Sticker3D } from '../shared/cs3d.ts'
import { proto } from './voice.ts'

const u8 = (v: unknown) => (v instanceof Uint8Array ? v : new Uint8Array(0))
const num = (v: unknown) => (typeof v === 'number' ? v : 0)
const str = (v: unknown) => (v instanceof Uint8Array ? new TextDecoder().decode(v) : '')
const f32 = (v: unknown) => (v instanceof Uint8Array && v.length === 4 ? new DataView(v.buffer, v.byteOffset, 4).getFloat32(0, true) : 0)
/** repeated int32 (gepackt oder einzeln) */
const ints = (a: unknown[] = []) => a.flatMap(v => {
  if (!(v instanceof Uint8Array)) return [num(v)]
  const out: number[] = []
  for (let i = 0; i < v.length;) { let r = 0, s = 0, x; do { x = v[i++]; r |= (x & 127) << s; s += 7 } while (x & 128 && i < v.length); out.push(r >>> 0) }
  return out
})

class Bits {
  pos = 0
  private b: Uint8Array
  private end: number
  constructor(b: Uint8Array) { this.b = b; this.end = b.length * 8 }
  left() { return this.end - this.pos }
  read(n: number): number {
    if (this.pos + n > this.end) throw new Error('econ: Daten zu Ende')
    let r = 0, got = 0
    while (got < n) {
      const sh = this.pos & 7, take = Math.min(8 - sh, n - got)
      r += ((this.b[this.pos >> 3] >> sh) & ((1 << take) - 1)) * 2 ** got
      got += take; this.pos += take
    }
    return r
  }
  skip(n: number) { if ((this.pos += n) > this.end) throw new Error('econ: Daten zu Ende') }
  bytes(n: number) {
    if (!(this.pos & 7)) { const s = this.pos >> 3; this.skip(8 * n); return this.b.subarray(s, s + n) }
    const o = new Uint8Array(n)
    for (let i = 0; i < n; i++) o[i] = this.read(8)
    return o
  }
  bool() { return this.read(1) === 1 }
  ubv() { const b = this.read(6), x = b & 0x30; return x === 0x10 ? (b & 15) | (this.read(4) << 4) : x === 0x20 ? (b & 15) | (this.read(8) << 4) : x === 0x30 ? (b & 15) + this.read(28) * 16 : b }
  ubvfp() { return this.bool() ? this.read(2) : this.bool() ? this.read(4) : this.bool() ? this.read(10) : this.bool() ? this.read(17) : this.read(31) }
  varint() { let r = 0; for (let c = 0; c < 5; c++) { const b = this.read(8); r |= (b & 127) << (7 * c); if (!(b & 128)) break } return r >>> 0 }
  svarint() { const x = this.varint() | 0; return x & 1 ? ~(x >> 1) : x >> 1 }
  coord() { const i = this.bool(), f = this.bool(); if (i || f) this.skip(1 + (i ? 14 : 0) + (f ? 5 : 0)) }
}

// ---------------------------------------------------------------- Decoder (nur Bit-Verbrauch; Wert nur für Ganzzahl/roh 32 bit)

const NOSCALE = 0, VARINT = 1, BOOL = 2, QF = 3, QANGLE3 = 4, VEC96 = 5, COORD = 6, VCOORD = 7, STRING = 8, QVAR = 9, NORMAL = 10, U64 = 11,
  FIXED64 = 12, QPRES = 13, POLY = 14, BLOB = 15
interface Dec { k: number; n?: number; fl?: number }
const D = (k: number): Dec => ({ k })
const BASE: Record<string, Dec> = {
  bool: D(BOOL), char: D(STRING), int16: D(VARINT), int32: D(VARINT), int64: D(VARINT), int8: D(VARINT), uint16: D(VARINT), uint32: D(VARINT),
  uint8: D(VARINT), color32: D(VARINT), GameTime_t: D(NOSCALE), CBodyComponent: D(BOOL), CGameSceneNodeHandle: D(VARINT), Color: D(VARINT),
  CPhysicsComponent: D(BOOL), CRenderComponent: D(BOOL), CUtlString: D(STRING), CUtlStringToken: D(VARINT), CUtlSymbolLarge: D(STRING),
  CGlobalSymbol: D(STRING), CUtlBinaryBlock: D(BLOB), Quaternion: D(NOSCALE), CTransform: D(NOSCALE),
  ...Object.fromEntries(['HSequence', 'AttachmentHandle_t', 'CEntityIndex', 'MoveCollide_t', 'MoveType_t', 'RenderMode_t', 'RenderFx_t', 'SolidType_t',
    'SurroundingBoundsType_t', 'ModelConfigHandle_t', 'NPC_STATE', 'StanceType_t', 'AbilityPathType_t', 'WeaponState_t', 'DoorState_t',
    'RagdollBlendDirection', 'BeamType_t', 'BeamClipStyle_t', 'EntityDisolveType_t', 'tablet_skin_state_t', 'CStrongHandle', 'CSWeaponMode',
    'ESurvivalSpawnTileState', 'SpawnStage_t', 'ESurvivalGameRuleDecision_t', 'RelativeDamagedDirection_t', 'CSPlayerState', 'MedalRank_t',
    'CSPlayerBlockingUseAction_t', 'MoveMountingAmount_t', 'QuestProgress::Reason'].map(n => [n, D(U64)])),
}

/** Quantisierter Float (demoparser2 QuantalizedFloat::new, f32-genau): nur Flags und Bitzahl zählen */
export function quantized(bitCount: number, flags0: number, low0: number, high0: number): Dec {
  const f = Math.fround
  let low = f(low0), high = f(high0), fl = flags0 >>> 0, bc = bitCount
  if (fl) {
    if ((low === 0 && fl & 1) || (high === 0 && fl & 2)) fl &= ~4
    if (low === 0 && fl & 4) fl = (fl | 1) & ~4
    if (high === 0 && fl & 4) fl = (fl | 2) & ~4
    if (low > 0 || high < 0) fl &= ~4
    if (fl & 8) fl &= ~7
  }
  let steps = 2 ** bc
  if (fl & 1) high = f(high - f(f(high - low) / steps))
  else if (fl & 2) low = f(low + f(f(high - low) / steps))
  if (fl & 8) {
    let delta = f(high - low)
    if (delta < 1) delta = 1
    const r2 = 2 ** Math.ceil(f(Math.log2(delta)))
    let b = bc
    while (!(2 ** b > r2)) b++
    if (b > bc) { bc = b; steps = 2 ** bc }
    high = f(low + f(r2 - f(r2 / steps)))
  }
  const hi = f(bc === 32 ? 0xfffffffe : 2 ** bc - 1), range = f(high - low)
  let mul = Math.abs(range) <= 0 ? hi : f(hi / range)
  if (f(mul * range) > hi) for (const m of [0.9999, 0.99, 0.9, 0.8, 0.7]) { mul = f(f(hi / range) * f(m)); if (!(f(mul * range) > hi)) break }
  const dec = f(1 / f(steps - 1))
  const quant = (v: number) => {
    if (v < low) return low
    if (v > high) return high
    const t = f(f(v - low) * mul), i = t > 0 ? Math.min(Math.floor(t), 0xffffffff) : 0
    return f(low + f(f(high - low) * f(f(i) * dec)))
  }
  if (fl & 1 && quant(low) === low) fl &= ~1
  if (fl & 2 && quant(high) === high) fl &= ~2
  if (fl & 4 && quant(0) === 0) fl &= ~4
  return { k: QF, n: bc, fl: fl >>> 0 }
}

/** liest einen Wert; Ganzzahlen und rohe 32 bit (NOSCALE) als Zahl, sonst 0 */
function read(r: Bits, d: Dec): number {
  switch (d.k) {
    case NOSCALE: return r.read(32)
    case VARINT: return r.varint()
    case BOOL: return r.read(1)
    case QF: if (!(d.fl! & 1 && r.bool()) && !(d.fl! & 2 && r.bool()) && !(d.fl! & 4 && r.bool())) r.skip(d.n!); return 0
    case QANGLE3: r.skip(3 * d.n!); return 0
    case VEC96: r.skip(96); return 0
    case COORD: r.coord(); return 0
    case VCOORD: r.coord(); r.coord(); r.coord(); return 0
    case STRING: while (r.read(8)); return 0
    case QVAR: { const a = r.bool(), b = r.bool(), c = r.bool(); if (a) r.coord(); if (b) r.coord(); if (c) r.coord(); return 0 }
    case NORMAL: { const a = r.bool(), b = r.bool(); r.skip((a ? 12 : 0) + (b ? 12 : 0) + 1); return 0 }
    case U64: for (let i = 0; i < 10 && r.read(8) & 128; i++); return 0
    case FIXED64: r.skip(64); return 0
    case QPRES: { const n = +r.bool() + +r.bool() + +r.bool(); r.skip(20 * n); return 0 }
    case POLY: r.read(1); r.ubv(); return 0
    case BLOB: r.skip(8 * r.varint()); return 0
  }
  throw new Error(`econ: Decoder ${d.k}`)
}

// ---------------------------------------------------------------- Serializer (CSVCMsg_FlattenedSerializer)

const VALUE = 0, VECTOR = 1, ARRAY = 2, SER = 3, PTR = 4
interface Ser { name: string; fields: (Field | undefined)[] }
/** tag (nur oberste Ebene): 1 def, 2 Item-ID low, 3 high, 4 Attributliste (m_Attributes) */
interface Field { kind: number; dec: Dec; name: string; inner?: Field; ser?: Ser; tag?: number }
interface FType { base: string; generic?: FType; pointer: boolean; count?: number }
const RE = /([^<[*]+)(<\s(.*)\s>)?(\*)?(\[(.*)\])?/
const POINTERS = new Set(['CBodyComponent', 'CLightComponent', 'CPhysicsComponent', 'CRenderComponent', 'CPlayerLocalData'])
function ftype(name: string): FType {
  const m = RE.exec(name)!
  return { base: m[1] ?? '', generic: m[3] !== undefined ? ftype(m[3]) : undefined, pointer: m[4] === '*' || POINTERS.has(name), count: m[6] === undefined ? undefined : /^-?\d+$/.test(m[6]) ? +m[6] : 0 }
}

function decoderOf(name: string, t: FType, enc: string, bits: number, flags: number, low: number, high: number): Dec {
  const float = () => name === 'm_flSimulationTime' || name === 'm_flAnimTime' || enc === 'm_flSimulationTime' ? D(VARINT)
    : enc === 'coord' ? D(COORD) : bits <= 0 || bits >= 32 ? D(NOSCALE) : quantized(bits, flags, low, high)
  const vec = (n: number) => { if (n === 3 && enc === 'normal') return D(NORMAL); const fd = float(); return D(fd.k === NOSCALE ? VEC96 : fd.k === COORD ? VCOORD : NORMAL) }
  const u64 = () => D(enc === 'fixed64' ? FIXED64 : U64)
  let d: Dec
  if (name === 'm_iClip1') d = D(VARINT)
  else if (BASE[t.base]) d = BASE[t.base]
  else {
    const n = t.generic ? t.generic.base : t.base
    d = n === 'float32' || n === 'CNetworkedQuantizedFloat' ? float() : n === 'Vector' || n === 'VectorWS' ? vec(3) : n === 'Vector2D' ? vec(2)
      : n === 'Vector4D' ? vec(4) : n === 'uint64' || n === 'CStrongHandle' || n === 'CEntityHandle' ? u64() : n === 'CHandle' ? D(VARINT)
      : n === 'QAngle' ? (name === 'm_angEyeAngles' ? D(VEC96) : bits !== 0 ? { k: QANGLE3, n: bits } : D(QVAR)) : BASE[n] ?? D(VARINT)
  }
  if (name === 'm_PredFloatVariables' || name === 'm_OwnerOnlyPredNetFloatVariables') d = D(NOSCALE)
  if (name === 'm_OwnerOnlyPredNetVectorVariables' || name === 'm_PredVectorVariables') d = D(VEC96)
  if (name === 'm_pGameModeRules') d = D(POLY)
  if (enc === 'qangle_precise') d = D(QPRES)
  return d
}

const ITEM = 'm_AttributeManager.m_Item'
function serializers(data: Uint8Array): Map<string, Ser> {
  let p = 0, len = 0, s = 0, x
  do { x = data[p++]; len |= (x & 127) << s; s += 7 } while (x & 128)
  const m = proto(data.subarray(p, p + len))
  const sym = (m[2] ?? []).map(str), raw = (m[3] ?? []).map(b => proto(u8(b)))
  const cache: (Field | undefined)[] = [], sers = new Map<string, Ser>()
  const make = (fm: ReturnType<typeof proto>): Field => {
    const name = sym[num(fm[2]?.[0])], type = sym[num(fm[1]?.[0])], bits = num(fm[3]?.[0]) | 0, node = sym[num(fm[9]?.[0])] ?? ''
    const serName = fm[7] ? sym[num(fm[7][0])] : undefined, enc = fm[10] ? sym[num(fm[10][0])] : ''
    const t = ftype(type)
    const kind = t.pointer || POINTERS.has(t.base) ? PTR : serName || t.base === 'CUtlVector' || t.base === 'CNetworkUtlVectorBase' ? VECTOR
      : t.count !== undefined && t.base !== 'char' ? ARRAY : VALUE
    const dec = decoderOf(name, t, enc, bits, num(fm[6]?.[0]), f32(fm[4]?.[0]), f32(fm[5]?.[0]))
    let el: Field
    if (serName) {
      const ser = sers.get(serName)
      if (!ser) throw new Error(`econ: Serializer ${serName} fehlt`)
      el = kind === PTR ? { kind: PTR, dec: D(serName === 'CCSGameModeRules' ? POLY : BOOL), name, ser } : { kind: SER, dec, name, ser }
    } else el = { kind: VALUE, dec, name }
    const f: Field = kind === ARRAY || kind === VECTOR ? { kind, dec, name, inner: el } : el
    if (node === ITEM) f.tag = name === 'm_iItemDefinitionIndex' ? 1 : name === 'm_iItemIDLow' ? 2 : name === 'm_iItemIDHigh' ? 3 : undefined
    if (name === 'm_Attributes' && node === ITEM + '.m_NetworkedDynamicAttributes') f.tag = 4
    if (name === 'm_Attributes' && node === ITEM + '.m_AttributeList') f.tag = 5
    return f
  }
  for (const b of m[1] ?? []) {
    const sm = proto(u8(b)), name = sym[num(sm[1]?.[0])]
    sers.set(name, { name, fields: ints(sm[3]).map(i => (cache[i] ??= raw[i] && make(raw[i]))) })
  }
  return sers
}

// ---------------------------------------------------------------- Entities

/** Feldpfad-Operationen: Huffman-Code (Bitfolge wie gelesen) → Op, aus demoparser2 path_ops.rs */
const CODES: [number, string][] = [[0, '0'], [39, '10'], [8, '11000'], [2, '110010'], [29, '110011'], [4, '11010'], [30, '110110000'],
  [38, '1101100010'], [35, '1101100011000000'], [34, '1101100011000001'], [27, '110110001100001'], [25, '1101100011000100'],
  [24, '1101100011000101'], [33, '1101100011000110'], [28, '1101100011000111'], [13, '1101100011001000'], [15, '11011000110010010'],
  [14, '11011000110010011'], [6, '110110001100101'], [21, '11011000110011000'], [20, '11011000110011001'], [23, '11011000110011010'],
  [22, '11011000110011011'], [17, '11011000110011100'], [16, '11011000110011101'], [19, '11011000110011110'], [18, '11011000110011111'],
  [5, '110110001101'], [36, '11011000111'], [10, '11011001'], [7, '11011010'], [12, '110110110'], [37, '110110111'], [9, '11011100'],
  [31, '110111010'], [26, '110111011'], [32, '11011110'], [3, '11011111'], [1, '1110'], [11, '1111']]
/** Binärbaum als Array: Knoten i → Kinder 2i+1 (Bit 0) / 2i+2 (Bit 1); Blatt = Op + 1 */
const TREE = new Map<number, number>()
for (const [op, code] of CODES) { let n = 0; for (const c of code) n = 2 * n + 1 + +c; TREE.set(n, op + 1) }
const STOP = 39

/** Pfade einer Entity lesen (alle zuerst, dann die Werte); P = je Pfad 7 Indizes + Tiefe */
let P = new Int32Array(8 * 1024)
function paths(r: Bits): number {
  const p = new Int32Array([-1, 0, 0, 0, 0, 0, 0])
  let last = 0, n = 0
  const pop = (k: number) => { for (let i = 0; i < k; i++) p[last--] = 0 }
  for (;;) {
    let node = 0, op
    while (!(op = TREE.get(node))) { node = 2 * node + 1 + r.read(1); if (node > 1 << 18) throw new Error('econ: Huffman') }
    op--
    if (op === STOP) return n
    switch (op) {
      case 0: p[last] += 1; break
      case 1: p[last] += 2; break
      case 2: p[last] += 3; break
      case 3: p[last] += 4; break
      case 4: p[last] += r.ubvfp() + 5; break
      case 5: p[++last] = 0; break
      case 6: last++; p[last] += r.ubvfp(); break
      case 7: p[last] += 1; p[++last] = 0; break
      case 8: p[last] += 1; p[++last] = r.ubvfp(); break
      case 9: p[last] += r.ubvfp(); p[++last] = 0; break
      case 10: p[last] += r.ubvfp() + 2; p[++last] = r.ubvfp() + 1; break
      case 11: p[last] += r.read(3) + 2; p[++last] = r.read(3) + 1; break
      case 12: p[last] += r.read(4) + 2; p[++last] = r.read(4) + 1; break
      case 13: last++; p[last] += r.ubvfp(); last++; p[last] += r.ubvfp(); break
      case 14: p[++last] = r.read(5); p[++last] = r.read(5); break
      case 15: for (let i = 0; i < 3; i++) { last++; p[last] += r.ubvfp() } break
      case 16: for (let i = 0; i < 3; i++) p[++last] = r.read(5); break
      case 17: p[last] += 1; for (let i = 0; i < 2; i++) { last++; p[last] += r.ubvfp() } break
      case 18: p[last] += 1; for (let i = 0; i < 2; i++) { last++; p[last] += r.read(5) } break
      case 19: p[last] += 1; for (let i = 0; i < 3; i++) { last++; p[last] += r.ubvfp() } break
      case 20: p[last] += 1; for (let i = 0; i < 3; i++) { last++; p[last] += r.read(5) } break
      case 21: p[last] += r.ubv() + 2; for (let i = 0; i < 2; i++) { last++; p[last] += r.ubvfp() } break
      case 22: p[last] += r.ubv() + 2; for (let i = 0; i < 2; i++) { last++; p[last] += r.read(5) } break
      case 23: p[last] += r.ubv() + 2; for (let i = 0; i < 3; i++) { last++; p[last] += r.ubvfp() } break
      case 24: p[last] += r.ubv() + 2; for (let i = 0; i < 3; i++) { last++; p[last] += r.read(5) } break
      case 25: { const k = r.ubv(); p[last] += r.ubv(); for (let i = 0; i < k; i++) { last++; p[last] += r.ubvfp() } break }
      case 26: { for (let i = 0; i <= last; i++) if (r.bool()) p[i] += r.svarint() + 1; const k = r.ubv(); for (let i = 0; i < k; i++) p[++last] = r.ubvfp(); break }
      case 27: pop(1); p[last] += 1; break
      case 28: pop(1); p[last] += r.ubvfp() + 1; break
      case 29: pop(last); p[0] += 1; break
      case 30: pop(last); p[0] += r.ubvfp() + 1; break
      case 31: pop(last); p[0] += r.read(3) + 1; break
      case 32: pop(last); p[0] += r.read(6) + 1; break
      case 33: pop(r.ubvfp()); p[last] += 1; break
      case 34: pop(r.ubvfp()); p[last] += r.svarint(); break
      case 35: pop(r.ubvfp()); for (let i = 0; i <= last; i++) if (r.bool()) p[i] += r.svarint(); break
      case 36: for (let i = 0; i <= last; i++) if (r.bool()) p[i] += r.svarint(); break
      case 37: p[last - 1] += 1; break
      case 38: for (let i = 0; i <= last; i++) if (r.bool()) p[i] += r.read(4) - 7; break
      default: throw new Error(`econ: Pfad-Op ${op}`)
    }
    if (last < 0 || last > 6) throw new Error('econ: Pfadtiefe')
    if (8 * n + 8 > P.length) { const q = new Int32Array(P.length * 2); q.set(P); P = q }
    P.set(p, 8 * n); P[8 * n + 7] = last; n++
  }
}

/** Zustand einer Entity: nur Item-Felder und Attributliste */
interface List { len: number; def: number[]; raw: number[] }
interface Ent { cls: number; def: number; lo: number; hi: number; att: [List, List] }
function decode(r: Bits, ser: Ser, e: Ent) {
  const n = paths(r)
  for (let k = 0; k < n; k++) {
    const o = 8 * k, last = P[o + 7], top = ser.fields[P[o]]
    let f = top
    for (let i = 1; i <= last; i++) {
      if (!f) break
      f = f.kind === ARRAY || f.kind === VECTOR ? f.inner : f.kind === SER || f.kind === PTR ? f.ser!.fields[P[o + i]] : undefined
    }
    if (!f || f.kind === ARRAY || f.kind === SER) throw new Error('econ: Feldpfad ungültig')
    const v = read(r, f.kind === VECTOR ? D(VARINT) : f.dec)
    switch (top!.tag) {
      case 1: e.def = v; break
      case 2: e.lo = v; break
      case 3: e.hi = v; break
      case 4: case 5: {
        const L = e.att[top!.tag - 4]
        if (last === 0) L.len = v
        else if (last === 2 && f.name === 'm_iAttributeDefinitionIndex') L.def[P[o + 1]] = v
        else if (last === 2 && f.name === 'm_iRawValue32') L.raw[P[o + 1]] = v
      }
    }
  }
}

/** [Attribut-Def, roher 32-bit-Wert] je Item-ID ("hi:lo" wie parse3d), aufsteigend nach Def wie in der Demo */
export type EconAttrs = Map<string, [number, number][]>

const F32 = new DataView(new ArrayBuffer(4))
const asFloat = (u: number) => { F32.setUint32(0, u >>> 0, true); return Math.round(F32.getFloat32(0, true) * 1e4) / 1e4 }
/**
 * Aufkleber und Anhänger aus der Attributliste (items_game attributes: 113+4s id, 114+4s wear, 115+4s scale, 116+4s rotation,
 * 278+2s/279+2s offset, 290+s schema; 299 keychain id, 300–302 offset, 306 seed, 314 highlight, 321 sticker). Ganzzahl-Attribute
 * liegen als Bits im float, die übrigen als float. Ohne Aufkleber und Anhänger: undefined
 */
export function econOf(attrs: [number, number][] | undefined): { stickers?: Sticker3D[]; charm?: Charm3D } | undefined {
  if (!attrs) return
  const a = new Map(attrs), f = (d: number) => (a.has(d) ? asFloat(a.get(d)!) : undefined)
  const stickers: Sticker3D[] = []
  for (let s = 0; s < 6; s++) {
    const id = a.get(113 + 4 * s)
    if (!id) continue
    const st: Sticker3D = { slot: s, id, wear: f(114 + 4 * s), scale: f(115 + 4 * s), rot: f(116 + 4 * s), x: f(278 + 2 * s), y: f(279 + 2 * s), schema: a.get(290 + s) }
    for (const k of Object.keys(st) as (keyof Sticker3D)[]) if (st[k] === undefined) delete st[k]
    stickers.push(st)
  }
  const id = a.get(299)
  const charm: Charm3D | undefined = id ? { id, x: f(300), y: f(301), z: f(302), seed: a.get(306), highlight: a.get(314), sticker: a.get(321) } : undefined
  if (charm) for (const k of Object.keys(charm) as (keyof Charm3D)[]) if (charm[k] === undefined) delete charm[k]
  return stickers.length || charm ? { ...(stickers.length && { stickers }), ...(charm && { charm }) } : undefined
}

export function econAttributes(buf: Uint8Array, unsnappy: (b: Uint8Array) => Uint8Array): EconAttrs {
  const out: EconAttrs = new Map(), base = new Map<number, Uint8Array>()
  let sers: Map<string, Ser> | undefined, classes: (Ser | undefined)[] = [], clsBits = 0, bad: unknown
  let pos = 16
  const vi = () => { let r = 0, s = 0, x; do { x = buf[pos++]; r += (x & 127) * 2 ** s; s += 7 } while (x & 128); return r }
  while (pos < buf.length) {
    let cmd = vi(); vi(); const size = vi()
    const comp = (cmd & 64) !== 0; cmd &= ~64
    const at = pos; pos += size
    if (cmd === 0) break
    if (cmd !== 4 && cmd !== 5 && cmd !== 6 && cmd !== 13) continue
    const data = comp ? unsnappy(buf.subarray(at, at + size)) : buf.subarray(at, at + size)
    if (cmd === 4) sers = serializers(u8(proto(data)[1]?.[0]))
    else if (cmd === 5 && sers) {
      const cl = (proto(data)[1] ?? []).map(c => proto(u8(c)))
      classes = new Array(cl.length + 1)
      clsBits = Math.ceil(Math.log2(cl.length + 1))
      for (const c of cl) { const name = str(c[2]?.[0]); classes[num(c[1]?.[0])] = sers.get(name); sers.delete(name) }
    } else if (cmd === 6) baselines(data, base)
    else if (cmd === 13 && clsBits) {
      const fp = proto(data)
      baselines(u8(fp[1]?.[0]), base)
      // kaputtes/unbekanntes Paket (neues Feld nach CS2-Update) → nur dieses fehlt
      try { fullPacket(u8(proto(u8(fp[2]?.[0]))[3]?.[0]), classes, clsBits, base, out) } catch (e) { bad = e }
    }
  }
  if (bad && !out.size) throw bad
  if (bad) console.warn('econ: FullPacket übersprungen:', bad)
  return out
}

/** CDemoStringTables → instancebaseline (Klassen-ID → Bytes). FullPackets enthalten die Tabelle nur, wenn sie sich geändert hat → Stand behalten */
function baselines(data: Uint8Array, base: Map<number, Uint8Array>) {
  for (const t of proto(data)[1] ?? []) {
    const tm = proto(u8(t))
    if (str(tm[1]?.[0]) === 'instancebaseline') for (const it of tm[2] ?? []) { const im = proto(u8(it)); base.set(+str(im[1]?.[0]), u8(im[2]?.[0])) }
  }
}

function fullPacket(pkt: Uint8Array, classes: (Ser | undefined)[], clsBits: number, base: Map<number, Uint8Array>, out: EconAttrs) {
  const r = new Bits(pkt)
  while (r.left() > 8) {
    const type = r.ubv(), len = r.varint()
    if (len * 8 > r.left()) break
    if (type !== 55) { r.skip(8 * len); continue } // svc_PacketEntities
    const m = proto(r.bytes(len))
    entities(new Bits(u8(m[7]?.[0])), num(m[2]?.[0]), num(m[16]?.[0]), classes, clsBits, base, out)
  }
}

function entities(r: Bits, n: number, pvs: number, classes: (Ser | undefined)[], clsBits: number, base: Map<number, Uint8Array>, out: EconAttrs) {
  const ents = new Map<number, Ent>()
  let id = -1
  for (let k = 0; k < n; k++) {
    id += 1 + r.ubv()
    const cmd = r.read(2)
    if (cmd & 1) { ents.delete(id); continue }
    let e = ents.get(id)
    if (cmd === 2) {
      const cls = r.read(clsBits); r.skip(17); r.varint()
      const ser = classes[cls]
      if (!ser) throw new Error(`econ: Klasse ${cls} fehlt`)
      e = { cls, def: 0, lo: 0, hi: 0, att: [{ len: 0, def: [], raw: [] }, { len: 0, def: [], raw: [] }] }
      const bl = base.get(cls)
      if (bl) decode(new Bits(bl), ser, e)
      ents.set(id, e)
    } else if (pvs && r.read(2) & 1) continue
    if (!e) throw new Error('econ: Update ohne Entity')
    decode(r, classes[e.cls]!, e)
  }
  for (const e of ents.values()) {
    if (!(e.lo || e.hi)) continue
    const list: [number, number][] = []
    for (const L of e.att) for (let i = 0; i < L.len; i++) if (L.def[i] !== undefined) list.push([L.def[i], L.raw[i] ?? 0])
    if (list.length) out.set(`${e.hi >>> 0}:${e.lo >>> 0}`, list.sort((a, b) => a[0] - b[0]))
  }
}
